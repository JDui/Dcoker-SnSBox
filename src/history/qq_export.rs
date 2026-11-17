//! Adapter for chatlog-keeper d2feeec's actual `qq_messages.json` export.
//! Only a completed, operator-confirmed export is read. No QQ database,
//! credential, process, network, attachment, or upstream CLI is opened here.
use super::{
    HistoryError, SourceConfig, blocked, opaque,
    reader::{Conversation, Message, Snapshot},
};
use serde::{
    Deserialize, Deserializer,
    de::{self, SeqAccess, Visitor},
};
use serde_json::json;
use std::{collections::BTreeMap, fmt, fs::File, io::Read};

const MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_MESSAGES: usize = 100_000;

#[derive(Deserialize)]
struct Record {
    account_id: String,
    #[serde(default)]
    conversation_id: Option<String>,
    #[serde(default)]
    chat_uid: Option<String>,
    #[serde(default)]
    conversation_type: Option<String>,
    #[serde(default)]
    chat_kind: Option<String>,
    #[serde(default)]
    is_group_chat: Option<bool>,
    ts: f64,
    content: String,
    #[serde(default)]
    sender_name: Option<String>,
    #[serde(default)]
    sender_qq: Option<u64>,
    #[serde(default)]
    is_self: Option<bool>,
    // Other upstream fields (including attachment paths/URLs and wxid_hash)
    // are deliberately discarded, never fetched, executed or used as IDs.
}

struct Records(Vec<Record>);
impl<'de> Deserialize<'de> for Records {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Bounded;
        impl<'de> Visitor<'de> for Bounded {
            type Value = Records;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a bounded QQ export record array")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Records, A::Error> {
                let mut rows = Vec::new();
                while let Some(row) = seq.next_element::<Record>()? {
                    if rows.len() == MAX_MESSAGES {
                        return Err(de::Error::custom("QQ export record limit exceeded"));
                    }
                    rows.push(row);
                }
                Ok(Records(rows))
            }
        }
        deserializer.deserialize_seq(Bounded)
    }
}

fn invalid() -> HistoryError {
    blocked(
        "history_unsupported",
        "QQ 导出格式不匹配、字段无效或超过限制；请使用固定版本 chatlog-keeper 的 qq_messages.json（最多 64 MiB / 10 万条）",
    )
}
fn changed() -> HistoryError {
    blocked(
        "snapshot_required",
        "QQ 导出文件在读取期间变化；请提供导出完成的独立文件",
    )
}
fn identity(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}

pub(super) fn read(config: &SourceConfig) -> Result<Snapshot, HistoryError> {
    let path = config.profile_path.as_ref().ok_or_else(invalid)?;
    let mut file = File::open(path).map_err(|_| {
        blocked(
            "history_read_failed",
            "QQ 导出文件不可读；请检查只读挂载和权限",
        )
    })?;
    let before = file.metadata().map_err(|_| invalid())?;
    if !before.is_file() || before.len() > MAX_BYTES {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| changed())?;
    let after = file.metadata().map_err(|_| changed())?;
    let current = std::fs::metadata(path).map_err(|_| changed())?;
    if bytes.len() as u64 != before.len()
        || after.len() != before.len()
        || current.len() != before.len()
        || after.modified().ok() != before.modified().ok()
        || current.modified().ok() != before.modified().ok()
    {
        return Err(changed());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if current.dev() != before.dev() || current.ino() != before.ino() {
            return Err(changed());
        }
    }
    let Records(rows) = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    drop(bytes);
    let mut conversations: BTreeMap<String, Conversation> = BTreeMap::new();
    let mut messages = Vec::with_capacity(rows.len());
    for (index, row) in rows.into_iter().enumerate() {
        let peer = row
            .conversation_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .or(row.chat_uid.as_deref())
            .ok_or_else(invalid)?;
        if !identity(&row.account_id)
            || !identity(peer)
            || row.content.len() > 64 * 1024
            || row
                .sender_name
                .as_ref()
                .is_some_and(|name| name.len() > 4096)
            || !row.ts.is_finite()
            || row.ts <= 0.0
            || row.ts >= 253_402_300_800.0
        {
            return Err(invalid());
        }
        let kind = match row.conversation_type.as_deref() {
            Some("direct") => "direct",
            Some("group") => "group",
            Some(_) => return Err(invalid()),
            None => match row.chat_kind.as_deref() {
                Some("friend") => "direct",
                Some("group") => "group",
                _ => return Err(invalid()),
            },
        };
        if row
            .chat_kind
            .as_deref()
            .is_some_and(|value| value != if kind == "group" { "group" } else { "friend" })
            || row
                .is_group_chat
                .is_some_and(|value| value != (kind == "group"))
        {
            return Err(invalid());
        }
        // A peer number can occur in both a group and a direct conversation,
        // and in exports for several accounts. Never merge those scopes.
        let conversation_id = opaque(&[
            "history-conversation",
            &config.id,
            &row.account_id,
            kind,
            peer,
        ]);
        // Legacy exports have msg_id=null and source_offset can collide within
        // one second. Retain every row; IDs are local to this export generation.
        let id = opaque(&[
            "history-message",
            &config.id,
            &row.account_id,
            kind,
            peer,
            &index.to_string(),
        ]);
        let time = row.ts as i64;
        let timestamp = chrono::DateTime::from_timestamp(time, 0)
            .ok_or_else(invalid)?
            .to_rfc3339();
        let sender = row
            .sender_name
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                row.sender_qq
                    .filter(|value| *value != 0)
                    .map(|value| value.to_string())
            });
        // The upstream CLI sets is_self=false even when the account QQ number
        // is unavailable (Linux profile hashes). False alone is not evidence
        // of an incoming message; only use resolved numeric sender/account IDs.
        let direction = if row.is_self == Some(true) {
            Some("outgoing")
        } else {
            row.account_id
                .parse::<u64>()
                .ok()
                .filter(|value| *value != 0)
                .zip(row.sender_qq.filter(|value| *value != 0))
                .map(|(account, sender)| {
                    if account == sender {
                        "outgoing"
                    } else {
                        "incoming"
                    }
                })
        };
        let segment = if row.content.is_empty() {
            json!({"type":"unknown","text":"此条导出没有可用文字；附件尚未导入"})
        } else {
            json!({"type":"text","text":row.content})
        };
        let title = format!(
            "{} {} · {}",
            if kind == "group" { "QQ群" } else { "QQ好友" },
            peer,
            row.account_id
        );
        let conversation = conversations.entry(conversation_id.clone()).or_insert_with(|| Conversation {
            id: conversation_id.clone(), title: title.clone(), time,
            body: json!({"id":conversation_id,"sourceId":config.id,"accountId":format!("history:{}",config.id),"platform":"qq","title":title,"kind":kind,"lastMessage":null,"lastMessageAt":null,"unreadCount":0,"unread":false,"pinned":false,"muted":false,"readOnly":true}),
        });
        if time >= conversation.time {
            conversation.time = time;
            conversation.body["lastMessageAt"] = json!(timestamp);
            conversation.body["lastMessage"] =
                json!(row.content.chars().take(200).collect::<String>());
        }
        messages.push(Message {
            id: id.clone(), conversation_id: conversation_id.clone(), time,
            search_text: row.content,
            body: json!({"id":id,"sourceId":config.id,"conversationId":conversation_id,"accountId":format!("history:{}",config.id),"platform":"qq","senderName":sender,"direction":direction,"timestamp":timestamp,"segments":[segment],"status":"received","readOnly":true}),
        });
    }
    Ok(Snapshot {
        conversations: conversations.into_values().collect(),
        messages,
        // Upstream read_recent_dicts limits content to 1500 characters, filters
        // by export time range, and does not deliver usable attachment bodies.
        partial: true,
    })
}
