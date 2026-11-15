use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};

pub fn id(parts: &[&str]) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(parts).unwrap())
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn string(v: &Value) -> String {
    v.as_str().map(str::to_owned).unwrap_or_else(|| {
        if v.is_number() {
            v.to_string()
        } else {
            String::new()
        }
    })
}
pub fn preview(segments: &Value) -> String {
    search_text(segments).chars().take(160).collect()
}
pub fn search_text(segments: &Value) -> String {
    segments
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| {
            s["text"]
                .as_str()
                .or(s["title"].as_str())
                .unwrap_or_else(|| match s["type"].as_str().unwrap_or("") {
                    "image" => "[图片]",
                    "video" => "[视频]",
                    "sticker" => "[表情]",
                    "file" => "[文件]",
                    "audio" => "[语音]",
                    "miniApp" => "[小程序]",
                    _ => "[消息]",
                })
        })
        .collect::<Vec<_>>()
        .join(" ")
}
pub fn capabilities(platform: &str, configured: bool) -> Value {
    let mut map = serde_json::Map::new();
    for key in [
        "login", "logout", "text", "image", "video", "file", "sticker", "miniApp", "history",
        "realtime", "mail",
    ] {
        let (status, reason) = if key == "mail" {
            if platform == "qq" {
                ("supported", "QQ 邮箱独立网页入口")
            } else {
                ("unsupported", "此平台无 QQ 邮箱入口")
            }
        } else if key == "sticker"
            || key == "miniApp"
            || (platform == "qq" && matches!(key, "login" | "logout" | "file"))
        {
            (
                "unsupported",
                "当前适配层未开放此发送或账号操作；已有内容保留类型提示",
            )
        } else if !configured {
            ("unavailable", "尚未配置上游接口")
        } else {
            ("unverified", "已实现上游接口适配，真实账号未验收")
        };
        map.insert(key.into(), json!({"status":status,"reason":reason}));
    }
    Value::Object(map)
}
