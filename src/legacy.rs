//! Metadata-only diagnostics. Never open SQLite, MMKV, key_info or token contents.
use crate::App;
use axum::{Json, extract::State};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};

fn within(root: &Path, relative: &Path) -> bool {
    root.join(relative)
        .canonicalize()
        .is_ok_and(|p| p.starts_with(root))
}
pub fn inspect(root: Option<&Path>) -> Value {
    let Some(root) = root else {
        return json!({"configured":false,"mode":"live-source-readonly","nextStep":"configure-readonly-source","accountsDetected":0,"message":"尚未配置只读旧 config；不会搜索其他个人目录"});
    };
    let root = match root.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return json!({"configured":true,"mode":"live-source-readonly","nextStep":"check-source-mount","message":"只读源目录不可访问"});
        }
    };
    let check = |s: &str| within(&root, Path::new(s));
    let mut accounts = 0;
    let mut sessions = 0;
    let mut contacts = 0;
    let mut messages = 0;
    let mut qq = 0;
    let mut truncated = false;
    if check("xwechat_files") {
        if let Ok(entries) = std::fs::read_dir(root.join("xwechat_files")) {
            for (index, entry) in entries.flatten().enumerate() {
                if index >= 128 {
                    truncated = true;
                    break;
                }
                let path = entry.path();
                if !path.canonicalize().is_ok_and(|p| p.starts_with(&root)) || !path.is_dir() {
                    continue;
                }
                let storage = path.join("db_storage");
                if storage.is_dir() && storage.canonicalize().is_ok_and(|p| p.starts_with(&root)) {
                    accounts += 1;
                    for (name, count) in [
                        ("session/session.db", &mut sessions),
                        ("contact/contact.db", &mut contacts),
                        ("message/message_0.db", &mut messages),
                    ] {
                        let file = storage.join(name);
                        if file.is_file() && file.canonicalize().is_ok_and(|p| p.starts_with(&root))
                        {
                            *count += 1;
                        }
                    }
                }
            }
        }
    }
    if check(".config/QQ") {
        if let Ok(entries) = std::fs::read_dir(root.join(".config/QQ")) {
            for entry in entries.flatten().take(128) {
                if entry.file_name().to_string_lossy().starts_with("nt_qq_")
                    && entry
                        .path()
                        .canonicalize()
                        .is_ok_and(|p| p.starts_with(&root))
                    && entry.path().join("nt_data").is_dir()
                {
                    qq += 1;
                }
            }
        }
    }
    json!({"configured":true,"mode":"live-source-readonly","nextStep":"exclusive-copy-required","readOnly":true,
        "wechat":{"profileRoots":accounts,"sessionDatabases":sessions,"contactDatabases":contacts,"messageDatabases":messages,"globalConfigPresent":check("xwechat_files/all_users/config/global_config"),"savedRoutingPresent":check(".xwechat/net/host"),"layout":if accounts>0{"linux-xwechat-db-storage"}else{"unrecognized"},"decryption":"not-attempted","tokenReuse":"unverified"},
        "qq":{"profileRoots":qq,"layout":if qq>0{"official-qqnt"}else{"unrecognized"},"tokenCompatibility":"not-interchangeable-with-lagrange"},"scanTruncated":truncated,
        "message":"仅检查固定目录和文件存在性，未打开数据库/令牌、未创建锁或 WAL。活跃源保持只读；native 接入必须使用明确准备的一致性独立副本，不能原位接管正在运行的官方目录。"})
}
pub async fn compatibility(State(app): State<Arc<App>>) -> Json<Value> {
    let root = app.config.legacy.clone();
    Json(
        tokio::task::spawn_blocking(move || inspect(root.as_deref()))
            .await
            .unwrap_or_else(|_| json!({"mode":"live-source-readonly","message":"预检未完成"})),
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn metadata_inspection_does_not_create_files() {
        let root = std::env::temp_dir().join(format!("snsbox-legacy-{}", uuid::Uuid::new_v4()));
        let db = root.join("xwechat_files/synthetic/db_storage/session");
        std::fs::create_dir_all(&db).unwrap();
        std::fs::write(db.join("session.db"), b"encrypted fixture").unwrap();
        let result = super::inspect(Some(&root));
        assert_eq!(result["wechat"]["profileRoots"], 1);
        assert_eq!(result["nextStep"], "exclusive-copy-required");
        assert_eq!(std::fs::read_dir(&db).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
