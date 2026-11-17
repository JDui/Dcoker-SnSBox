//! Bounded search-hit context in the existing source/generation transaction.
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ContextQuery {
    generation: String,
    limit: Option<usize>,
}

pub(super) async fn context(
    State(service): State<Arc<HistoryService>>,
    HttpPath((source, conversation, message)): HttpPath<(String, String, String)>,
    Query(query): Query<ContextQuery>,
) -> Result<Json<Value>> {
    let status = service.status(&source).await?;
    if !matches!(status.status.as_str(), "ready" | "partial" | "refreshing")
        || status.generation.is_none()
    {
        return Err(unavailable());
    }
    if status.generation.as_deref() != Some(query.generation.as_str()) {
        return Err(changed());
    }
    let kind = format!("messages:{conversation}");
    let (limit, _, _) = pagination(
        &PageQuery {
            limit: query.limit,
            ..Default::default()
        },
        &status,
        &kind,
    )?;
    let mut tx = read_transaction(&service, &status).await?;
    let time: Option<i64> = sqlx::query_scalar(
        "SELECT time FROM history_messages WHERE source_id=? AND generation=? AND conversation_id=? AND id=?",
    )
    .bind(&source).bind(&status.generation).bind(&conversation).bind(&message)
    .fetch_optional(&mut *tx).await?;
    let time = time.ok_or_else(missing)?;
    let rank: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM history_messages WHERE source_id=? AND generation=? AND conversation_id=? AND (time>? OR (time=? AND id>?))",
    )
    .bind(&source).bind(&status.generation).bind(&conversation).bind(time).bind(time).bind(&message)
    .fetch_one(&mut *tx).await?;
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM history_messages WHERE source_id=? AND generation=? AND conversation_id=?",
    )
    .bind(&source).bind(&status.generation).bind(&conversation)
    .fetch_one(&mut *tx).await?;
    let offset = (rank - limit / 2).max(0).min((total - limit).max(0));
    let rows = sqlx::query(
        "SELECT body FROM history_messages WHERE source_id=? AND generation=? AND conversation_id=? ORDER BY time DESC,id DESC LIMIT ? OFFSET ?",
    )
    .bind(&source).bind(&status.generation).bind(&conversation).bind(limit + 1).bind(offset)
    .fetch_all(&mut *tx).await?;
    tx.commit().await?;
    let items = rows
        .into_iter()
        .map(|row| serde_json::from_str(row.get("body")).map_err(|_| unavailable()))
        .collect::<Result<Vec<Value>>>()?;
    let mut response = page(items, limit, offset, &status, &kind, "");
    response["anchorMessageId"] = json!(message);
    response["hasNewer"] = json!(offset > 0);
    Ok(Json(response))
}
