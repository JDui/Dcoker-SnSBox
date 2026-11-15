//! Optional LuckyLilliaBot 8.3.2 management API; messaging remains Milky.
use crate::{ApiError, ApiResult, App, adapters, config::AccountConfig, model};
use anyhow::{Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
pub struct QrImage {
    pub account: String,
    pub bytes: Vec<u8>,
    pub expires: Instant,
}

pub async fn call(app: &App, a: &AccountConfig, path: &str, body: Option<Value>) -> Result<Value> {
    let mut url = url::Url::parse(
        a.management_url
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("LLBot management not configured"))?,
    )?;
    url.set_path(&format!("/api/{path}"));
    let request = if let Some(body) = body {
        app.http.post(url).json(&body)
    } else {
        app.http.get(url)
    };
    let value = adapters::response(
        request
            .header("X-Webui-Token", &a.management_token)
            .send()
            .await?,
    )
    .await?;
    if value["success"] != true {
        bail!("LLBot rejected management operation");
    }
    Ok(value["data"].clone())
}
pub async fn online(app: &App, a: &AccountConfig) -> Result<bool> {
    let status = call(app, a, "login-info", None).await?;
    if status["online"] == true {
        if model::string(&status["uin"]) != a.upstream_account_id.as_deref().unwrap_or("") {
            bail!("LLBot UIN does not match configured account");
        }
        Ok(true)
    } else if status["online"] == false {
        Ok(false)
    } else {
        bail!("LLBot online evidence unavailable")
    }
}
pub async fn start(app: &App, a: &AccountConfig, body: &mut Value, request: &Value) -> Result<()> {
    let status = call(app, a, "login-info", None).await?;
    if status["mode"] != "direct" {
        body["state"] = json!("blocked");
        body["phase"] = json!("unsupported");
        body["message"] =
            json!("仅支持 LLBot direct 独立资料模式；PMHQ 官方客户端不在本接口接管范围");
        return Ok(());
    }
    if status["online"] == true
        && model::string(&status["uin"]) != a.upstream_account_id.as_deref().unwrap_or("")
    {
        bail!("LLBot UIN mismatch; no account mutation performed");
    }
    let kind = body["kind"].as_str().unwrap_or("");
    if kind == "logout" {
        app.login_qr.lock().await.retain(|_, q| q.account != a.id);
        body["state"] = json!("pending");
        body["phase"] = json!("running");
        body["message"] = json!("已请求 LLBot 注销，等待离线确认");
        call(app, a, "logout", Some(json!({}))).await?;
        return poll(app, a, body).await;
    }
    if status["online"] == true {
        return poll(app, a, body).await;
    }
    if request["strategy"] == "saved-device" || request["allowQr"] == false {
        call(
            app,
            a,
            "quick-login",
            Some(json!({"uin":a.upstream_account_id})),
        )
        .await?;
        body["phase"] = json!("running");
        body["state"] = json!("pending");
        body["message"] = json!("已请求独立 LLBot 保存的登录态；等待在线证据");
    } else {
        // Fetch exactly once per persisted command. Polling never refreshes a QR.
        let qr = match call(app, a, "login-qrcode", None).await {
            Ok(q) => q,
            Err(_) => {
                body["state"] = json!("blocked");
                body["phase"] = json!("prerequisite_missing");
                body["message"] = json!(
                    "LLBot 暂无二维码；请在隔离管理页检查 Auth Token 与网络初始化，未读取官方 QQ 令牌"
                );
                return Ok(());
            }
        };
        let encoded = qr["pngBase64QrcodeData"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing QR PNG"))?;
        let encoded = encoded
            .strip_prefix("data:image/png;base64,")
            .unwrap_or(encoded);
        if encoded.len() > 1_400_000 {
            bail!("QR too large");
        }
        let bytes = STANDARD.decode(encoded)?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.len() > 1024 * 1024 {
            bail!("invalid QR PNG");
        }
        let seconds = qr["expireTime"].as_u64().unwrap_or(0).min(600);
        if seconds == 0 {
            bail!("expired QR");
        }
        let id = body["id"].as_str().unwrap().to_owned();
        let mut cache = app.login_qr.lock().await;
        cache.retain(|_, q| q.expires > Instant::now());
        if cache.len() >= 32 {
            bail!("too many active login QR tasks");
        }
        cache.insert(
            id.clone(),
            QrImage {
                account: a.id.clone(),
                bytes,
                expires: Instant::now() + Duration::from_secs(seconds),
            },
        );
        body["state"] = json!("pending");
        body["phase"] = json!("awaiting_scan");
        body["qrCode"] = json!(format!("/api/v1/accounts/{}/operations/{id}/qr", a.id));
        body["qrGeneration"] = json!(1);
        body["expiresAt"] = json!(
            (chrono::Utc::now() + chrono::Duration::seconds(seconds as i64))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        );
        body["message"] = json!("请扫描 QQ 二维码；仅匹配配置 UIN 的在线状态才算登录完成");
    }
    Ok(())
}
pub async fn poll(app: &App, a: &AccountConfig, body: &mut Value) -> Result<()> {
    let online = online(app, a).await?;
    let logout = body["kind"] == "logout";
    if (logout && !online) || (!logout && online) {
        body["state"] = json!("accepted");
        body["phase"] = json!("succeeded");
        body["qrCode"] = Value::Null;
        body["message"] = json!(if online {
            "LLBot 已确认配置账号在线；真实收发仍须验收"
        } else {
            "LLBot 已确认注销，独立资料保留"
        });
        app.login_qr
            .lock()
            .await
            .remove(body["id"].as_str().unwrap_or(""));
        app.account_status.write().await.insert(
            a.id.clone(),
            (
                if online { "online" } else { "offline" }.into(),
                body["message"].as_str().unwrap().into(),
            ),
        );
    } else if body["state"] == "pending" {
        if body["phase"] == "awaiting_scan"
            && !app
                .login_qr
                .lock()
                .await
                .get(body["id"].as_str().unwrap_or(""))
                .is_some_and(|q| q.expires > Instant::now())
        {
            body["state"] = json!("blocked");
            body["phase"] = json!("expired");
            body["qrCode"] = Value::Null;
            body["message"] = json!("二维码已过期或服务已重启；未自动刷新或重提登录");
        }
    }
    Ok(())
}
pub async fn qr(
    app: &App,
    a: &AccountConfig,
    id: &str,
    generation: Option<u32>,
) -> ApiResult<Vec<u8>> {
    if generation.is_some_and(|v| v != 1) {
        return Err(ApiError(
            axum::http::StatusCode::CONFLICT,
            "login_challenge_superseded",
            "二维码代次不匹配".into(),
        ));
    }
    if online(app, a).await? {
        return Err(ApiError::unsupported("账号已登录，二维码不可用"));
    }
    app.login_qr
        .lock()
        .await
        .get(id)
        .filter(|q| q.expires > Instant::now())
        .map(|q| q.bytes.clone())
        .ok_or_else(|| ApiError::unsupported("二维码已过期或服务已重启"))
}
