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
        profile_path: Some(path.into()),
        keys_file: keys,
        allow_plaintext: plain,
        confirmed_consistent_snapshot: true,
        captured_at: Some("2026-11-15T00:00:00Z".into()),
    }
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
