use super::{HistoryError, SourceConfig, blocked, opaque};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use wechat_profile::{
    DatabaseState, KeyFile, ListQuery, MessageQuery, ProfileError, ProfileLocation, ProfileReader,
    ReadOptions, SqlValue,
};

pub struct Conversation {
    pub id: String,
    pub title: String,
    pub time: i64,
    pub body: Value,
}
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub time: i64,
    pub search_text: String,
    pub body: Value,
}
pub struct Snapshot {
    pub conversations: Vec<Conversation>,
    pub messages: Vec<Message>,
    pub partial: bool,
}
const MAX_MESSAGES: usize = 100_000;
const MAX_TEXT_BYTES: usize = 64 * 1024 * 1024;

fn profile_error(error: ProfileError) -> HistoryError {
    match error {
        ProfileError::KeysMissing | ProfileError::KeyUnavailable(_) => blocked(
            "keys_required",
            "副本缺少授权数据库密钥；请在部署端提供受保护文件",
        ),
        ProfileError::KeyMismatch(_)
        | ProfileError::AccountMismatch
        | ProfileError::InvalidKeysFile
        | ProfileError::InsecureKeysFile => blocked(
            "keys_required",
            "数据库密钥与来源不匹配、格式不支持或权限不安全；不会猜测密钥",
        ),
        ProfileError::SnapshotRequired | ProfileError::SourceChanged => blocked(
            "snapshot_required",
            "副本缺少一致性确认或读取期间发生变化，请更换稳定的一致性副本",
        ),
        ProfileError::InvalidProfile
        | ProfileError::UnsupportedSchema(_)
        | ProfileError::SqlcipherUnavailable => blocked(
            "history_unsupported",
            "当前资料布局或数据库引擎不支持只读读取",
        ),
        _ => blocked(
            "history_read_failed",
            "读取副本失败；源资料未改写，请检查副本、密钥和布局",
        ),
    }
}
fn timestamp(value: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(value, 0).map(|value| value.to_rfc3339())
}
fn summary(fields: &wechat_profile::RawFields) -> Option<String> {
    match fields.get("summary") {
        Some(SqlValue::Text(text)) => Some(text.clone()),
        _ => None,
    }
}

pub fn read(config: &SourceConfig) -> Result<Snapshot, HistoryError> {
    let location = ProfileLocation::new(
        config
            .profile_path
            .as_ref()
            .ok_or_else(|| blocked("snapshot_required", "缺少独立副本"))?,
    )
    .map_err(profile_error)?;
    let keys = match &config.keys_file {
        Some(file) => KeyFile::load(file).map_err(profile_error)?,
        None if config.allow_plaintext => KeyFile::empty(location.account_directory()),
        None => return Err(blocked("keys_required", "缺少受保护数据库密钥文件")),
    };
    let reader = ProfileReader::open(
        location,
        keys,
        ReadOptions {
            stopped_or_consistent_snapshot: true,
            allow_plaintext: config.allow_plaintext,
            max_database_bytes: 2 * 1024 * 1024 * 1024,
            max_total_bytes: 8 * 1024 * 1024 * 1024,
            max_databases: 256,
            max_blob_bytes: 4 * 1024 * 1024,
            ..Default::default()
        },
    )
    .map_err(profile_error)?;
    let labels = reader.labels().map_err(profile_error)?;
    let mut partial = reader
        .inventory()
        .iter()
        .any(|item| item.state != DatabaseState::Readable);
    let mut conversations = BTreeMap::new();
    let mut cursor = None;
    loop {
        let page = reader
            .threads(&ListQuery {
                limit: Some(200),
                cursor,
                search: None,
            })
            .map_err(profile_error)?;
        for thread in page.items {
            let id = opaque(&["history-conversation", &config.id, &thread.username]);
            let time = thread.last_timestamp.or(thread.sort_timestamp).unwrap_or(0);
            let body = json!({"id":id,"sourceId":config.id,"accountId":format!("history:{}",config.id),"platform":config.platform,"title":thread.label,"kind":if thread.username.ends_with("@chatroom"){"group"}else{"direct"},"lastMessage":summary(&thread.raw_fields),"lastMessageAt":timestamp(time),"unreadCount":0,"unread":false,"pinned":false,"muted":false,"readOnly":true});
            conversations.insert(
                thread.username,
                Conversation {
                    id,
                    title: thread.label,
                    time,
                    body,
                },
            );
        }
        if conversations.len() >= 100_000 {
            partial = true;
            break;
        }
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    let mut messages = Vec::new();
    let mut cursor = None;
    let mut bytes = 0usize;
    'pages: loop {
        let page = reader
            .messages(&MessageQuery {
                limit: Some(200),
                cursor,
                ..Default::default()
            })
            .map_err(profile_error)?;
        for message in page.items {
            if messages.len() >= MAX_MESSAGES {
                partial = true;
                break 'pages;
            }
            if message.message_type != 1 || message.peer.is_none() {
                partial = true;
            }
            let peer = message
                .peer
                .clone()
                .unwrap_or_else(|| "unknown-conversation".into());
            let conversation_id = opaque(&["history-conversation", &config.id, &peer]);
            if !conversations.contains_key(&peer) {
                let title = labels.get(&peer).cloned().unwrap_or_else(|| {
                    if peer == "unknown-conversation" {
                        "未知会话".into()
                    } else {
                        peer.clone()
                    }
                });
                conversations.insert(peer.clone(),Conversation{id:conversation_id.clone(),title:title.clone(),time:message.create_time,body:json!({"id":conversation_id,"sourceId":config.id,"accountId":format!("history:{}",config.id),"platform":config.platform,"title":title,"kind":if peer.ends_with("@chatroom"){"group"}else{"direct"},"lastMessage":null,"lastMessageAt":timestamp(message.create_time),"unreadCount":0,"unread":false,"pinned":false,"muted":false,"readOnly":true})});
            }
            let text = message.content.text.clone();
            bytes = bytes.saturating_add(text.as_ref().map_or(0, String::len));
            if bytes > MAX_TEXT_BYTES {
                partial = true;
                break 'pages;
            }
            // The maintained reader decodes UTF-8/Zstd. Rich payloads remain inert
            // text/type hints here; no upstream XML/HTML or media URLs execute.
            let segment = if message.message_type == 1 {
                match text.clone() {
                    Some(text) => json!({"type":"text","text":text}),
                    None => {
                        partial = true;
                        json!({"type":"unknown","text":"文字内容不可解码"})
                    }
                }
            } else {
                json!({"type":"unknown","text":format!("历史消息类型 {}，此只读读取器尚未展开附件或卡片",message.message_type)})
            };
            let search_text = if message.message_type == 1 {
                text.unwrap_or_default()
            } else {
                String::new()
            };
            let id = opaque(&[
                "history-message",
                &config.id,
                &message.id.database,
                &message.id.table,
                &message.id.local_id,
            ]);
            let sender = message.sender.as_ref().map(|sender| {
                labels
                    .get(sender)
                    .cloned()
                    .unwrap_or_else(|| sender.clone())
            });
            let body = json!({"id":id,"sourceId":config.id,"conversationId":conversation_id,"accountId":format!("history:{}",config.id),"platform":config.platform,"senderName":sender,"direction":message.outgoing.map(|value|if value{"outgoing"}else{"incoming"}),"timestamp":timestamp(message.create_time),"segments":[segment],"status":"received","readOnly":true});
            messages.push(Message {
                id,
                conversation_id,
                time: message.create_time,
                search_text,
                body,
            });
        }
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    Ok(Snapshot {
        conversations: conversations.into_values().collect(),
        messages,
        partial,
    })
}
