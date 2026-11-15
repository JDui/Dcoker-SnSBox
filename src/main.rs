mod adapters;
mod config;
mod model;
mod remote_media;
mod store;

use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use config::{AccountConfig, Config};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Row, SqlitePool};
use std::{
    collections::HashMap,
    convert::Infallible,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

struct Session {
    csrf: String,
    expires: Instant,
}
pub struct App {
    config: Config,
    db: SqlitePool,
    http: reqwest::Client,
    stream_http: reqwest::Client,
    password_hash: String,
    sessions: Mutex<HashMap<String, Session>>,
    login_attempts: Mutex<Vec<Instant>>,
    account_status: RwLock<HashMap<String, (String, String)>>,
    sync_locks: HashMap<String, Mutex<()>>,
    send_lock: Mutex<()>,
    media_lock: Mutex<()>,
}
#[derive(Debug)]
struct ApiError(StatusCode, &'static str, String);
impl ApiError {
    fn bad(message: &str) -> Self {
        Self(StatusCode::BAD_REQUEST, "invalid_request", message.into())
    }
    fn unsupported(message: &str) -> Self {
        Self(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unsupported",
            message.into(),
        )
    }
    fn missing() -> Self {
        Self(
            StatusCode::NOT_FOUND,
            "not_found",
            "找不到所请求的资源".into(),
        )
    }
}
impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(_: E) -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "服务端处理失败；原始资料未改写".into(),
        )
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(json!({"error":{"code":self.1,"message":self.2}})),
        )
            .into_response()
    }
}
type ApiResult<T> = Result<T, ApiError>;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "snsbox=info".into()),
        )
        .init();
    let config = Config::load()?;
    tokio::fs::create_dir_all(config.data.join("media")).await?;
    let db = store::open(&config.data.join("snsbox.sqlite3")).await?;
    let salt = SaltString::encode_b64(Uuid::new_v4().as_bytes())
        .map_err(|_| anyhow::anyhow!("salt creation failed"))?;
    let password_hash = Argon2::default()
        .hash_password(config.password.as_bytes(), &salt)
        .map_err(|_| anyhow::anyhow!("credential preparation failed"))?
        .to_string();
    let sync_locks = config
        .accounts
        .iter()
        .map(|a| (a.id.clone(), Mutex::new(())))
        .collect();
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()?;
    let stream_http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .build()?;
    let app = Arc::new(App {
        config,
        db,
        http,
        stream_http,
        password_hash,
        sync_locks,
        sessions: Mutex::new(HashMap::new()),
        login_attempts: Mutex::new(vec![]),
        account_status: RwLock::new(HashMap::new()),
        send_lock: Mutex::new(()),
        media_lock: Mutex::new(()),
    });
    let protected = Router::new()
        .route("/session", get(session).delete(logout))
        .route("/accounts", get(accounts))
        .route("/accounts/{id}", get(account))
        .route("/accounts/{id}/login", post(account_login))
        .route("/accounts/{id}/logout", post(account_logout))
        .route("/accounts/{id}/sync", post(account_sync))
        .route("/conversations", get(conversations))
        .route(
            "/conversations/{id}/messages",
            get(messages).post(send_message),
        )
        .route("/conversations/{id}/read", post(mark_read))
        .route("/messages", get(search_messages))
        .route("/media", post(upload))
        .route("/media/{id}", get(media))
        .route("/events", get(events))
        .route("/system", get(system))
        .route_layer(middleware::from_fn_with_state(app.clone(), authenticate));
    let api = protected
        .route("/session", post(login))
        .fallback(|| async { ApiError::missing() });
    let web = app.config.web.clone();
    let router = Router::new()
        .route("/health", get(|| async { Json(json!({"status":"ok"})) }))
        .nest("/api/v1", api)
        .fallback_service(
            tower_http::services::ServeDir::new(&web)
                .not_found_service(tower_http::services::ServeFile::new(web.join("index.html"))),
        )
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .layer(middleware::from_fn(security_headers))
        .with_state(app.clone());
    adapters::start(app.clone());
    let listener = tokio::net::TcpListener::bind(&app.config.listen).await?;
    tracing::info!(listen=%app.config.listen,"SnSBox ready; account readiness is separate from health");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    app.db.close().await;
    Ok(())
}
async fn security_headers(req: Request, next: Next) -> Response {
    let api = req.uri().path().starts_with("/api/");
    let mut response = next.run(req).await;
    let h = response.headers_mut();
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    h.insert("content-security-policy",HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"));
    if api {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}
fn cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .map(str::trim)
        .find_map(|c| c.strip_prefix("snsbox_session="))
        .map(str::to_owned)
}
fn check_origin(app: &App, headers: &HeaderMap) -> ApiResult<()> {
    if let Some(origin) = headers.get(header::ORIGIN) {
        if origin.to_str().ok() != Some(app.config.origin.as_str()) {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "origin_rejected",
                "请求来源与 SNSBOX_PUBLIC_ORIGIN 不一致".into(),
            ));
        }
    }
    if headers
        .get("sec-fetch-site")
        .is_some_and(|h| h == "cross-site")
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "origin_rejected",
            "拒绝跨站请求".into(),
        ));
    }
    Ok(())
}
async fn authenticate(State(app): State<Arc<App>>, req: Request, next: Next) -> Response {
    let headers = req.headers().clone();
    let method = req.method().clone();
    let result: ApiResult<()> = async {
        check_origin(&app, &headers)?;
        let key = cookie(&headers).ok_or(ApiError(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "请先登录 SnSBox".into(),
        ))?;
        let sessions = app.sessions.lock().await;
        let session = sessions
            .get(&key)
            .filter(|s| s.expires > Instant::now())
            .ok_or(ApiError(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "会话已过期，请重新登录".into(),
            ))?;
        if !matches!(method, Method::GET | Method::HEAD)
            && headers.get("x-csrf-token").and_then(|h| h.to_str().ok())
                != Some(session.csrf.as_str())
        {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "csrf_rejected",
                "请求缺少有效 CSRF 令牌".into(),
            ));
        }
        Ok(())
    }
    .await;
    match result {
        Ok(()) => next.run(req).await,
        Err(e) => e.into_response(),
    }
}
#[derive(Deserialize)]
struct Login {
    password: String,
}
async fn login(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(body): Json<Login>,
) -> ApiResult<Response> {
    check_origin(&app, &headers)?;
    if body.password.len() > 1024 {
        return Err(ApiError::bad("密码过长"));
    }
    {
        let mut attempts = app.login_attempts.lock().await;
        attempts.retain(|t| t.elapsed() < Duration::from_secs(60));
        if attempts.len() >= 10 {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "登录尝试过多，请一分钟后重试".into(),
            ));
        }
        attempts.push(Instant::now());
    }
    let hash = app.password_hash.clone();
    let valid = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash).is_ok_and(|h| {
            Argon2::default()
                .verify_password(body.password.as_bytes(), &h)
                .is_ok()
        })
    })
    .await?;
    if !valid {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "管理员密码不正确".into(),
        ));
    }
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let csrf = Uuid::new_v4().to_string();
    let mut sessions = app.sessions.lock().await;
    sessions.retain(|_, s| s.expires > Instant::now());
    if sessions.len() >= 32 {
        sessions.clear();
    }
    if let Some(old) = cookie(&headers) {
        sessions.remove(&old);
    }
    sessions.insert(
        token.clone(),
        Session {
            csrf: csrf.clone(),
            expires: Instant::now() + Duration::from_secs(12 * 3600),
        },
    );
    let secure = if app.config.origin.starts_with("https://") {
        "; Secure"
    } else {
        ""
    };
    Ok((
        [(
            header::SET_COOKIE,
            format!(
                "snsbox_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200{secure}"
            ),
        )],
        Json(json!({"authenticated":true,"csrfToken":csrf})),
    )
        .into_response())
}
async fn session(State(app): State<Arc<App>>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let sessions = app.sessions.lock().await;
    let s = sessions
        .get(&cookie(&headers).unwrap_or_default())
        .ok_or(ApiError::missing())?;
    Ok(Json(json!({"authenticated":true,"csrfToken":s.csrf})))
}
async fn logout(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if let Some(key) = cookie(&headers) {
        app.sessions.lock().await.remove(&key);
    }
    (
        [(
            header::SET_COOKIE,
            "snsbox_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
        )],
        Json(json!({"authenticated":false})),
    )
        .into_response()
}
fn find_account<'a>(app: &'a App, id: &str) -> ApiResult<&'a AccountConfig> {
    app.config
        .accounts
        .iter()
        .find(|a| a.id == id)
        .ok_or_else(ApiError::missing)
}
async fn account_value(app: &App, a: &AccountConfig) -> Value {
    let default = if a.configured() {
        (
            "connecting".into(),
            "正在连接已配置上游；真实账号未验收".into(),
        )
    } else {
        (
            "unconfigured".into(),
            "尚未配置上游接口，请在服务端配置账号".into(),
        )
    };
    let (status, message) = app
        .account_status
        .read()
        .await
        .get(&a.id)
        .cloned()
        .unwrap_or(default);
    json!({"id":a.id,"platform":a.platform,"displayName":a.display_name,"status":status,"statusMessage":message,"adapter":a.adapter(),"upstreamConfigured":a.configured(),"capabilities":model::capabilities(&a.platform,a.configured()),"historyScope":if a.platform=="qq"{"SnSBox 接收的事件和最近群历史；QQ 私聊初始历史与断线期间完整补齐未实现"}else{"已同步上游资料中的最近历史与事件；不保证所有设备的完整记录"},"mailUrl":if a.platform=="qq"{Some("https://mail.qq.com/")}else{None}})
}
async fn accounts(State(app): State<Arc<App>>) -> Json<Value> {
    let mut items = vec![];
    for a in &app.config.accounts {
        items.push(account_value(&app, a).await);
    }
    Json(json!({"items":items,"nextCursor":null}))
}
async fn account(State(app): State<Arc<App>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(account_value(&app, find_account(&app, &id)?).await))
}
async fn account_login(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let a = find_account(&app, &id)?;
    if !a.configured() {
        return Ok(Json(
            json!({"state":"blocked","message":"请先在服务端配置上游；没有执行登录","loginUrl":null,"qrCode":null}),
        ));
    }
    if a.platform == "qq" {
        return Ok(Json(
            json!({"state":"blocked","message":"Milky 不提供登录管理 API，请在独立 Lagrange 上游完成扫码登录；未修改官方 QQ 令牌","loginUrl":null,"qrCode":null}),
        ));
    }
    let operation = adapters::wx(
        &app,
        a,
        &["login-attempts"],
        Some(json!({"allowQr":false})),
        Some(&Uuid::new_v4().to_string()),
    )
    .await
    .map_err(|_| {
        ApiError(
            StatusCode::BAD_GATEWAY,
            "upstream_error",
            "上游未能创建登录任务；请检查账号与资料配置".into(),
        )
    })?;
    Ok(Json(
        json!({"state":"pending","message":"已请求上游尝试保存的登录态，请查看上游管理界面完成确认；需要扫码时在上游操作","operationId":operation["id"],"loginUrl":null,"qrCode":null}),
    ))
}
async fn account_logout(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let a = find_account(&app, &id)?;
    if !a.configured() {
        return Err(ApiError::unsupported("账号尚未配置"));
    }
    if a.platform == "qq" {
        return Err(ApiError::unsupported(
            "Milky 没有远程注销 API，请在 QQ 上游管理；记录和令牌未删除",
        ));
    }
    let operation = adapters::wx(
        &app,
        a,
        &["logout"],
        Some(json!({})),
        Some(&Uuid::new_v4().to_string()),
    )
    .await
    .map_err(|_| {
        ApiError(
            StatusCode::BAD_GATEWAY,
            "upstream_error",
            "上游注销未获可靠结果，请检查上游状态".into(),
        )
    })?;
    app.account_status.write().await.insert(
        id,
        (
            "connecting".into(),
            "已请求注销，等待上游确认；历史保留".into(),
        ),
    );
    Ok(Json(
        json!({"state":"pending","message":"注销任务已提交，不删除本地历史或配置","operationId":operation["id"],"loginUrl":null,"qrCode":null}),
    ))
}
async fn account_sync(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let a = find_account(&app, &id)?;
    adapters::sync(&app, a).await.map_err(|_| {
        ApiError(
            StatusCode::BAD_GATEWAY,
            "upstream_error",
            "同步失败；请核对上游接口、账号与历史支持范围".into(),
        )
    })?;
    Ok(Json(
        json!({"synced":true,"message":"本次可用上游会话与最近历史已同步，不代表完整历史"}),
    ))
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    account_id: Option<String>,
    query: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
    after: Option<i64>,
}
fn paging(p: &Page) -> ApiResult<(i64, Option<(String, String)>)> {
    if p.query.as_deref().unwrap_or("").len() > 1024 {
        return Err(ApiError::bad("搜索文字过长"));
    }
    let cursor = p
        .cursor
        .as_ref()
        .map(|s| -> ApiResult<(String, String)> {
            if s.len() > 4096 {
                return Err(ApiError::bad("游标无效"));
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(s)
                .map_err(|_| ApiError::bad("游标无效"))?;
            serde_json::from_slice(&bytes).map_err(|_| ApiError::bad("游标无效"))
        })
        .transpose()?;
    Ok((p.limit.unwrap_or(50).clamp(1, 200), cursor))
}
fn page_result(mut rows: Vec<Value>, limit: i64, time_field: &str) -> Value {
    let more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next = if more {
        rows.last().map(|r| {
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&(
                    r[time_field].as_str().unwrap_or(""),
                    r["id"].as_str().unwrap_or(""),
                ))
                .unwrap(),
            )
        })
    } else {
        None
    };
    json!({"items":rows,"nextCursor":next})
}
async fn conversations(
    State(app): State<Arc<App>>,
    Query(p): Query<Page>,
) -> ApiResult<Json<Value>> {
    let (limit, cursor) = paging(&p)?;
    let (time, id) = cursor.clone().unwrap_or_default();
    let rows:Vec<String>=sqlx::query_scalar("SELECT body FROM conversations WHERE (? IS NULL OR account_id=?) AND (?='' OR instr(lower(title),lower(?))>0) AND (?=0 OR COALESCE(last_at,'')<? OR (COALESCE(last_at,'')=? AND id<?)) ORDER BY COALESCE(last_at,'') DESC,id DESC LIMIT ?")
        .bind(&p.account_id).bind(&p.account_id).bind(p.query.as_deref().unwrap_or("")).bind(p.query.as_deref().unwrap_or("")).bind(i64::from(cursor.is_some())).bind(&time).bind(&time).bind(id).bind(limit+1).fetch_all(&app.db).await?;
    Ok(Json(page_result(
        rows.into_iter()
            .map(|s| serde_json::from_str(&s))
            .collect::<Result<_, _>>()?,
        limit,
        "lastMessageAt",
    )))
}
async fn message_page(app: &App, conversation: Option<&str>, p: Page) -> ApiResult<Json<Value>> {
    let (limit, cursor) = paging(&p)?;
    let (time, id) = cursor.clone().unwrap_or_default();
    let rows:Vec<String>=sqlx::query_scalar("SELECT body FROM messages WHERE (? IS NULL OR conversation_id=?) AND (? IS NULL OR account_id=?) AND (?='' OR instr(lower(search_text),lower(?))>0) AND (?=0 OR timestamp<? OR (timestamp=? AND id<?)) ORDER BY timestamp DESC,id DESC LIMIT ?")
        .bind(conversation).bind(conversation).bind(&p.account_id).bind(&p.account_id).bind(p.query.as_deref().unwrap_or("")).bind(p.query.as_deref().unwrap_or("")).bind(i64::from(cursor.is_some())).bind(&time).bind(&time).bind(id).bind(limit+1).fetch_all(&app.db).await?;
    Ok(Json(page_result(
        rows.into_iter()
            .map(|s| serde_json::from_str(&s))
            .collect::<Result<_, _>>()?,
        limit,
        "timestamp",
    )))
}
async fn messages(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    Query(p): Query<Page>,
) -> ApiResult<Json<Value>> {
    if store::body(&app.db, "conversations", &id).await?.is_none() {
        return Err(ApiError::missing());
    }
    message_page(&app, Some(&id), p).await
}
async fn search_messages(
    State(app): State<Arc<App>>,
    Query(p): Query<Page>,
) -> ApiResult<Json<Value>> {
    message_page(&app, None, p).await
}
async fn mark_read(State(app): State<Arc<App>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let c = store::body(&app.db, "conversations", &id)
        .await?
        .ok_or_else(ApiError::missing)?;
    let mut tx = app.db.begin().await?;
    sqlx::query("UPDATE conversations SET body=json_set(body,'$.unreadCount',0) WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    store::event_tx(
        &mut tx,
        "conversation",
        c["accountId"].as_str().unwrap(),
        Some(&id),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"read":true,"scope":"local"})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Send {
    segments: Vec<Value>,
}
async fn send_message(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Send>,
) -> ApiResult<Response> {
    let key = headers
        .get("idempotency-key")
        .and_then(|x| x.to_str().ok())
        .filter(|s| !s.is_empty() && s.len() <= 200 && s.is_ascii())
        .ok_or_else(|| ApiError::bad("发送必须携带有效 Idempotency-Key"))?
        .to_string();
    let c = store::body(&app.db, "conversations", &id)
        .await?
        .ok_or_else(ApiError::missing)?;
    let a = find_account(&app, c["accountId"].as_str().unwrap())?.clone();
    let request = json!({"conversationId":id,"segments":body.segments}).to_string();
    let _guard = app.send_lock.lock().await;
    if let Some(row) = sqlx::query(
        "SELECT o.request,m.body FROM outbox o JOIN messages m ON m.id=o.message_id WHERE o.key=?",
    )
    .bind(&key)
    .fetch_optional(&app.db)
    .await?
    {
        if row.get::<String, _>("request") != request {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "idempotency_conflict",
                "相同幂等键不能用于不同请求".into(),
            ));
        }
        return Ok((
            StatusCode::ACCEPTED,
            Json(serde_json::from_str::<Value>(row.get("body"))?),
        )
            .into_response());
    }
    if !a.configured() {
        return Err(ApiError::unsupported("尚未配置上游，消息未提交"));
    }
    if body.segments.is_empty() || body.segments.len() > 32 {
        return Err(ApiError::bad("消息段数量无效"));
    }
    let only_text = body.segments.iter().all(|s| s["type"] == "text");
    let mut normalized = vec![];
    if only_text {
        let mut size = 0;
        for segment in &body.segments {
            let text = segment["text"]
                .as_str()
                .ok_or_else(|| ApiError::bad("文字段缺少 text"))?;
            size += text.len();
            normalized.push(json!({"type":"text","text":text}));
        }
        if size == 0 || size > 16384 {
            return Err(ApiError::bad("文字长度须在 1 到 16384 字节之间"));
        }
    } else {
        if body.segments.len() != 1 {
            return Err(ApiError::unsupported("当前附件每次发送一项"));
        }
        let s = &body.segments[0];
        let kind = s["type"].as_str().unwrap_or("");
        if !matches!(kind, "image" | "video" | "file") || (a.platform == "qq" && kind == "file") {
            return Err(ApiError::unsupported("当前平台未开放该消息类型发送"));
        }
        let media_id = s["mediaId"]
            .as_str()
            .ok_or_else(|| ApiError::bad("附件须先上传并使用 mediaId"))?;
        let row = sqlx::query("SELECT mime,name FROM media WHERE id=? AND account_id=?")
            .bind(media_id)
            .bind(&a.id)
            .fetch_optional(&app.db)
            .await?
            .ok_or_else(ApiError::missing)?;
        let mime: String = row.get("mime");
        if (kind == "image" && !mime.starts_with("image/"))
            || (kind == "video" && !mime.starts_with("video/"))
        {
            return Err(ApiError::bad("附件类型与消息类型不一致"));
        }
        normalized.push(json!({"type":kind,"mediaId":media_id,"url":format!("/api/v1/media/{media_id}"),"name":row.get::<String,_>("name"),"mimeType":mime}));
    }
    let message = json!({"id":format!("out-{}",Uuid::new_v4()),"conversationId":id,"accountId":a.id,"platform":a.platform,"upstreamId":null,"senderId":"self","senderName":"我","direction":"outgoing","timestamp":model::now(),"segments":normalized,"status":"queued","error":null});
    let mut tx = app.db.begin().await?;
    sqlx::query("INSERT INTO messages(id,conversation_id,account_id,timestamp,status,search_text,body) VALUES(?,?,?,?,?,?,?)").bind(message["id"].as_str()).bind(&id).bind(&a.id).bind(message["timestamp"].as_str()).bind("queued").bind(model::search_text(&message["segments"])).bind(message.to_string()).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO outbox(key,request,message_id) VALUES(?,?,?)")
        .bind(&key)
        .bind(request)
        .bind(message["id"].as_str())
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE conversations SET last_at=?,body=json_set(body,'$.lastMessage',?,'$.lastMessageAt',?) WHERE id=?").bind(message["timestamp"].as_str()).bind(model::preview(&message["segments"])).bind(message["timestamp"].as_str()).bind(&id).execute(&mut *tx).await?;
    store::event_tx(&mut tx, "message", &a.id, Some(&id)).await?;
    tx.commit().await?;
    tokio::spawn(adapters::submit(app.clone(), a, c, message.clone(), key));
    Ok((StatusCode::ACCEPTED, Json(message)).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Upload {
    account_id: String,
    name: String,
}
fn media_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        "video/mp4"
    } else if bytes.starts_with(b"\x1a\x45\xdf\xa3") {
        "video/webm"
    } else {
        "application/octet-stream"
    }
}
async fn upload(
    State(app): State<Arc<App>>,
    Query(p): Query<Upload>,
    bytes: Bytes,
) -> ApiResult<Json<Value>> {
    find_account(&app, &p.account_id)?;
    if p.name.is_empty()
        || p.name.len() > 255
        || p.name.contains(['\r', '\n', '/', '\\', '\0'])
        || p.name.chars().any(char::is_control)
    {
        return Err(ApiError::bad("附件文件名无效"));
    }
    if bytes.is_empty() {
        return Err(ApiError::bad("不能上传空附件"));
    }
    let _guard = app.media_lock.lock().await;
    let used: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(size),0) FROM media")
        .fetch_one(&app.db)
        .await?;
    if used as u64 + bytes.len() as u64 > app.config.media_limit {
        return Err(ApiError(
            StatusCode::INSUFFICIENT_STORAGE,
            "quota_exceeded",
            "SnSBox 附件配额已满，未删除任何源文件".into(),
        ));
    }
    let id = Uuid::new_v4().to_string();
    let mime = media_mime(&bytes);
    let path = app.config.data.join("media").join(&id);
    tokio::fs::write(&path, &bytes).await?;
    if let Err(e) = sqlx::query(
        "INSERT INTO media(id,account_id,name,mime,size,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(&p.account_id)
    .bind(&p.name)
    .bind(mime)
    .bind(bytes.len() as i64)
    .bind(model::now())
    .execute(&app.db)
    .await
    {
        let _ = tokio::fs::remove_file(path).await;
        return Err(e.into());
    }
    Ok(Json(
        json!({"id":id,"url":format!("/api/v1/media/{id}"),"name":p.name,"mimeType":mime,"size":bytes.len()}),
    ))
}
async fn media(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    if Uuid::parse_str(&id).is_err() {
        return Err(ApiError::missing());
    }
    remote_media::cache(&app, &id).await?;
    let row = sqlx::query("SELECT account_id,name,mime,size FROM media WHERE id=?")
        .bind(&id)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(ApiError::missing)?;
    find_account(&app, row.get("account_id"))?;
    let path = app.config.data.join("media").join(&id).canonicalize()?;
    let root = app.config.data.join("media").canonicalize()?;
    if !path.starts_with(root) {
        return Err(ApiError::missing());
    }
    let bytes = tokio::fs::read(path).await?;
    let length = bytes.len();
    let mime: String = row.get("mime");
    let mut start = 0;
    let mut end = length.saturating_sub(1);
    let mut status = StatusCode::OK;
    if let Some(range) = headers.get(header::RANGE) {
        let r = range
            .to_str()
            .ok()
            .and_then(|s| s.strip_prefix("bytes="))
            .and_then(|s| s.split_once('-'))
            .ok_or_else(|| ApiError::bad("不支持该 Range 请求"))?;
        if r.0.is_empty() {
            let suffix: usize = r.1.parse().map_err(|_| ApiError::bad("无效 Range"))?;
            if suffix == 0 {
                return Err(ApiError::bad("无效 Range"));
            }
            start = length.saturating_sub(suffix);
        } else {
            start = r.0.parse().map_err(|_| ApiError::bad("无效 Range"))?;
            if !r.1.is_empty() {
                end =
                    r.1.parse::<usize>()
                        .map_err(|_| ApiError::bad("无效 Range"))?
                        .min(end);
            }
        }
        if start >= length || start > end {
            return Ok((
                StatusCode::RANGE_NOT_SATISFIABLE,
                [(header::CONTENT_RANGE, format!("bytes */{length}"))],
            )
                .into_response());
        }
        status = StatusCode::PARTIAL_CONTENT;
    }
    let mut response = Response::new(Body::from(bytes[start..=end].to_vec()));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_str(&mime)?);
    response
        .headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if status == StatusCode::PARTIAL_CONTENT {
        response.headers_mut().insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{length}"))?,
        );
    }
    if mime == "application/octet-stream" {
        response.headers_mut().insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_static("attachment"),
        );
    }
    Ok(response)
}
async fn events(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Query(p): Query<Page>,
) -> ApiResult<Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>> {
    let mut after = headers
        .get("last-event-id")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse().ok())
        .or(p.after)
        .unwrap_or(0)
        .max(0);
    let key = cookie(&headers).unwrap_or_default();
    let stream = async_stream::stream! {
        loop {
            if !app.sessions.lock().await.get(&key).is_some_and(|s|s.expires>Instant::now()){break;}
            let rows=match sqlx::query("SELECT id,body FROM events WHERE id>? ORDER BY id LIMIT 100").bind(after).fetch_all(&app.db).await{Ok(rows)=>rows,Err(_)=>break};
            let full=rows.len()==100;
            for row in rows {after=row.get("id");yield Ok(Event::default().event("update").id(after.to_string()).data(row.get::<String,_>("body")));}
            if !full{tokio::time::sleep(Duration::from_secs(1)).await;}
        }
    };
    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    ))
}
async fn system(State(app): State<Arc<App>>) -> Json<Value> {
    let entries:Vec<_>=[(".xwechat","微信登录与路由资料"),("xwechat_files","微信历史与附件资料"),(".config/QQ","官方 QQ NT 资料；独立协议令牌不可互换"),(".system-identity","旧容器机器身份资料")].into_iter().map(|(path,purpose)|json!({"path":path,"present":app.config.legacy.as_ref().is_some_and(|p|p.join(path).exists()),"purpose":purpose})).collect();
    Json(
        json!({"version":env!("CARGO_PKG_VERSION"),"dataPolicy":"SnSBox 自有 SQLite 与附件独立存放；未实现静态加密。外部目录只检查存在性，不读取令牌、不自动解密或导入历史。","legacyConfig":{"configured":app.config.legacy.is_some(),"readOnly":true,"entries":entries,"message":"目录存在不等于接口或数据兼容；官方目录必须只有一个写入方"}}),
    )
}
