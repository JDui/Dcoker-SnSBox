use super::*;
use wechat_profile::{
    KeyFile, MessageProjection, ProfileLocation, SqlValue, WriteOptions, apply_message_projection,
    initialize_profile,
};

fn config(id: &str, path: &Path, keys: Option<PathBuf>, plain: bool) -> SourceConfig {
    SourceConfig {
        id: id.into(),
        platform: "wechat".into(),
        display_name: "合成历史来源".into(),
        format: None,
        profile_path: Some(path.into()),
        keys_file: keys,
        allow_plaintext: plain,
        confirmed_consistent_snapshot: true,
        captured_at: Some("2026-11-15T00:00:00Z".into()),
    }
}

#[tokio::test]
async fn qq_export_import_preserves_scopes_rows_and_rejects_invalid_replacement() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("index-data");
    std::fs::create_dir(&data).unwrap();
    let export = root.path().join("qq_messages.json");
    // Fixed upstream read_recent_dicts + cli._export_qq shape. Synthetic data
    // only; source_offset intentionally collides just as the legacy export can.
    let record = json!({"ts":1700000000.0,"ts_iso":"2023-11-14T22:13:20+00:00",
        "wxid_hash":"unused-upstream-field","sender_qq":11002,"sender_name":"合成发送者",
        "content":"合成QQ搜索 <img src=x onerror=alert(1)>","msg_id":null,
        "chat_uid":"11002","chat_kind":"friend","account_id":"11001",
        "conversation_id":"11002","thread_id":"11001::11002","conversation_type":"direct",
        "is_group_chat":false,"is_self":false,"source_offset":"qq_db:11002:1700000000",
        "attachment_meta":{"path":"/never-open-private-marker","url":"http://127.0.0.1/private-marker"}});
    let mut rows = vec![record.clone(); 5];
    rows[1]["content"] = json!("合成QQ搜索 同秒第二条");
    rows[1]["sender_qq"] = json!(11001);
    rows[1]["is_self"] = json!(true);
    rows[2]["conversation_type"] = json!("group");
    rows[2]["chat_kind"] = json!("group");
    rows[2]["is_group_chat"] = json!(true);
    rows[3]["account_id"] = json!("22001");
    rows[4]["account_id"] = json!("linux_profile_identifier");
    let original = serde_json::to_vec_pretty(&rows).unwrap();
    std::fs::write(&export, &original).unwrap();
    let mut qq = config("qq-export", &export, None, false);
    qq.platform = "qq".into();
    qq.format = Some("chatlog-keeper-qq-json".into());
    let mut other = qq.clone();
    other.id = "another-export".into();
    let service = HistoryService::with_configs(&data, None, vec![qq.clone(), other])
        .await
        .unwrap();
    assert!(service.status("qq-export").await.unwrap().can_refresh);
    let status = ready(&service, "qq-export").await;
    assert_eq!(status.status, "partial");
    assert_eq!(status.message_count, Some(5));
    assert_eq!(status.conversation_count, Some(4));
    assert_eq!(status.consistency, "operator-confirmed-export");
    assert!(status.read_only && !status.send_allowed && status.can_refresh);
    let Json(page) = message_page(
        &service,
        "qq-export",
        None,
        PageQuery {
            query: Some("合成QQ搜索".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), 5);
    let ids: std::collections::BTreeSet<_> = items
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 5);
    assert!(items.iter().any(|item| item["direction"].is_null()));
    assert!(items.iter().any(|item| item["direction"] == "outgoing"));
    assert!(items.iter().any(|item| item["direction"] == "incoming"));
    assert!(!page.to_string().contains("private-marker"));
    assert_eq!(std::fs::read(&export).unwrap(), original);
    service.pool.close().await;
    let mut other = qq.clone();
    other.id = "another-export".into();
    let service = HistoryService::with_configs(&data, None, vec![qq.clone(), other])
        .await
        .unwrap();
    let restored = service.status("qq-export").await.unwrap();
    assert_eq!(restored.generation, status.generation);
    assert_eq!(restored.status, "partial");
    assert!(restored.reason.contains("正文截断") && restored.can_refresh);
    ready(&service, "another-export").await;
    assert!(
        message_page(
            &service,
            "another-export",
            items[0]["conversationId"].as_str(),
            PageQuery::default()
        )
        .await
        .is_err()
    );
    std::fs::write(&export, b"SQLite format 3\0not a JSON export").unwrap();
    service.refresh("qq-export").await.unwrap();
    for _ in 0..100 {
        if service.status("qq-export").await.unwrap().status != "refreshing" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let failed = service.status("qq-export").await.unwrap();
    assert_eq!(failed.status, "unsupported");
    assert!(failed.can_refresh);
    assert_eq!(failed.generation, status.generation);
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM history_messages WHERE source_id='qq-export'")
            .fetch_one(&service.pool)
            .await
            .unwrap();
    assert_eq!(count, 5);
    qq.confirmed_consistent_snapshot = false;
    assert_eq!(initial_status(&qq, None, &data).status, "snapshot_required");
    qq.confirmed_consistent_snapshot = true;
    assert_eq!(
        initial_status(&qq, Some(root.path()), &data).status,
        "snapshot_required"
    );
    qq.format = None;
    assert_eq!(initial_status(&qq, None, &data).status, "unsupported");
    service.pool.close().await;
}

#[test]
fn qq_export_bounds_and_ambiguous_scope_fail_closed() {
    let root = tempfile::tempdir().unwrap();
    let export = root.path().join("qq_messages.json");
    let file = std::fs::File::create(&export).unwrap();
    file.set_len(64 * 1024 * 1024 + 1).unwrap();
    drop(file);
    let mut qq = config("bounded-qq", &export, None, false);
    qq.platform = "qq".into();
    qq.format = Some("chatlog-keeper-qq-json".into());
    assert!(matches!(
        reader::read(&qq),
        Err(HistoryError(_, "history_unsupported", _))
    ));
    let mut row = json!({"account_id":"12345","conversation_id":"67890","conversation_type":"direct",
        "chat_kind":"group","ts":1700000000.0,"content":"synthetic"});
    std::fs::write(&export, serde_json::to_vec(&vec![row.clone()]).unwrap()).unwrap();
    assert!(reader::read(&qq).is_err());
    row["chat_kind"] = json!("friend");
    row["sender_qq"] = json!("not-an-integer");
    std::fs::write(&export, serde_json::to_vec(&vec![row]).unwrap()).unwrap();
    assert!(reader::read(&qq).is_err());
}
fn inject(location: &ProfileLocation, keys: &KeyFile, plain: bool) {
    for index in 0i64..3 {
        // The incoming-text helper requires an existing conversation. Allocate
        // this NEW synthetic conversation with the upstream projection helper.
        let time = 1_700_000_000 + index;
        let mut fields = BTreeMap::new();
        for (name, value) in [
            ("local_type", 1),
            ("sort_seq", time * 1000),
            ("create_time", time),
            ("status", 3),
            ("upload_status", 0),
            ("download_status", 0),
            ("server_seq", index),
            ("origin_source", 2),
            ("WCDB_CT_message_content", 0),
            ("WCDB_CT_source", 0),
        ] {
            fields.insert(name.into(), SqlValue::Integer(value.to_string()));
        }
        fields.insert("source".into(), SqlValue::Text("<msgsource/>".into()));
        fields.insert(
            "message_content".into(),
            SqlValue::Text(format!("合成历史分页搜索 {index}")),
        );
        fields.insert("compress_content".into(), SqlValue::Text(String::new()));
        apply_message_projection(
            location,
            keys,
            &MessageProjection {
                peer: "synthetic_peer".into(),
                sender: "synthetic_peer".into(),
                from: "synthetic_peer".into(),
                to: "synthetic_self".into(),
                server_message_id: (1000 + index).to_string(),
                fields,
                packed_other_fields: vec![88, 0],
            },
            &WriteOptions {
                exclusive_ownership_confirmed: true,
                allow_plaintext: plain,
                durable_intent_id: "synthetic-fixture-only".into(),
            },
        )
        .unwrap();
    }
}
fn image_tree(path: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(root: &Path, path: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, out)
            } else {
                out.insert(
                    path.strip_prefix(root).unwrap().to_path_buf(),
                    std::fs::read(path).unwrap(),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(path, path, &mut out);
    out
}
async fn ready(service: &Arc<HistoryService>, id: &str) -> SourceStatus {
    service.refresh(id).await.unwrap();
    for _ in 0..900 {
        let status = service.status(id).await.unwrap();
        if status.status != "refreshing" {
            assert!(
                matches!(status.status.as_str(), "ready" | "partial"),
                "unexpected sanitized state: {}",
                status.status
            );
            return status;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("fixture import timeout")
}
async fn plaintext(path: &Path) -> SqlitePool {
    std::fs::create_dir_all(path.join("db_storage/session")).unwrap();
    std::fs::create_dir_all(path.join("db_storage/message")).unwrap();
    let session = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path.join("db_storage/session/session.db"))
                .create_if_missing(true)
                .journal_mode(sqlx::sqlite::SqliteJournalMode::Delete),
        )
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TABLE Name2Id(user_name TEXT PRIMARY KEY);CREATE TABLE SessionTable(username TEXT PRIMARY KEY,type INTEGER,unread_count INTEGER,unread_first_msg_srv_id INTEGER,unread_first_pat_msg_local_id INTEGER,unread_first_pat_msg_sort_seq INTEGER,is_hidden INTEGER,summary TEXT,draft TEXT,status INTEGER,last_timestamp INTEGER,sort_timestamp INTEGER,last_clear_unread_timestamp INTEGER,last_msg_locald_id INTEGER,last_msg_type INTEGER,last_msg_sub_type INTEGER,last_msg_sender TEXT,last_sender_display_name TEXT,last_msg_ext_type INTEGER);CREATE TABLE SessionUnreadListTable_1(username_id INTEGER,server_id INTEGER,local_id INTEGER,create_time INTEGER,CONSTRAINT _NameId_ServerId PRIMARY KEY(username_id,server_id));").execute(&session).await.unwrap();
    session.close().await;
    let message = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path.join("db_storage/message/message_0.db"))
                .create_if_missing(true)
                .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal),
        )
        .await
        .unwrap();
    sqlx::query("CREATE TABLE Name2Id(user_name TEXT PRIMARY KEY,is_session INTEGER)")
        .execute(&message)
        .await
        .unwrap();
    message
}

#[tokio::test]
async fn compatible_encrypted_and_plain_history_are_isolated_source_preserving_and_searchable() {
    let root = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let data = root.path().join("data");
    std::fs::create_dir(&data).unwrap();
    let encrypted = root.path().join("synthetic-encrypted");
    let (location, keys, _) = initialize_profile(&encrypted, &[7; 32]).unwrap();
    inject(&location, &keys, false);
    let keys_file = root.path().join("fixture-keys.json");
    keys.write_new(&keys_file).unwrap();
    let plain = root.path().join("synthetic-plain");
    let writer = plaintext(&plain).await;
    let location = ProfileLocation::new(&plain).unwrap();
    inject(
        &location,
        &KeyFile::empty(location.account_directory()),
        true,
    );
    assert!(plain.join("db_storage/message/message_0.db-wal").exists());
    let before_encrypted = image_tree(&encrypted);
    let before_plain = image_tree(&plain);
    let configs = vec![
        config("one", &encrypted, Some(keys_file.clone()), false),
        config("two", &plain, None, true),
    ];
    let service = HistoryService::with_configs(&data, None, configs)
        .await
        .unwrap();
    let one = ready(&service, "one").await;
    let two = ready(&service, "two").await;
    assert_eq!(one.message_count, Some(3));
    assert_eq!(two.message_count, Some(3));
    let Json(first) = message_page(
        &service,
        "one",
        None,
        PageQuery {
            limit: Some(1),
            query: Some("分页搜索".into()),
            cursor: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(first["items"].as_array().unwrap().len(), 1);
    let cursor = first["nextCursor"].as_str().unwrap().to_string();
    let Json(second) = message_page(
        &service,
        "one",
        None,
        PageQuery {
            limit: Some(1),
            query: Some("分页搜索".into()),
            cursor: Some(cursor.clone()),
        },
    )
    .await
    .unwrap();
    assert_ne!(first["items"][0]["id"], second["items"][0]["id"]);
    let error = message_page(
        &service,
        "two",
        None,
        PageQuery {
            limit: Some(1),
            query: Some("分页搜索".into()),
            cursor: Some(cursor.clone()),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.1, "invalid_history_cursor");
    assert!(
        message_page(
            &service,
            "two",
            first["items"][0]["conversationId"].as_str(),
            PageQuery::default()
        )
        .await
        .is_err()
    );
    ready(&service, "one").await;
    let error = message_page(
        &service,
        "one",
        None,
        PageQuery {
            limit: Some(1),
            query: Some("分页搜索".into()),
            cursor: Some(cursor),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.1, "history_changed");
    assert_eq!(before_encrypted, image_tree(&encrypted));
    assert_eq!(before_plain, image_tree(&plain));
    let old_status = service.status("one").await.unwrap();
    sqlx::query(
        "UPDATE history_runs SET generation='synthetic-new-generation' WHERE source_id='one'",
    )
    .execute(&service.pool)
    .await
    .unwrap();
    assert_eq!(
        read_transaction(&service, &old_status).await.unwrap_err().1,
        "history_changed"
    );
    service.pool.close().await;
    // Same public ID, different private source: old index must not be restored.
    let changed =
        HistoryService::with_configs(&data, None, vec![config("one", &plain, None, true)])
            .await
            .unwrap();
    assert_eq!(changed.status("one").await.unwrap().status, "not_loaded");
    changed.pool.close().await;
    // Reject the entire self-owned data tree and active official source.
    let self_source = data.join("not-an-index");
    std::fs::create_dir(&self_source).unwrap();
    let guard = HistoryService::with_configs(
        &data,
        Some(&plain),
        vec![config("active", &plain, None, true)],
    )
    .await
    .unwrap();
    assert_eq!(
        guard.status("active").await.unwrap().status,
        "snapshot_required"
    );
    assert!(
        HistoryService::with_configs(
            &data,
            None,
            vec![config("inside-data", &self_source, None, true)]
        )
        .await
        .is_err()
    );
    let untouched = root.path().join("source-is-data");
    std::fs::create_dir(&untouched).unwrap();
    assert!(
        HistoryService::with_configs(
            &untouched,
            None,
            vec![config("same", &untouched, None, true)]
        )
        .await
        .is_err()
    );
    assert_eq!(std::fs::read_dir(&untouched).unwrap().count(), 0);
    assert!(!temporary_directory_isolated(
        Some(&std::env::temp_dir()),
        None
    ));
    assert!(
        !serde_json::to_string(&guard.status("active").await.unwrap())
            .unwrap()
            .contains(plain.to_str().unwrap())
    );
    assert_eq!(before_plain, image_tree(&plain));
    guard.pool.close().await;
    writer.close().await;
}
