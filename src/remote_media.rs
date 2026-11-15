use crate::{ApiError, ApiResult, App, adapters, find_account, media_mime, model};
use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use serde_json::{Value, json};
use sqlx::Row;
use std::{net::IpAddr, time::Duration};
use uuid::Uuid;

pub async fn register(
    app: &App,
    account: &str,
    key: &str,
    source: Value,
    kind: &str,
    name: &str,
) -> Result<Value> {
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO remote_media(id,account_id,source_key,source,name,kind) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,source_key) DO UPDATE SET source=excluded.source")
        .bind(&id).bind(account).bind(key).bind(source.to_string()).bind(name).bind(kind).execute(&app.db).await?;
    let id: String =
        sqlx::query_scalar("SELECT id FROM remote_media WHERE account_id=? AND source_key=?")
            .bind(account)
            .bind(key)
            .fetch_one(&app.db)
            .await?;
    Ok(json!({"type":kind,"mediaId":id,"url":format!("/api/v1/media/{id}"),"name":name}))
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let [a, b, _, _] = v.octets();
            !(v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_multicast()
                || v.is_broadcast()
                || v.is_documentation()
                || a == 0
                || a >= 240
                || a == 127
                || (a == 100 && (64..=127).contains(&b))
                || (a == 198 && (b == 18 || b == 19)))
        }
        IpAddr::V6(v) => {
            if let Some(v) = v.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(v));
            }
            let s = v.segments();
            !v.is_loopback()
                && !v.is_unspecified()
                && !v.is_multicast()
                && (s[0] & 0xfe00) != 0xfc00
                && (s[0] & 0xffc0) != 0xfe80
                && !(s[0] == 0x2001 && s[1] == 0xdb8)
                && s[0] >= 0x2000
                && s[0] <= 0x3fff
        }
    }
}
async fn qq_fetch(raw: &str) -> Result<reqwest::Response> {
    let url = url::Url::parse(raw)?;
    let host = url.host_str().context("media host absent")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port().is_some_and(|p| p != 80 && p != 443)
        || !(["qq.com", "qpic.cn", "gtimg.cn", "gtimg.com"]
            .iter()
            .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}"))))
    {
        bail!("QQ media origin is not allowlisted");
    }
    let addrs: Vec<_> = tokio::net::lookup_host((host, url.port_or_known_default().unwrap()))
        .await?
        .collect();
    if addrs.is_empty() || addrs.iter().any(|addr| !public_ip(addr.ip())) {
        bail!("media host resolved to a non-public address");
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .resolve_to_addrs(host, &addrs)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()?;
    Ok(client.get(url).send().await?)
}
pub async fn cache(app: &App, id: &str) -> ApiResult<()> {
    let _guard = app.media_lock.lock().await;
    if sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM media WHERE id=?")
        .bind(id)
        .fetch_one(&app.db)
        .await?
        > 0
    {
        return Ok(());
    }
    let row = sqlx::query("SELECT account_id,source,name,kind FROM remote_media WHERE id=?")
        .bind(id)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(ApiError::missing)?;
    let account: &str = row.get("account_id");
    let a = find_account(app, account)?;
    let source: Value = serde_json::from_str(row.get("source"))?;
    let response = if a.platform == "wechat" {
        let message = source["messageId"].as_str().ok_or_else(ApiError::missing)?;
        let assets = adapters::wx(app, a, &["messages", message, "media"], None, None)
            .await
            .map_err(|_| ApiError::unsupported("无法读取上游附件列表"))?;
        let kind = source["kind"].as_str().unwrap_or("");
        let asset = assets["items"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|asset| {
                asset["state"] == "available"
                    && (asset["kind"] == kind || (kind == "audio" && asset["kind"] == "voice"))
            })
            .ok_or_else(|| {
                ApiError::unsupported("上游附件尚未下载、已过期或不支持；请在上游下载后刷新")
            })?;
        let asset_id = asset["id"].as_str().ok_or_else(ApiError::missing)?;
        app.http
            .get(a.wx_url(&["media", asset_id, "content"])?)
            .bearer_auth(&a.token)
            .send()
            .await?
    } else {
        qq_fetch(source["url"].as_str().ok_or_else(ApiError::missing)?)
            .await
            .map_err(|_| {
                ApiError::unsupported("QQ 附件地址不可用、不是允许的 CDN 或网络请求失败")
            })?
    };
    if !response.status().is_success() {
        return Err(ApiError::unsupported("上游附件暂不可用或已经过期"));
    }
    let maximum = 32 * 1024 * 1024;
    if response.content_length().is_some_and(|n| n > maximum) {
        return Err(ApiError::unsupported("附件超过当前 32 MiB 下载上限"));
    }
    let mut bytes = vec![];
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > maximum as usize {
            return Err(ApiError::unsupported("附件超过当前 32 MiB 下载上限"));
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err(ApiError::unsupported("上游附件为空"));
    }
    let used: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(size),0) FROM media")
        .fetch_one(&app.db)
        .await?;
    if used as u64 + bytes.len() as u64 > app.config.media_limit {
        return Err(ApiError::unsupported("SnSBox 附件缓存配额已满"));
    }
    let mime = media_mime(&bytes);
    let path = app.config.data.join("media").join(id);
    tokio::fs::write(&path, &bytes).await?;
    if let Err(e) = sqlx::query(
        "INSERT INTO media(id,account_id,name,mime,size,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(id)
    .bind(account)
    .bind(row.get::<&str, _>("name"))
    .bind(mime)
    .bind(bytes.len() as i64)
    .bind(model::now())
    .execute(&app.db)
    .await
    {
        let _ = tokio::fs::remove_file(path).await;
        return Err(e.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_addresses_are_not_cdn_targets() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        assert!(public_ip("1.1.1.1".parse().unwrap()));
    }
}
