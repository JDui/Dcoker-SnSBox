use crate::{ApiError, ApiResult, App, adapters, find_account, model, store};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoginRequest {
    strategy: Option<String>,
    allow_qr: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provision {
    confirm_isolated: bool,
}

pub async fn provision(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    Json(p): Json<Provision>,
) -> ApiResult<Json<Value>> {
    if !p.confirm_isolated {
        return Err(ApiError::bad("必须确认创建独立上游账号；不会接管旧 config"));
    }
    let a = find_account(&app, &id)?;
    if a.platform != "wechat" || !a.configured() {
        return Err(ApiError::unsupported(
            "仅对已配置的微信 native 上游创建独立账号",
        ));
    }
    // Creation takes no filesystem path. Upstream creates its own managed record.
    let _guard = app.sync_locks.get(&id).unwrap().lock().await;
    let existing = app
        .http
        .get(a.wx_url(&[])?)
        .bearer_auth(&a.token)
        .send()
        .await?;
    if existing.status().is_success() {
        return Ok(Json(
            json!({"created":false,"accountId":id,"message":"该上游账号已存在，未覆盖或改写源资料"}),
        ));
    }
    if existing.status() != StatusCode::NOT_FOUND {
        return Err(ApiError(
            StatusCode::BAD_GATEWAY,
            "provision_preflight_failed",
            "无法确认上游账号不存在；未发起创建".into(),
        ));
    }
    let response = app
        .http
        .post(a.url(&["v1", "accounts"])?)
        .bearer_auth(&a.token)
        .json(&json!({"id":a.upstream_account_id}))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(ApiError(
            StatusCode::BAD_GATEWAY,
            "provision_failed",
            "上游未创建账号，请检查权限和账号 ID；未修改旧 config".into(),
        ));
    }
    let value = adapters::response(response).await?;
    if value["id"] != json!(a.upstream_account_id) {
        return Err(ApiError::unsupported("上游创建结果与配置账号不匹配"));
    }
    Ok(Json(
        json!({"created":true,"accountId":id,"message":"独立 managed 账号已创建；尚未登录，未导入官方资料"}),
    ))
}
pub async fn login(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(p): Json<LoginRequest>,
) -> ApiResult<Json<Value>> {
    let strategy = p.strategy.unwrap_or_else(|| "auto".into());
    if !matches!(strategy.as_str(), "auto" | "saved-device" | "qr") {
        return Err(ApiError::bad("未知登录策略"));
    }
    start(app,id,headers,"login",json!({"strategy":strategy,"allowQr":p.allow_qr.unwrap_or(true),"qrRefresh":{"mode":"manual"},"timeoutSeconds":300})).await
}
pub async fn logout(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    start(app, id, headers, "logout", json!({})).await
}
async fn start(
    app: Arc<App>,
    id: String,
    headers: HeaderMap,
    kind: &str,
    request: Value,
) -> ApiResult<Json<Value>> {
    let a = find_account(&app, &id)?;
    if !a.configured() {
        return Ok(Json(
            json!({"state":"blocked","message":"请先配置上游服务；没有执行账号操作","operationId":null,"qrCode":null,"loginUrl":null}),
        ));
    }
    if a.platform != "wechat" && a.management_url.is_none() {
        return Ok(Json(
            json!({"state":"blocked","message":"当前 Milky 上游没有登录管理接口；请使用已配置的独立 QQ 登录管理服务，未操作官方 QQ 资料","operationId":null,"qrCode":null,"loginUrl":null}),
        ));
    }
    let key = headers
        .get("idempotency-key")
        .map(|v| v.to_str())
        .transpose()
        .map_err(|_| ApiError::bad("幂等键无效"))?
        .unwrap_or("")
        .to_string();
    let key = if key.is_empty() {
        Uuid::new_v4().to_string()
    } else {
        key
    };
    if key.len() > 200 || !key.is_ascii() {
        return Err(ApiError::bad("幂等键无效"));
    }
    let request_json = json!({"accountId":id,"kind":kind,"request":request}).to_string();
    let op_id = Uuid::new_v4().to_string();
    let mut body = json!({"id":op_id,"operationId":op_id,"accountId":id,"kind":kind,"state":"uncertain","phase":"submitting","message":"账号操作提交中；未确认前不会自动重试","qrCode":null,"loginUrl":null,"createdAt":model::now()});
    {
        let _guard = app.send_lock.lock().await;
        if let Some(row) =
            sqlx::query("SELECT request,body FROM account_operations WHERE request_key=?")
                .bind(&key)
                .fetch_optional(&app.db)
                .await?
        {
            if row.get::<String, _>("request") != request_json {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "idempotency_conflict",
                    "相同幂等键不可用于不同账号操作".into(),
                ));
            }
            return Ok(Json(serde_json::from_str(row.get("body"))?));
        }
        sqlx::query("INSERT INTO account_operations(id,account_id,kind,request_key,request,body,created_at) VALUES(?,?,?,?,?,?,?)").bind(&op_id).bind(&id).bind(kind).bind(&key).bind(request_json).bind(body.to_string()).bind(body["createdAt"].as_str()).execute(&app.db).await?;
    }
    if a.platform == "qq" {
        sqlx::query("UPDATE account_operations SET upstream_id='llbot' WHERE id=?")
            .bind(&op_id)
            .execute(&app.db)
            .await?;
        if crate::llbot::start(&app, a, &mut body, &request)
            .await
            .is_err()
        {
            body["state"] = json!("uncertain");
            body["message"] =
                json!("LLBot 管理操作未确认；检查管理凭据、配置 UIN 和连接，未自动重试");
        }
        save(&app, &body).await?;
        return Ok(Json(body));
    }
    let route = if kind == "login" {
        "login-attempts"
    } else {
        "logout"
    };
    match adapters::wx(&app, a, &[route], Some(request), Some(&key)).await {
        Ok(remote) => {
            if let Some(remote_id) = remote["id"].as_str() {
                sqlx::query("UPDATE account_operations SET upstream_id=? WHERE id=?")
                    .bind(remote_id)
                    .bind(&op_id)
                    .execute(&app.db)
                    .await?;
                body = project(&id, &op_id, kind, &remote);
            }
        }
        Err(_) => {
            body["message"] = json!("上游未返回可靠任务结果；请核对上游，勿重复提交登录/注销");
        }
    }
    apply_status(&app, a, kind, &mut body).await;
    save(&app, &body).await?;
    Ok(Json(body))
}
fn project(account: &str, id: &str, kind: &str, remote: &Value) -> Value {
    let phase = remote["state"].as_str().unwrap_or("needs_review");
    let (state, message) = match phase {
        "succeeded" => (
            "accepted",
            if kind == "login" {
                "上游登录任务完成，正在核对账号连接"
            } else {
                "上游注销任务已完成；保留历史与本地配置"
            },
        ),
        "failed" | "cancelled" | "expired" | "rejected" | "needs_login" => (
            "blocked",
            "上游账号操作未完成或已取消/过期，请检查条件后重新操作",
        ),
        "needs_review" => ("uncertain", "上游操作结果待确认，不会自动重提"),
        "awaiting_scan" => ("pending", "请扫描二维码；扫码不等于登录已完成"),
        "awaiting_approval" => ("pending", "请在手机确认登录"),
        "queued" | "running" | "starting" | "resuming" | "authenticating" => {
            ("pending", "上游正在处理账号操作")
        }
        _ => ("uncertain", "上游返回未识别的任务阶段，请检查上游状态"),
    };
    let qr = if kind == "login"
        && matches!(phase, "awaiting_scan" | "awaiting_approval")
        && remote["result"]["qrAvailable"] == true
    {
        Some(format!("/api/v1/accounts/{account}/operations/{id}/qr"))
    } else {
        None
    };
    json!({"id":id,"operationId":id,"accountId":account,"kind":kind,"state":state,"phase":phase,"message":message,"qrCode":qr,"loginUrl":null,"expiresAt":timestamp(&remote["result"]["expiresAt"]),"qrGeneration":remote["result"]["qrGeneration"],"createdAt":timestamp(&remote["createdAt"])})
}
fn timestamp(value: &Value) -> Option<String> {
    let parsed = value
        .as_i64()
        .or_else(|| value.as_str()?.parse().ok())
        .and_then(|s| chrono::DateTime::from_timestamp(s, 0));
    parsed
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .or_else(|| {
            chrono::DateTime::parse_from_rfc3339(value.as_str()?)
                .ok()
                .map(|t| {
                    t.with_timezone(&chrono::Utc)
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                })
        })
}
async fn verify_login(app: &App, a: &crate::config::AccountConfig, body: &mut Value) {
    match adapters::wx(app, a, &[], None, None).await {
        Ok(status) if status["authenticated"] == true && status["connection"] == "online" => {
            body["message"] = json!("上游已确认登录并在线；消息投递仍须单独验证");
            app.account_status.write().await.insert(
                a.id.clone(),
                ("online".into(), "上游已确认登录并在线".into()),
            );
        }
        _ => {
            body["state"] = json!("uncertain");
            body["message"] = json!("登录任务结束，但账号在线状态尚未确认");
        }
    }
}
async fn apply_status(app: &App, a: &crate::config::AccountConfig, kind: &str, body: &mut Value) {
    if body["phase"] == "succeeded" {
        if kind == "login" {
            verify_login(app, a, body).await;
        } else {
            app.account_status
                .write()
                .await
                .insert(a.id.clone(), ("offline".into(), "上游注销任务完成".into()));
        }
    } else if body["state"] == "pending" || body["state"] == "uncertain" {
        app.account_status.write().await.insert(
            a.id.clone(),
            ("connecting".into(), "账号操作等待状态确认".into()),
        );
    }
}
async fn save(app: &App, body: &Value) -> ApiResult<()> {
    let mut tx = app.db.begin().await?;
    let encoded = body.to_string();
    let changed = sqlx::query("UPDATE account_operations SET body=? WHERE id=? AND body<>?")
        .bind(&encoded)
        .bind(body["id"].as_str())
        .bind(&encoded)
        .execute(&mut *tx)
        .await?
        .rows_affected()
        > 0;
    if changed {
        store::event_tx(
            &mut tx,
            "account",
            body["accountId"].as_str().unwrap(),
            None,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
async fn owned(app: &App, account: &str, id: &str) -> ApiResult<(String, String, Value)> {
    let row = sqlx::query(
        "SELECT upstream_id,kind,body FROM account_operations WHERE id=? AND account_id=?",
    )
    .bind(id)
    .bind(account)
    .fetch_optional(&app.db)
    .await?
    .ok_or_else(ApiError::missing)?;
    Ok((
        row.get::<Option<String>, _>("upstream_id")
            .unwrap_or_default(),
        row.get("kind"),
        serde_json::from_str(row.get("body"))?,
    ))
}
pub async fn get(
    State(app): State<Arc<App>>,
    Path((account, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let a = find_account(&app, &account)?;
    let (remote_id, kind, body) = owned(&app, &account, &id).await?;
    if remote_id.is_empty() {
        return Ok(Json(body));
    }
    if a.platform == "qq" {
        let mut body = body;
        crate::llbot::poll(&app, a, &mut body).await?;
        save(&app, &body).await?;
        return Ok(Json(body));
    }
    let remote = adapters::wx(&app, a, &["operations", &remote_id], None, None)
        .await
        .map_err(|_| {
            ApiError(
                StatusCode::BAD_GATEWAY,
                "operation_unavailable",
                "暂时无法读取上游任务状态；未重提操作".into(),
            )
        })?;
    let mut body = project(&account, &id, &kind, &remote);
    apply_status(&app, a, &kind, &mut body).await;
    save(&app, &body).await?;
    Ok(Json(body))
}
#[derive(Deserialize)]
pub struct QrQuery {
    generation: Option<u32>,
}
pub async fn qr(
    State(app): State<Arc<App>>,
    Path((account, id)): Path<(String, String)>,
    Query(query): Query<QrQuery>,
) -> ApiResult<Response> {
    let a = find_account(&app, &account)?;
    let (remote_id, kind, body) = owned(&app, &account, &id).await?;
    if kind != "login" || remote_id.is_empty() {
        return Err(ApiError::missing());
    }
    if a.platform == "qq" {
        if !matches!(
            body["phase"].as_str(),
            Some("awaiting_scan" | "awaiting_approval")
        ) {
            return Err(ApiError::unsupported("登录任务当前不接受扫码"));
        }
        let bytes = crate::llbot::qr(&app, a, &id, query.generation).await?;
        return Ok((
            [
                (header::CONTENT_TYPE, "image/png"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            bytes,
        )
            .into_response());
    }
    let status = adapters::wx(&app, a, &["operations", &remote_id], None, None).await?;
    if !matches!(
        status["state"].as_str(),
        Some("awaiting_scan" | "awaiting_approval")
    ) {
        return Err(ApiError::unsupported("登录任务当前不接受扫码"));
    }
    let mut url = a.wx_url(&["login-attempts", &remote_id, "qr"])?;
    if let Some(generation) = query.generation {
        url.query_pairs_mut()
            .append_pair("generation", &generation.to_string());
    }
    let response = app.http.get(url).bearer_auth(&a.token).send().await?;
    if response.status() == StatusCode::CONFLICT {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "login_challenge_superseded",
            "二维码已更换，请刷新任务状态".into(),
        ));
    }
    if !response.status().is_success() {
        return Err(ApiError::unsupported("二维码尚未生成、已过期或登录已结束"));
    }
    let mut bytes = vec![];
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err(ApiError::unsupported("二维码响应超出限制"));
        }
        bytes.extend_from_slice(&chunk);
    }
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(ApiError::unsupported("上游未返回 PNG 二维码"));
    }
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        bytes,
    )
        .into_response())
}
pub async fn cancel(
    State(app): State<Arc<App>>,
    Path((account, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let a = find_account(&app, &account)?;
    let (remote_id, kind, _) = owned(&app, &account, &id).await?;
    if a.platform == "qq" {
        return Err(ApiError::unsupported(
            "LLBot 不提供取消扫码接口；可等待过期，不能把关闭窗口当作远端取消",
        ));
    }
    if remote_id.is_empty() {
        return Err(ApiError::unsupported(
            "提交结果不确定，无法安全取消未知上游任务",
        ));
    }
    let remote = adapters::response(
        app.http
            .delete(a.wx_url(&["operations", &remote_id])?)
            .bearer_auth(&a.token)
            .send()
            .await?,
    )
    .await?;
    let body = project(&account, &id, &kind, &remote);
    save(&app, &body).await?;
    Ok(Json(body))
}
