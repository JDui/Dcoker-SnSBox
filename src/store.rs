use anyhow::Result;
use serde_json::{Value, json};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::{path::Path, time::Duration};

pub async fn open(path: &Path) -> Result<SqlitePool> {
    let db = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(true)
                .journal_mode(SqliteJournalMode::Wal)
                .busy_timeout(Duration::from_secs(10))
                .foreign_keys(true),
        )
        .await?;
    sqlx::migrate!("./src/migrations").run(&db).await?;
    // No automatic replay: a previous process may already have submitted these commands.
    let rows = sqlx::query("SELECT id,body FROM messages WHERE status IN ('queued','submitting')")
        .fetch_all(&db)
        .await?;
    for row in rows {
        let mut body: Value = serde_json::from_str(row.get("body"))?;
        body["status"] = json!("uncertain");
        body["error"] = json!("服务重启，提交结果待确认；未自动重发");
        update_message(&db, &body).await?;
    }
    Ok(db)
}
pub async fn event_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    kind: &str,
    account: &str,
    conversation: Option<&str>,
) -> Result<()> {
    sqlx::query("INSERT INTO events(body) VALUES(?)")
        .bind(json!({"kind":kind,"accountId":account,"conversationId":conversation}).to_string())
        .execute(&mut **tx)
        .await?;
    Ok(())
}
pub async fn conversation(db: &SqlitePool, body: &Value) -> Result<()> {
    let mut tx = db.begin().await?;
    let existing: Option<String> = sqlx::query_scalar("SELECT title FROM conversations WHERE id=?")
        .bind(body["id"].as_str())
        .fetch_optional(&mut *tx)
        .await?;
    if existing.as_deref() == body["title"].as_str() {
        return Ok(());
    }
    sqlx::query("INSERT INTO conversations(id,account_id,upstream_id,kind,title,body) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=json_set(conversations.body,'$.title',json_extract(excluded.body,'$.title'))")
        .bind(body["id"].as_str()).bind(body["accountId"].as_str()).bind(body["upstreamId"].as_str()).bind(body["kind"].as_str()).bind(body["title"].as_str()).bind(body.to_string()).execute(&mut *tx).await?;
    event_tx(
        &mut tx,
        "conversation",
        body["accountId"].as_str().unwrap(),
        body["id"].as_str(),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}
pub async fn message(db: &SqlitePool, body: &Value) -> Result<()> {
    let mut tx = db.begin().await?;
    let inserted=sqlx::query("INSERT OR IGNORE INTO messages(id,conversation_id,account_id,upstream_id,timestamp,status,search_text,body) VALUES(?,?,?,?,?,?,?,?)")
        .bind(body["id"].as_str()).bind(body["conversationId"].as_str()).bind(body["accountId"].as_str()).bind(body["upstreamId"].as_str()).bind(body["timestamp"].as_str().unwrap_or("")).bind(body["status"].as_str()).bind(crate::model::search_text(&body["segments"])).bind(body.to_string()).execute(&mut *tx).await?.rows_affected();
    if inserted > 0 {
        let unread = i64::from(body["direction"] == "incoming");
        sqlx::query("UPDATE conversations SET last_at=MAX(COALESCE(last_at,''),?), body=json_set(body,'$.unreadCount',COALESCE(json_extract(body,'$.unreadCount'),0)+?, '$.lastMessage',CASE WHEN COALESCE(last_at,'')<=? THEN ? ELSE json_extract(body,'$.lastMessage') END,'$.lastMessageAt',MAX(COALESCE(last_at,''),?)) WHERE id=?")
            .bind(body["timestamp"].as_str().unwrap_or("")).bind(unread).bind(body["timestamp"].as_str().unwrap_or("")).bind(crate::model::preview(&body["segments"])).bind(body["timestamp"].as_str().unwrap_or("")).bind(body["conversationId"].as_str()).execute(&mut *tx).await?;
        event_tx(
            &mut tx,
            "message",
            body["accountId"].as_str().unwrap(),
            body["conversationId"].as_str(),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
pub async fn update_message(db: &SqlitePool, body: &Value) -> Result<()> {
    let mut tx = db.begin().await?;
    // A receive event may precede the send receipt. Keep the local outbox identity,
    // remove only the matching upstream projection, then attach its stable ID.
    if body["id"].as_str().is_some_and(|s| s.starts_with("out-")) && body["upstreamId"].is_string()
    {
        sqlx::query("DELETE FROM messages WHERE account_id=? AND conversation_id=? AND upstream_id=? AND id<>? AND id NOT IN (SELECT message_id FROM outbox)").bind(body["accountId"].as_str()).bind(body["conversationId"].as_str()).bind(body["upstreamId"].as_str()).bind(body["id"].as_str()).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE messages SET status=?,upstream_id=?,body=?,search_text=? WHERE id=?")
        .bind(body["status"].as_str())
        .bind(body["upstreamId"].as_str())
        .bind(body.to_string())
        .bind(crate::model::search_text(&body["segments"]))
        .bind(body["id"].as_str())
        .execute(&mut *tx)
        .await?;
    event_tx(
        &mut tx,
        "message",
        body["accountId"].as_str().unwrap(),
        body["conversationId"].as_str(),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn receipt_event_race_search_and_restart() {
        let path =
            std::env::temp_dir().join(format!("snsbox-store-{}.sqlite", uuid::Uuid::new_v4()));
        let db = open(&path).await.unwrap();
        let c = json!({"id":"c","accountId":"a","upstreamId":"peer","kind":"direct","title":"test","unreadCount":0});
        conversation(&db, &c).await.unwrap();
        conversation(&db, &c).await.unwrap();
        let events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM events")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(events, 1);
        let long = format!("{}needle-after-160", "x".repeat(200));
        let mut outgoing = json!({"id":"out-test","conversationId":"c","accountId":"a","upstreamId":null,"timestamp":"2026-11-15T00:00:00Z","direction":"outgoing","segments":[{"type":"text","text":long}],"status":"submitting"});
        message(&db, &outgoing).await.unwrap();
        sqlx::query(
            "INSERT INTO outbox(key,request,message_id) VALUES('key','request','out-test')",
        )
        .execute(&db)
        .await
        .unwrap();
        let mut received = outgoing.clone();
        received["id"] = json!("remote");
        received["upstreamId"] = json!("server:100");
        received["status"] = json!("received");
        message(&db, &received).await.unwrap();
        outgoing["upstreamId"] = json!("server:100");
        outgoing["status"] = json!("accepted");
        update_message(&db, &outgoing).await.unwrap();
        message(&db, &received).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1);
        let found: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM messages WHERE instr(search_text,'needle-after-160')>0",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(found, 1);
        outgoing["status"] = json!("submitting");
        update_message(&db, &outgoing).await.unwrap();
        db.close().await;
        let db = open(&path).await.unwrap();
        assert_eq!(
            body(&db, "messages", "out-test").await.unwrap().unwrap()["status"],
            "uncertain"
        );
        db.close().await;
        std::fs::remove_file(path).unwrap();
    }
}
pub async fn body(db: &SqlitePool, table: &str, id: &str) -> Result<Option<Value>> {
    assert!(matches!(table, "messages" | "conversations"));
    let value: Option<String> = sqlx::query_scalar(&format!("SELECT body FROM {table} WHERE id=?"))
        .bind(id)
        .fetch_optional(db)
        .await?;
    value
        .map(|v| serde_json::from_str(&v).map_err(Into::into))
        .transpose()
}
