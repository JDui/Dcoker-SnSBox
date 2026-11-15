//! Read-only legacy history. Official sources never receive SQLite connections.
//! The maintained profile reader works on its own private copy; our only writes
//! are to the separate SnSBox index. Errors deliberately discard upstream details.
mod reader;
#[cfg(test)]
mod tests;

use axum::{
    Json, Router,
    extract::{Path as HttpPath, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::RwLock;
use uuid::Uuid;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceConfig {
    pub id: String,
    pub platform: String,
    pub display_name: String,
    pub profile_path: Option<PathBuf>,
    pub keys_file: Option<PathBuf>,
    #[serde(default)]
    pub allow_plaintext: bool,
    #[serde(default)]
    pub confirmed_consistent_snapshot: bool,
    pub captured_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub id: String,
    pub platform: String,
    pub display_name: String,
    pub kind: &'static str,
    pub status: String,
    pub reason: String,
    pub read_only: bool,
    pub send_allowed: bool,
    pub captured_at: Option<String>,
    pub indexed_at: Option<String>,
    pub consistency: &'static str,
    pub generation: Option<String>,
    pub conversation_count: Option<i64>,
    pub message_count: Option<i64>,
    pub partial: bool,
}

pub struct HistoryService {
    pool: SqlitePool,
    configs: BTreeMap<String, SourceConfig>,
    statuses: RwLock<BTreeMap<String, SourceStatus>>,
    active: Option<PathBuf>,
    index_root: PathBuf,
}

#[derive(Debug)]
pub struct HistoryError(pub StatusCode, pub &'static str, pub &'static str);
impl IntoResponse for HistoryError {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(json!({"error":{"code":self.1,"message":self.2}})),
        )
            .into_response()
    }
}
impl From<sqlx::Error> for HistoryError {
    fn from(_: sqlx::Error) -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "history_query_failed",
            "历史索引读取失败；原资料未改写，请重试或刷新来源",
        )
    }
}
type Result<T> = std::result::Result<T, HistoryError>;
fn blocked(code: &'static str, message: &'static str) -> HistoryError {
    HistoryError(StatusCode::UNPROCESSABLE_ENTITY, code, message)
}
fn missing() -> HistoryError {
    HistoryError(
        StatusCode::NOT_FOUND,
        "history_not_found",
        "找不到该历史来源或会话",
    )
}
fn invalid_cursor() -> HistoryError {
    HistoryError(
        StatusCode::BAD_REQUEST,
        "invalid_history_cursor",
        "历史游标与来源、查询或分页类型不匹配，请重新加载",
    )
}
fn unavailable() -> HistoryError {
    blocked(
        "history_unavailable",
        "该来源尚不可读，请先检查副本、密钥及资料状态",
    )
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
pub(crate) fn opaque(parts: &[&str]) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(parts).expect("string identifiers serialize"))
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub(crate) fn overlaps(one: &Path, two: &Path) -> bool {
    one.starts_with(two) || two.starts_with(one)
}

impl HistoryService {
    pub async fn open(data: &Path, active_source: Option<&Path>) -> anyhow::Result<Arc<Self>> {
        let configs = match std::env::var_os("SNSBOX_HISTORY_SOURCES_FILE") {
            Some(path) => {
                let bytes = std::fs::read(path)
                    .map_err(|_| anyhow::anyhow!("history source configuration is unreadable"))?;
                if bytes.len() > 1024 * 1024 {
                    anyhow::bail!("history source configuration exceeds limit")
                }
                serde_json::from_slice::<Vec<SourceConfig>>(&bytes)
                    .map_err(|_| anyhow::anyhow!("history source configuration is invalid"))?
            }
            None => vec![
                SourceConfig {
                    id: "legacy-wechat".into(),
                    platform: "wechat".into(),
                    display_name: "既有微信历史".into(),
                    profile_path: None,
                    keys_file: None,
                    allow_plaintext: false,
                    confirmed_consistent_snapshot: false,
                    captured_at: None,
                },
                SourceConfig {
                    id: "legacy-qq".into(),
                    platform: "qq".into(),
                    display_name: "既有 QQ 历史".into(),
                    profile_path: None,
                    keys_file: None,
                    allow_plaintext: false,
                    confirmed_consistent_snapshot: false,
                    captured_at: None,
                },
            ],
        };
        Self::with_configs(data, active_source, configs).await
    }

    pub(crate) async fn with_configs(
        data: &Path,
        active_source: Option<&Path>,
        configs: Vec<SourceConfig>,
    ) -> anyhow::Result<Arc<Self>> {
        if configs.len() > 32 {
            anyhow::bail!("too many history sources")
        }
        let data = data.canonicalize().map_err(|_| {
            anyhow::anyhow!("history index requires an existing isolated data directory")
        })?;
        let active = active_source
            .map(Path::canonicalize)
            .transpose()
            .map_err(|_| anyhow::anyhow!("history active-source guard is unavailable"))?;
        if active.as_ref().is_some_and(|root| overlaps(root, &data)) {
            anyhow::bail!("history source and index must be isolated")
        }
        if configs
            .iter()
            .filter_map(|config| config.profile_path.as_ref()?.canonicalize().ok())
            .any(|source| overlaps(&source, &data))
        {
            anyhow::bail!("history source and data must be isolated before index creation")
        }
        let temp = std::env::temp_dir()
            .canonicalize()
            .map_err(|_| anyhow::anyhow!("history temporary directory is unavailable"))?;
        if active
            .as_ref()
            .is_some_and(|source| temp.starts_with(source))
            || configs
                .iter()
                .filter_map(|config| config.profile_path.as_ref()?.canonicalize().ok())
                .any(|source| temp.starts_with(source))
        {
            anyhow::bail!("history temporary directory must be outside every source")
        }
        let index_root = data.join("history");
        if index_root
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            anyhow::bail!("history index cannot be a link")
        }
        std::fs::create_dir_all(&index_root)
            .map_err(|_| anyhow::anyhow!("history index directory cannot be created"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&index_root, std::fs::Permissions::from_mode(0o700))?;
        }
        let index_root = index_root.canonicalize()?;
        let database = index_root.join("history.sqlite3");
        if database
            .symlink_metadata()
            .is_ok_and(|metadata| !metadata.is_file() || metadata.file_type().is_symlink())
        {
            anyhow::bail!("invalid history index file")
        }
        if !database.exists() {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options
                .open(&database)
                .map_err(|_| anyhow::anyhow!("history index file cannot be created"))?;
        }
        let pool = SqlitePoolOptions::new()
            .max_connections(3)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&database)
                    .create_if_missing(false)
                    .busy_timeout(Duration::from_secs(10))
                    .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal),
            )
            .await
            .map_err(|_| anyhow::anyhow!("history index unavailable"))?;
        sqlx::query("CREATE TABLE IF NOT EXISTS history_runs(source_id TEXT PRIMARY KEY,generation TEXT NOT NULL,source_binding TEXT NOT NULL,captured_at TEXT,indexed_at TEXT NOT NULL,partial INTEGER NOT NULL,conversation_count INTEGER NOT NULL,message_count INTEGER NOT NULL)").execute(&pool).await?;
        sqlx::query("CREATE TABLE IF NOT EXISTS history_conversations(source_id TEXT NOT NULL,generation TEXT NOT NULL,id TEXT NOT NULL,title_search TEXT NOT NULL,time INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(source_id,generation,id))").execute(&pool).await?;
        sqlx::query("CREATE TABLE IF NOT EXISTS history_messages(source_id TEXT NOT NULL,generation TEXT NOT NULL,id TEXT NOT NULL,conversation_id TEXT NOT NULL,time INTEGER NOT NULL,search_text TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(source_id,generation,id))").execute(&pool).await?;
        sqlx::query("CREATE INDEX IF NOT EXISTS history_message_order ON history_messages(source_id,generation,time DESC,id DESC)").execute(&pool).await?;
        sqlx::query("CREATE INDEX IF NOT EXISTS history_conversation_messages ON history_messages(source_id,generation,conversation_id,time DESC,id DESC)").execute(&pool).await?;
        let mut map = BTreeMap::new();
        let mut statuses = BTreeMap::new();
        for config in configs {
            if !valid_id(&config.id)
                || !matches!(config.platform.as_str(), "wechat" | "qq")
                || config.display_name.is_empty()
                || config.display_name.len() > 200
                || map.contains_key(&config.id)
            {
                anyhow::bail!("invalid history source identity")
            }
            if config
                .captured_at
                .as_ref()
                .is_some_and(|time| chrono::DateTime::parse_from_rfc3339(time).is_err())
            {
                anyhow::bail!("history capturedAt must be RFC3339")
            }
            let mut status = initial_status(&config, active.as_deref(), &data);
            // Persisted data never overrides a newly blocked/missing source.
            if status.status == "not_loaded" {
                if let Some(row) =
                    sqlx::query("SELECT * FROM history_runs WHERE source_id=? AND source_binding=?")
                        .bind(&config.id)
                        .bind(source_binding(&config))
                        .fetch_optional(&pool)
                        .await?
                {
                    status.generation = Some(row.get("generation"));
                    status.captured_at = row.get("captured_at");
                    status.indexed_at = Some(row.get("indexed_at"));
                    status.partial = row.get("partial");
                    status.conversation_count = Some(row.get("conversation_count"));
                    status.message_count = Some(row.get("message_count"));
                    status.status = if status.partial { "partial" } else { "ready" }.into();
                    status.reason = "展示上次建立的本地只读索引；刷新才重新读取已配置副本".into();
                }
            }
            statuses.insert(config.id.clone(), status);
            map.insert(config.id.clone(), config);
        }
        Ok(Arc::new(Self {
            pool,
            configs: map,
            statuses: RwLock::new(statuses),
            active,
            index_root,
        }))
    }

    async fn status(&self, source: &str) -> Result<SourceStatus> {
        self.statuses
            .read()
            .await
            .get(source)
            .cloned()
            .ok_or_else(missing)
    }

    pub async fn refresh(self: &Arc<Self>, source: &str) -> Result<SourceStatus> {
        let mut config = self.configs.get(source).cloned().ok_or_else(missing)?;
        let preflight = initial_status(
            &config,
            self.active.as_deref(),
            self.index_root.parent().expect("index is under data"),
        );
        if preflight.status != "not_loaded" {
            self.statuses
                .write()
                .await
                .insert(source.into(), preflight.clone());
            return Ok(preflight);
        }
        {
            let mut statuses = self.statuses.write().await;
            let status = statuses.get_mut(source).ok_or_else(missing)?;
            if status.status == "refreshing" {
                return Ok(status.clone());
            }
            status.status = "refreshing".into();
            status.reason = "正在读取已确认的独立副本；原资料不写入".into();
        }
        // Pin the already validated canonical root before entering a worker.
        config.profile_path = config
            .profile_path
            .as_ref()
            .and_then(|path| path.canonicalize().ok());
        let pending = self.status(source).await?;
        let service = Arc::clone(self);
        let source = source.to_string();
        tokio::spawn(async move {
            let result = tokio::task::spawn_blocking(move || reader::read(&config)).await;
            let result = match result {
                Ok(result) => result,
                Err(_) => Err(blocked(
                    "history_read_failed",
                    "历史读取未完成；原资料未改写，请重试",
                )),
            };
            match result {
                Ok(snapshot) => match service.publish(&source, snapshot).await {
                    Ok(status) => {
                        service.statuses.write().await.insert(source, status);
                    }
                    Err(_) => {
                        service
                            .fail(&source, "error", "历史索引保存失败，原资料未改写；请重试")
                            .await
                    }
                },
                Err(error) => service.fail(&source, error.1, error.2).await,
            }
        });
        Ok(pending)
    }

    async fn fail(&self, source: &str, code: &str, reason: &str) {
        if let Some(status) = self.statuses.write().await.get_mut(source) {
            status.status = match code {
                "keys_required" => "keys_required",
                "snapshot_required" => "snapshot_required",
                "history_unsupported" => "unsupported",
                _ => "error",
            }
            .into();
            status.reason = reason.into();
        }
    }

    async fn publish(&self, source: &str, snapshot: reader::Snapshot) -> Result<SourceStatus> {
        let generation = Uuid::new_v4().to_string();
        let indexed_at = now();
        let mut transaction = self.pool.begin().await?;
        sqlx::query("DELETE FROM history_messages WHERE source_id=?")
            .bind(source)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM history_conversations WHERE source_id=?")
            .bind(source)
            .execute(&mut *transaction)
            .await?;
        for conversation in &snapshot.conversations {
            sqlx::query("INSERT INTO history_conversations(source_id,generation,id,title_search,time,body)VALUES(?,?,?,?,?,?)").bind(source).bind(&generation).bind(&conversation.id).bind(conversation.title.to_lowercase()).bind(conversation.time).bind(conversation.body.to_string()).execute(&mut *transaction).await?;
        }
        for message in &snapshot.messages {
            sqlx::query("INSERT INTO history_messages(source_id,generation,id,conversation_id,time,search_text,body)VALUES(?,?,?,?,?,?,?)").bind(source).bind(&generation).bind(&message.id).bind(&message.conversation_id).bind(message.time).bind(message.search_text.to_lowercase()).bind(message.body.to_string()).execute(&mut *transaction).await?;
        }
        let config = &self.configs[source];
        sqlx::query("INSERT INTO history_runs(source_id,generation,source_binding,captured_at,indexed_at,partial,conversation_count,message_count)VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET generation=excluded.generation,source_binding=excluded.source_binding,captured_at=excluded.captured_at,indexed_at=excluded.indexed_at,partial=excluded.partial,conversation_count=excluded.conversation_count,message_count=excluded.message_count").bind(source).bind(&generation).bind(source_binding(config)).bind(&config.captured_at).bind(&indexed_at).bind(snapshot.partial).bind(snapshot.conversations.len() as i64).bind(snapshot.messages.len() as i64).execute(&mut *transaction).await?;
        transaction.commit().await?;
        let mut status = initial_status(
            config,
            self.active.as_deref(),
            self.index_root.parent().expect("index is under data"),
        );
        status.status = if snapshot.partial { "partial" } else { "ready" }.into();
        status.reason = if snapshot.partial {
            "部分数据库、类型或超出读取上限的记录未纳入；只能搜索当前本地索引"
        } else {
            "已建立所配置副本的本地只读历史索引；不代表全设备完整记录"
        }
        .into();
        status.partial = snapshot.partial;
        status.generation = Some(generation);
        status.indexed_at = Some(indexed_at);
        status.conversation_count = Some(snapshot.conversations.len() as i64);
        status.message_count = Some(snapshot.messages.len() as i64);
        Ok(status)
    }
}

fn source_binding(config: &SourceConfig) -> String {
    let path = config
        .profile_path
        .as_ref()
        .and_then(|path| path.canonicalize().ok());
    let key = config
        .keys_file
        .as_ref()
        .and_then(|path| path.canonicalize().ok());
    let key_metadata = key
        .as_ref()
        .and_then(|path| std::fs::metadata(path).ok())
        .map(|metadata| {
            (
                metadata.len(),
                metadata
                    .modified()
                    .ok()
                    .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|value| value.as_nanos().to_string()),
            )
        });
    // Stored only in the private index; never sent to a browser or a log.
    serde_json::to_string(&(
        path,
        key,
        key_metadata,
        config.allow_plaintext,
        config.confirmed_consistent_snapshot,
        &config.captured_at,
    ))
    .unwrap_or_default()
}
fn changed() -> HistoryError {
    HistoryError(
        StatusCode::CONFLICT,
        "history_changed",
        "历史来源已刷新，请从第一页重新加载",
    )
}
async fn read_transaction(
    service: &HistoryService,
    status: &SourceStatus,
) -> Result<sqlx::Transaction<'static, sqlx::Sqlite>> {
    let mut transaction = service.pool.begin().await?;
    let generation: Option<String> =
        sqlx::query_scalar("SELECT generation FROM history_runs WHERE source_id=?")
            .bind(&status.id)
            .fetch_optional(&mut *transaction)
            .await?;
    if generation.as_deref() != status.generation.as_deref() {
        return Err(changed());
    }
    Ok(transaction)
}

fn initial_status(config: &SourceConfig, active: Option<&Path>, data: &Path) -> SourceStatus {
    let mut status = SourceStatus {
        id: config.id.clone(),
        platform: config.platform.clone(),
        display_name: config.display_name.clone(),
        kind: "legacy-readonly",
        status: "not_loaded".into(),
        reason: "已配置独立副本；点击读取来源建立本地只读索引".into(),
        read_only: true,
        send_allowed: false,
        captured_at: config.captured_at.clone(),
        indexed_at: None,
        consistency: "operator-confirmed-copy",
        generation: None,
        conversation_count: None,
        message_count: None,
        partial: false,
    };
    let blocked = if config.platform == "qq" {
        Some((
            "unsupported",
            "当前读取器不解密官方 QQNT 既有资料；独立 QQ 网络上游历史不等于旧资料历史",
        ))
    } else if !config.confirmed_consistent_snapshot {
        Some((
            "snapshot_required",
            "当前没有已确认的一致性副本和数据库密钥；不能读取活跃源，请在部署端配置独立副本",
        ))
    } else if config.profile_path.is_none() {
        Some((
            "snapshot_required",
            "未配置独立资料副本；不会自动搜索或接管活跃源",
        ))
    } else if config
        .profile_path
        .as_ref()
        .and_then(|path| path.canonicalize().ok())
        .is_none()
    {
        Some((
            "snapshot_required",
            "配置的独立副本不可访问，请检查只读挂载",
        ))
    } else if config
        .profile_path
        .as_ref()
        .and_then(|path| path.canonicalize().ok())
        .is_some_and(|path| {
            overlaps(&path, data) || active.is_some_and(|root| overlaps(&path, root))
        })
    {
        Some((
            "snapshot_required",
            "拒绝与活跃源或自有索引重叠的资料路径；未打开数据库",
        ))
    } else if !temporary_directory_isolated(config.profile_path.as_deref(), active) {
        Some((
            "snapshot_required",
            "临时目录不可用或位于资料来源内；请配置独立临时目录后重启",
        ))
    } else if !config.allow_plaintext && config.keys_file.is_none() {
        Some((
            "keys_required",
            "加密资料缺少受保护数据库密钥文件；保存登录材料不能代替数据库密钥",
        ))
    } else {
        None
    };
    if let Some((code, reason)) = blocked {
        status.status = code.into();
        status.reason = reason.into();
        status.consistency = "unavailable";
    }
    status
}

fn temporary_directory_isolated(source: Option<&Path>, active: Option<&Path>) -> bool {
    let Ok(temp) = std::env::temp_dir().canonicalize() else {
        return false;
    };
    let source = source.and_then(|path| path.canonicalize().ok());
    !source.as_ref().is_some_and(|path| temp.starts_with(path))
        && !active.is_some_and(|path| temp.starts_with(path))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageQuery {
    cursor: Option<String>,
    limit: Option<usize>,
    query: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    source: String,
    generation: String,
    kind: String,
    query: String,
    offset: i64,
}
fn pagination(query: &PageQuery, status: &SourceStatus, kind: &str) -> Result<(i64, i64, String)> {
    let limit = query.limit.unwrap_or(50);
    if !(1..=200).contains(&limit) {
        return Err(blocked("invalid_history_query", "分页数量应为 1–200"));
    }
    let search = query
        .query
        .clone()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if search.len() > 2048 {
        return Err(blocked("invalid_history_query", "搜索词过长，请缩短后重试"));
    }
    let generation = status.generation.as_deref().ok_or_else(unavailable)?;
    let offset = match &query.cursor {
        None => 0,
        Some(raw) => {
            if raw.len() > 8192 {
                return Err(invalid_cursor());
            }
            let cursor: Cursor =
                serde_json::from_slice(&URL_SAFE_NO_PAD.decode(raw).map_err(|_| invalid_cursor())?)
                    .map_err(|_| invalid_cursor())?;
            if cursor.source != status.id
                || cursor.kind != kind
                || cursor.query != search
                || cursor.offset < 0
                || cursor.offset > 100_000
            {
                return Err(invalid_cursor());
            }
            if cursor.generation != generation {
                return Err(HistoryError(
                    StatusCode::CONFLICT,
                    "history_changed",
                    "历史来源已刷新，请从第一页重新加载",
                ));
            }
            cursor.offset
        }
    };
    Ok((limit as i64, offset, search))
}
fn page(
    items: Vec<Value>,
    limit: i64,
    offset: i64,
    status: &SourceStatus,
    kind: &str,
    search: &str,
) -> Value {
    let more = items.len() > limit as usize;
    let next = more.then(|| {
        URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&Cursor {
                source: status.id.clone(),
                generation: status.generation.clone().unwrap_or_default(),
                kind: kind.into(),
                query: search.into(),
                offset: offset + limit,
            })
            .expect("cursor serializes"),
        )
    });
    json!({"items":items.into_iter().take(limit as usize).collect::<Vec<_>>(),"nextCursor":next,"generation":status.generation,"partial":status.partial,"capturedAt":status.captured_at})
}

pub fn routes<S: Clone + Send + Sync + 'static>(service: Arc<HistoryService>) -> Router<S> {
    Router::new()
        .route("/history/sources", get(sources))
        .route("/history/sources/{source}/refresh", post(refresh))
        .route(
            "/history/sources/{source}/conversations",
            get(conversations),
        )
        .route(
            "/history/sources/{source}/conversations/{conversation}/messages",
            get(messages),
        )
        .route("/history/sources/{source}/messages", get(search))
        .with_state(service)
}
async fn sources(State(service): State<Arc<HistoryService>>) -> Json<Value> {
    Json(json!({"items":service.statuses.read().await.values().cloned().collect::<Vec<_>>()}))
}
async fn refresh(
    State(service): State<Arc<HistoryService>>,
    HttpPath(source): HttpPath<String>,
    Json(_): Json<Value>,
) -> Result<Json<SourceStatus>> {
    Ok(Json(service.refresh(&source).await?))
}
async fn conversations(
    State(service): State<Arc<HistoryService>>,
    HttpPath(source): HttpPath<String>,
    Query(query): Query<PageQuery>,
) -> Result<Json<Value>> {
    let status = service.status(&source).await?;
    let (limit, offset, search) = pagination(&query, &status, "conversations")?;
    let mut transaction = read_transaction(&service, &status).await?;
    let rows=sqlx::query("SELECT body FROM history_conversations WHERE source_id=? AND generation=? AND (?='' OR instr(title_search,?)>0) ORDER BY time DESC,id DESC LIMIT ? OFFSET ?").bind(&source).bind(&status.generation).bind(&search).bind(&search).bind(limit+1).bind(offset).fetch_all(&mut *transaction).await?;
    transaction.commit().await?;
    let items = rows
        .into_iter()
        .map(|row| serde_json::from_str(row.get("body")).map_err(|_| unavailable()))
        .collect::<Result<Vec<Value>>>()?;
    Ok(Json(page(
        items,
        limit,
        offset,
        &status,
        "conversations",
        &search,
    )))
}
async fn messages(
    State(service): State<Arc<HistoryService>>,
    HttpPath((source, conversation)): HttpPath<(String, String)>,
    Query(query): Query<PageQuery>,
) -> Result<Json<Value>> {
    message_page(&service, &source, Some(&conversation), query).await
}
async fn search(
    State(service): State<Arc<HistoryService>>,
    HttpPath(source): HttpPath<String>,
    Query(query): Query<PageQuery>,
) -> Result<Json<Value>> {
    if query
        .query
        .as_ref()
        .is_none_or(|value| value.trim().is_empty())
    {
        return Err(blocked("invalid_history_query", "请输入搜索词"));
    }
    message_page(&service, &source, None, query).await
}
async fn message_page(
    service: &HistoryService,
    source: &str,
    conversation: Option<&str>,
    query: PageQuery,
) -> Result<Json<Value>> {
    let status = service.status(source).await?;
    let kind = format!("messages:{}", conversation.unwrap_or("*"));
    let (limit, offset, search) = pagination(&query, &status, &kind)?;
    let mut transaction = read_transaction(service, &status).await?;
    if let Some(conversation) = conversation {
        let exists:i64=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM history_conversations WHERE source_id=? AND generation=? AND id=?)").bind(source).bind(&status.generation).bind(conversation).fetch_one(&mut *transaction).await?;
        if exists == 0 {
            return Err(missing());
        }
    }
    let rows=sqlx::query("SELECT body FROM history_messages WHERE source_id=? AND generation=? AND (? IS NULL OR conversation_id=?) AND (?='' OR instr(search_text,?)>0) ORDER BY time DESC,id DESC LIMIT ? OFFSET ?").bind(source).bind(&status.generation).bind(conversation).bind(conversation).bind(&search).bind(&search).bind(limit+1).bind(offset).fetch_all(&mut *transaction).await?;
    transaction.commit().await?;
    let items = rows
        .into_iter()
        .map(|row| serde_json::from_str(row.get("body")).map_err(|_| unavailable()))
        .collect::<Result<Vec<Value>>>()?;
    Ok(Json(page(items, limit, offset, &status, &kind, &search)))
}
