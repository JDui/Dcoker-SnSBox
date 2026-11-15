//! HTTP adapters only. No private protocol implementation and no direct profile writes.
use crate::{
    App,
    config::AccountConfig,
    model::{id, string},
    remote_media, store,
};
use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use serde_json::{Value, json};
use sqlx::Row;
use std::{sync::Arc, time::Duration};

pub async fn response(response: reqwest::Response) -> Result<Value> {
    let status = response.status();
    if !status.is_success() {
        bail!("upstream HTTP {}", status.as_u16());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            bail!("upstream response exceeds limit");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).context("invalid upstream JSON")
}
pub async fn wx(
    app: &App,
    a: &AccountConfig,
    pieces: &[&str],
    body: Option<Value>,
    key: Option<&str>,
) -> Result<Value> {
    let url = a.wx_url(pieces)?;
    let mut req = if let Some(body) = body {
        app.http.post(url).json(&body)
    } else {
        app.http.get(url)
    };
    if let Some(key) = key {
        req = req.header("Idempotency-Key", key);
    }
    response(req.bearer_auth(&a.token).send().await?).await
}
pub async fn milky(app: &App, a: &AccountConfig, method: &str, body: Value) -> Result<Value> {
    let value = response(
        app.http
            .post(a.url(&["api", method])?)
            .bearer_auth(&a.token)
            .json(&body)
            .send()
            .await?,
    )
    .await?;
    if value["status"] != "ok" || value["retcode"].as_i64() != Some(0) {
        bail!(
            "upstream rejected command (Milky retcode {})",
            value["retcode"]
        );
    }
    Ok(value["data"].clone())
}
fn conversation(a: &AccountConfig, upstream: &str, title: &str, kind: &str) -> Value {
    json!({"id":id(&[&a.id,kind,upstream]),"accountId":a.id,"platform":a.platform,"upstreamId":upstream,"title":if title.is_empty(){upstream}else{title},"kind":kind,"unreadCount":0,"lastMessage":null,"lastMessageAt":null,"avatarUrl":null})
}
async fn wx_message(app: &App, a: &AccountConfig, m: &Value) -> Result<()> {
    if m["deleted"] == true {
        return Ok(());
    }
    let thread = string(&m["threadId"]);
    let source = string(&m["id"]);
    if thread.is_empty() || source.is_empty() {
        bail!("upstream message lacks stable identity");
    }
    let kind = if thread.ends_with("@chatroom") {
        "group"
    } else {
        "direct"
    };
    let c = conversation(a, &thread, &thread, kind);
    if store::body(&app.db, "conversations", c["id"].as_str().unwrap())
        .await?
        .is_none()
    {
        store::conversation(&app.db, &c).await?;
    }
    let typ = m["type"].as_i64().unwrap_or(0);
    let mut segment = if m.get("recall").is_some_and(|x| !x.is_null()) {
        json!({"type":"text","text":"[消息已撤回]"})
    } else {
        match typ {
            1 | 10000 => json!({"type":"text","text":m["body"].as_str().unwrap_or("")}),
            3 | 34 | 43 | 47 => {
                json!({"type":match typ {3=>"image",34=>"audio",43=>"video",_=>"sticker"},"unavailableReason":"附件仍在上游，当前未下载到 SnSBox"})
            }
            49 => {
                let subtype = m["appMessageType"].as_i64().unwrap_or(0);
                if subtype == 6 {
                    json!({"type":"file","name":m["body"],"unavailableReason":"附件仍在上游，当前未下载到 SnSBox"})
                } else {
                    let url = m["link"]["url"].as_str().filter(|s| safe_link(s));
                    json!({"type":if matches!(subtype,33|36){"miniApp"}else{"link"},"text":m["body"],"title":m["link"]["title"],"url":url})
                }
            }
            _ => {
                json!({"type":"unknown","text":format!("[微信消息类型 {typ}] {}",m["body"].as_str().unwrap_or(""))})
            }
        }
    };
    if matches!(
        segment["type"].as_str(),
        Some("image" | "video" | "sticker" | "audio" | "file")
    ) {
        let kind = segment["type"].as_str().unwrap();
        segment = remote_media::register(
            app,
            &a.id,
            &format!("wx:{source}:{kind}"),
            json!({"messageId":source,"kind":kind}),
            kind,
            segment["name"].as_str().unwrap_or("附件"),
        )
        .await?;
    }
    // serverId correlates an accepted outgoing intent with a later history projection.
    let upstream = if !string(&m["serverId"]).is_empty() {
        format!("server:{}", string(&m["serverId"]))
    } else {
        format!("local:{source}")
    };
    let msg = json!({"id":id(&[&a.id,kind,&thread,&upstream]),"conversationId":c["id"],"accountId":a.id,"platform":a.platform,"upstreamId":upstream,"senderId":m["senderId"],"senderName":m["senderId"],"direction":m["direction"],"timestamp":m["createdAt"],"segments":[segment],"status":"received","error":null});
    store::message(&app.db, &msg).await?;
    if m.get("recall").is_some_and(|x| !x.is_null()) {
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT id FROM messages WHERE account_id=? AND conversation_id=? AND upstream_id=?",
        )
        .bind(&a.id)
        .bind(c["id"].as_str())
        .bind(&upstream)
        .fetch_optional(&app.db)
        .await?;
        if let Some(existing) = existing {
            let mut msg = msg;
            msg["id"] = json!(existing);
            store::update_message(&app.db, &msg).await?;
        }
    }
    Ok(())
}
pub fn safe_link(s: &str) -> bool {
    url::Url::parse(s).is_ok_and(|u| {
        matches!(u.scheme(), "http" | "https")
            && u.host_str().is_some()
            && u.username().is_empty()
            && u.password().is_none()
    })
}

pub async fn sync(app: &App, a: &AccountConfig) -> Result<()> {
    let guard = app.sync_locks.get(&a.id).unwrap().lock().await;
    let result = sync_inner(app, a).await;
    if let Err(error) = &result {
        if let Some(sqlx::Error::Database(db)) = error.downcast_ref::<sqlx::Error>() {
            tracing::warn!(account=%a.id,code=?db.code(),message=%db.message(),"SQLite synchronization failure");
        }
    }
    drop(guard);
    let (status, message) = match &result {
        Ok(()) => (
            "online",
            "上游报告已登录在线；真实账号收发与完整历史尚未验收".to_string(),
        ),
        Err(_) => (
            "error",
            "上游离线或同步失败；检查服务端地址、令牌、账号与日志中的错误类别".to_string(),
        ),
    };
    app.account_status
        .write()
        .await
        .insert(a.id.clone(), (status.into(), message));
    let mut tx = app.db.begin().await?;
    store::event_tx(&mut tx, "account", &a.id, None).await?;
    tx.commit().await?;
    result
}
async fn sync_inner(app: &App, a: &AccountConfig) -> Result<()> {
    if !a.configured() {
        bail!("upstream unconfigured");
    }
    if a.platform == "wechat" {
        let account = wx(app, a, &[], None, None).await?;
        if account["authenticated"] != true || account["connection"] != "online" {
            bail!("WeChat upstream account is not authenticated and online");
        }
        let mut cursor: Option<String> = None;
        for _ in 0..100 {
            let mut url = a.wx_url(&["threads"])?;
            url.query_pairs_mut().append_pair("limit", "100");
            if let Some(ref c) = cursor {
                url.query_pairs_mut().append_pair("cursor", c);
            }
            let page = response(app.http.get(url).bearer_auth(&a.token).send().await?).await?;
            let items = page["items"]
                .as_array()
                .context("threads response missing items")?;
            for thread in items {
                if thread["deleted"] == true {
                    continue;
                }
                let source = string(&thread["id"]);
                if source.is_empty() {
                    continue;
                }
                let kind = if thread["kind"] == "group" {
                    "group"
                } else {
                    "direct"
                };
                let c = conversation(
                    a,
                    &source,
                    thread["displayName"].as_str().unwrap_or(&source),
                    kind,
                );
                store::conversation(&app.db, &c).await?;
                let mut url = a.wx_url(&["threads", &source, "messages"])?;
                url.query_pairs_mut().append_pair("limit", "50");
                let messages =
                    response(app.http.get(url).bearer_auth(&a.token).send().await?).await?;
                for m in messages["items"]
                    .as_array()
                    .context("messages response missing items")?
                {
                    wx_message(app, a, m).await?;
                }
            }
            cursor = page["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                return Ok(());
            }
        }
        bail!("thread pagination exceeded safety bound; history is partial")
    } else {
        let login = milky(app, a, "get_login_info", json!({})).await?;
        let self_id = string(&login["uin"]);
        if self_id.is_empty() || self_id == "0" {
            bail!("QQ is not logged in");
        }
        for (method, field, source_field, title_field, kind) in [
            (
                "get_friend_list",
                "friends",
                "user_id",
                "nickname",
                "direct",
            ),
            (
                "get_group_list",
                "groups",
                "group_id",
                "group_name",
                "group",
            ),
        ] {
            let page = milky(app, a, method, json!({})).await?;
            for peer in page[field].as_array().context("Milky list missing items")? {
                let source = string(&peer[source_field]);
                let title = peer["remark"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or(peer[title_field].as_str())
                    .unwrap_or(&source);
                let c = conversation(a, &source, title, kind);
                store::conversation(&app.db, &c).await?;
                // Lagrange cannot find the latest friend sequence. Only fetch groups initially.
                if kind == "group" {
                    let history = milky(
                        app,
                        a,
                        "get_history_messages",
                        json!({"message_scene":"group","peer_id":peer[source_field],"limit":20}),
                    )
                    .await;
                    if let Ok(history) = history {
                        for m in history["messages"].as_array().into_iter().flatten() {
                            qq_message(app, a, m, &self_id).await?;
                        }
                    }
                }
            }
        }
        Ok(())
    }
}
async fn qq_message(app: &App, a: &AccountConfig, m: &Value, self_id: &str) -> Result<()> {
    let peer = string(&m["peer_id"]);
    let source = string(&m["message_seq"]);
    if peer.is_empty() || source.is_empty() {
        bail!("Milky message lacks stable identity");
    }
    let kind = if m["message_scene"] == "group" {
        "group"
    } else {
        "direct"
    };
    let c = conversation(a, &peer, &peer, kind);
    if store::body(&app.db, "conversations", c["id"].as_str().unwrap())
        .await?
        .is_none()
    {
        store::conversation(&app.db, &c).await?;
    }
    let mut segments:Vec<Value>=m["segments"].as_array().into_iter().flatten().map(|s| {
        let data=&s["data"];
        match s["type"].as_str().unwrap_or("") {
            "text"=>json!({"type":"text","text":data["text"]}),
            "image"|"video"|"record"|"file"=>json!({"type":if s["type"]=="record"{"audio"}else{s["type"].as_str().unwrap()},"unavailableReason":"附件仍在 QQ 上游，未开放任意远程 URL 代理"}),
            "face"|"market_face"=>json!({"type":"sticker","unavailableReason":"QQ 表情消息已保留，当前未下载资源"}),
            "light_app"=>json!({"type":"miniApp","text":"[QQ 小程序卡片：当前仅保留类型，未执行卡片内容]"}),
            "mention"=>json!({"type":"text","text":format!("@{}",string(&data["user_id"]))}),
            "mention_all"=>json!({"type":"text","text":"@全体成员"}),
            other=>json!({"type":"unknown","text":format!("[QQ 消息类型 {other}]")})
        }
    }).collect();
    for (index, s) in m["segments"].as_array().into_iter().flatten().enumerate() {
        let typ = s["type"].as_str().unwrap_or("");
        let remote = s["data"]["temp_url"].as_str().or(s["data"]["url"].as_str());
        if matches!(typ, "image" | "video" | "record" | "file" | "market_face") {
            if let Some(url) = remote {
                let kind = match typ {
                    "record" => "audio",
                    "market_face" => "sticker",
                    other => other,
                };
                segments[index] = remote_media::register(
                    app,
                    &a.id,
                    &format!("qq:{kind}:{peer}:{source}:{index}"),
                    json!({"url":url}),
                    kind,
                    "QQ 附件",
                )
                .await?;
            }
        }
    }
    let timestamp = m["time"]
        .as_i64()
        .and_then(|t| chrono::DateTime::from_timestamp(t, 0))
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    let msg = json!({"id":id(&[&a.id,kind,&peer,&source]),"conversationId":c["id"],"accountId":a.id,"platform":a.platform,"upstreamId":source,"senderId":string(&m["sender_id"]),"senderName":string(&m["sender_id"]),"direction":if string(&m["sender_id"])==self_id{"outgoing"}else{"incoming"},"timestamp":timestamp,"segments":segments,"status":"received","error":null});
    store::message(&app.db, &msg).await
}

async fn wx_events(app: &App, a: &AccountConfig) -> Result<()> {
    let mut cursor: String =
        sqlx::query_scalar("SELECT cursor FROM checkpoints WHERE account_id=?")
            .bind(&a.id)
            .fetch_optional(&app.db)
            .await?
            .unwrap_or_else(|| "0".into());
    for _ in 0..20 {
        let mut url = a.wx_url(&["events"])?;
        url.query_pairs_mut()
            .append_pair("after", &cursor)
            .append_pair("limit", "100");
        let page = response(app.http.get(url).bearer_auth(&a.token).send().await?).await?;
        let events = page["items"]
            .as_array()
            .context("events response missing items")?;
        if events.is_empty() {
            break;
        }
        for event in events {
            if let Some(message_id) = event["data"]["messageId"].as_str() {
                let m = wx(app, a, &["messages", message_id], None, None).await?;
                wx_message(app, a, &m).await?;
            }
            cursor = string(&event["cursor"]);
            if cursor.is_empty() {
                bail!("event cursor absent");
            }
            // Advance only after the corresponding message transaction committed. Replays deduplicate.
            sqlx::query("INSERT INTO checkpoints(account_id,cursor) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET cursor=excluded.cursor").bind(&a.id).bind(&cursor).execute(&app.db).await?;
        }
    }
    Ok(())
}
async fn qq_events(app: &App, a: &AccountConfig) -> Result<()> {
    let response = app
        .stream_http
        .get(a.url(&["event"])?)
        .bearer_auth(&a.token)
        .send()
        .await?;
    if !response.status().is_success()
        || !response
            .headers()
            .get("content-type")
            .and_then(|x| x.to_str().ok())
            .is_some_and(|x| x.starts_with("text/event-stream"))
    {
        bail!("Milky SSE unavailable");
    }
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::new();
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(120), stream.next()).await? {
        buffer.extend_from_slice(&chunk?);
        if buffer.len() > 2 * 1024 * 1024 {
            bail!("SSE frame too large");
        }
        while let Some((end, width)) = sse_boundary(&buffer) {
            let frame = String::from_utf8(buffer.drain(..end + width).collect())?;
            for line in frame.lines().filter_map(|line| line.strip_prefix("data:")) {
                let event: Value = serde_json::from_str(line.trim())?;
                if event["event_type"] == "message_receive" {
                    qq_message(app, a, &event["data"], &string(&event["self_id"])).await?;
                } else if event["event_type"] == "bot_offline" {
                    app.account_status
                        .write()
                        .await
                        .insert(a.id.clone(), ("offline".into(), "QQ 上游报告离线".into()));
                }
            }
        }
    }
    bail!("Milky event stream disconnected; disconnected events may be missing")
}

fn sse_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf = buffer.windows(2).position(|x| x == b"\n\n").map(|p| (p, 2));
    let crlf = buffer
        .windows(4)
        .position(|x| x == b"\r\n\r\n")
        .map(|p| (p, 4));
    match (lf, crlf) {
        (Some(a), Some(b)) => Some(if a.0 < b.0 { a } else { b }),
        (a, b) => a.or(b),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn sse_accepts_both_line_endings() {
        assert_eq!(super::sse_boundary(b"data: {}\n\n"), Some((8, 2)));
        assert_eq!(super::sse_boundary(b"data: {}\r\n\r\n"), Some((8, 4)));
        assert_eq!(super::sse_boundary(b"data: {}\r\n"), None);
    }
}
pub fn start(app: Arc<App>) {
    for a in app
        .config
        .accounts
        .iter()
        .filter(|a| a.configured())
        .cloned()
    {
        let app = app.clone();
        tokio::spawn(async move {
            let mut count = 0u64;
            if a.platform == "qq" {
                let state = app.clone();
                let account = a.clone();
                tokio::spawn(async move {
                    loop {
                        if qq_events(&state, &account).await.is_err() {
                            tracing::warn!(account=%account.id,"QQ event stream disconnected; reconnecting, gap recovery not guaranteed");
                        }
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                });
            }
            loop {
                if count % 12 == 0 && sync(&app, &a).await.is_err() {
                    tracing::warn!(account=%a.id,"upstream sync failed (check connection/configuration)");
                }
                if a.platform == "wechat" && wx_events(&app, &a).await.is_err() {
                    tracing::warn!(account=%a.id,"WeChat event sync failed; cursor retained");
                }
                if reconcile(&app, &a).await.is_err() {
                    tracing::warn!(account=%a.id,"send result reconciliation failed; no resubmission");
                }
                count += 1;
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });
    }
}

pub async fn submit(
    app: Arc<App>,
    a: AccountConfig,
    conversation: Value,
    mut message: Value,
    key: String,
) {
    message["status"] = json!("submitting");
    if store::update_message(&app.db, &message).await.is_err() {
        return;
    }
    match send(&app, &a, &conversation, &message, &key).await {
        Ok((receipt, kind)) => {
            let reference = string(&receipt["id"]);
            if a.platform == "wechat" {
                if reference.is_empty() {
                    message["status"] = json!("uncertain");
                    message["error"] = json!("上游未返回发送任务 ID");
                } else {
                    if sqlx::query("UPDATE outbox SET upstream_ref=?,upstream_kind=? WHERE key=?")
                        .bind(reference)
                        .bind(kind)
                        .bind(&key)
                        .execute(&app.db)
                        .await
                        .is_err()
                    {
                        return;
                    }
                    apply_receipt(&mut message, &receipt);
                }
            } else {
                let seq = string(&receipt["message_seq"]);
                if seq.is_empty() {
                    message["status"] = json!("uncertain");
                    message["error"] = json!("QQ 上游响应缺少消息序号");
                } else {
                    message["status"] = json!("accepted");
                    message["upstreamId"] = json!(seq);
                }
            }
        }
        Err(_) => {
            message["status"] = json!("uncertain");
            message["error"] = json!("上游提交未获可靠结果；请核对会话，避免重复发送");
        }
    }
    if store::update_message(&app.db, &message).await.is_err() {
        tracing::error!("failed to persist send receipt; original outbox retained");
    }
}
async fn send(
    app: &App,
    a: &AccountConfig,
    c: &Value,
    m: &Value,
    key: &str,
) -> Result<(Value, &'static str)> {
    let seg = m["segments"].as_array().context("no segments")?;
    let thread = c["upstreamId"].as_str().context("no thread")?;
    if seg.iter().all(|s| s["type"] == "text") {
        if a.platform == "wechat" {
            let text = seg
                .iter()
                .filter_map(|s| s["text"].as_str())
                .collect::<Vec<_>>()
                .join("");
            return Ok((
                wx(
                    app,
                    a,
                    &["sends"],
                    Some(json!({"threadId":thread,"text":text})),
                    Some(key),
                )
                .await?,
                "sends",
            ));
        }
        let message: Vec<_> = seg
            .iter()
            .map(|s| json!({"type":"text","data":{"text":s["text"]}}))
            .collect();
        return qq_send(app, a, c, json!(message))
            .await
            .map(|x| (x, "sends"));
    }
    let media_id = seg[0]["mediaId"].as_str().context("no media id")?;
    let media = sqlx::query("SELECT name,mime FROM media WHERE id=? AND account_id=?")
        .bind(media_id)
        .bind(&a.id)
        .fetch_one(&app.db)
        .await?;
    let bytes = tokio::fs::read(app.config.data.join("media").join(media_id)).await?;
    let kind = seg[0]["type"].as_str().context("no media kind")?;
    if a.platform == "wechat" {
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(media.get::<String, _>("name"))
            .mime_str(media.get("mime"))?;
        let upload = response(
            app.http
                .post(a.wx_url(&["uploads"])?)
                .bearer_auth(&a.token)
                .multipart(reqwest::multipart::Form::new().part("file", part))
                .send()
                .await?,
        )
        .await?;
        let source = upload["id"]
            .as_str()
            .context("upload response missing id")?;
        Ok((
            wx(
                app,
                a,
                &["sends"],
                Some(json!({"threadId":thread,"kind":kind,"sourceId":source})),
                Some(key),
            )
            .await?,
            "jobs",
        ))
    } else {
        use base64::Engine;
        let uri = format!(
            "base64://{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        );
        qq_send(app,a,c,json!([{"type":kind,"data":{"uri":uri,"sub_type":"normal","summary":null,"thumb_uri":null}}])).await.map(|x|(x,"sends"))
    }
}
async fn qq_send(app: &App, a: &AccountConfig, c: &Value, message: Value) -> Result<Value> {
    let peer: i64 = c["upstreamId"].as_str().context("missing peer")?.parse()?;
    if c["kind"] == "group" {
        milky(
            app,
            a,
            "send_group_message",
            json!({"group_id":peer,"message":message}),
        )
        .await
    } else {
        milky(
            app,
            a,
            "send_private_message",
            json!({"user_id":peer,"message":message}),
        )
        .await
    }
}
fn apply_receipt(message: &mut Value, receipt: &Value) {
    message["status"] = json!(match receipt["state"].as_str().unwrap_or("") {
        "accepted" => "accepted",
        "failed" | "cancelled" | "unsupported" | "expired" => "failed",
        "queued" => "queued",
        "submitting" | "running" => "submitting",
        _ => "uncertain",
    });
    if message["status"] == "failed" || message["status"] == "uncertain" {
        message["error"] = json!("上游发送失败或结果待确认，请核对上游状态");
    } else {
        message["error"] = Value::Null;
    }
    let server = string(
        receipt
            .get("serverId")
            .filter(|x| !x.is_null())
            .unwrap_or(&receipt["serverMessageId"]),
    );
    if !server.is_empty() {
        message["upstreamId"] = json!(format!("server:{server}"));
    }
}
async fn reconcile(app: &App, a: &AccountConfig) -> Result<()> {
    if a.platform != "wechat" {
        return Ok(());
    }
    let rows=sqlx::query("SELECT m.body,o.upstream_ref,o.upstream_kind FROM outbox o JOIN messages m ON m.id=o.message_id WHERE m.account_id=? AND o.upstream_ref IS NOT NULL AND m.status IN ('queued','submitting','uncertain')").bind(&a.id).fetch_all(&app.db).await?;
    for row in rows {
        let receipt = wx(
            app,
            a,
            &[row.get("upstream_kind"), row.get("upstream_ref")],
            None,
            None,
        )
        .await?;
        let mut message: Value = serde_json::from_str(row.get("body"))?;
        apply_receipt(&mut message, &receipt);
        store::update_message(&app.db, &message).await?;
    }
    Ok(())
}
