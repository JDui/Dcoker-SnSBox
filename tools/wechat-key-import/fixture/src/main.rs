//! Synthetic-only SQLCipher fixture producer and real wechat-profile reader check.
use std::{fs, os::unix::fs::PermissionsExt, path::Path};
use md5::{Digest, Md5};
use rusqlite::Connection;
use wechat_profile::{
    KeyFile, ListQuery, MessageQuery, ProfileLocation, ProfileReader, ReadOptions,
};

fn create(parent: &Path) -> Result<(), Box<dyn std::error::Error>> {
    // Refuse existing directories: this helper may only write new synthetic material.
    fs::create_dir(parent)?;
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    for mode in ["password", "raw"] {
        let root = parent.join(format!("synthetic-{mode}"));
        // Minimal schema follows wechat-profile 2.5.0 tests/profile.rs, fixture().
        for role in ["contact", "session", "message"] {
            let directory = root.join("db_storage").join(role);
            fs::create_dir_all(&directory)?;
            let name = if role == "message" { "message_0.db".to_string() } else { format!("{role}.db") };
            let connection = Connection::open(directory.join(name))?;
            if mode == "raw" {
                connection.execute_batch(&format!("PRAGMA key=\"x'{}'\";", "42".repeat(32)))?;
            } else {
                connection.pragma_update(None, "key", "A".repeat(32))?;
            }
            connection.execute_batch("PRAGMA cipher_compatibility=4;")?;
            match role {
                "contact" => connection.execute_batch("CREATE TABLE contact(id INTEGER PRIMARY KEY,username TEXT,nick_name TEXT,remark TEXT,alias TEXT,local_type INTEGER); INSERT INTO contact VALUES(1,'self','Synthetic Self','','',1),(2,'peer','Synthetic Peer','','',1);")?,
                "session" => connection.execute_batch("CREATE TABLE SessionTable(username TEXT PRIMARY KEY,unread_count INTEGER,is_hidden INTEGER,sort_timestamp INTEGER,last_timestamp INTEGER); INSERT INTO SessionTable VALUES('peer',0,0,1700000002,1700000002);")?,
                _ => {
                    connection.execute_batch("CREATE TABLE Name2Id(user_name TEXT PRIMARY KEY,is_session INTEGER); INSERT INTO Name2Id VALUES('self',1),('peer',1);")?;
                    let table = format!("Msg_{:x}", Md5::digest(b"peer"));
                    connection.execute_batch(&format!("CREATE TABLE {table}(local_id INTEGER PRIMARY KEY AUTOINCREMENT,server_id INTEGER,local_type INTEGER,sort_seq INTEGER,real_sender_id INTEGER,create_time INTEGER,status INTEGER,upload_status INTEGER,download_status INTEGER,server_seq INTEGER,origin_source INTEGER,source TEXT,message_content TEXT,compress_content TEXT,packed_info_data BLOB,WCDB_CT_message_content INTEGER DEFAULT NULL,WCDB_CT_source INTEGER DEFAULT NULL);"))?;
                    for index in 0..3i64 {
                        connection.execute(&format!("INSERT INTO {table}(server_id,local_type,sort_seq,real_sender_id,create_time,source,message_content,WCDB_CT_message_content,WCDB_CT_source) VALUES(?1,1,?2,2,?3,'<msgsource/>',?4,0,0)"), rusqlite::params![1000+index,1700000000000+index,1700000000+index,format!("Synthetic key conversion {mode} {index}")])?;
                    }
                }
            }
        }
        let secret = parent.join(format!("{mode}.key"));
        fs::write(&secret, if mode == "password" { "41".repeat(32) } else { "42".repeat(32) })?;
        fs::set_permissions(&secret, fs::Permissions::from_mode(0o600))?;
    }
    println!("{{\"ok\":true,\"syntheticProfiles\":2}}");
    Ok(())
}

fn verify(profile: &Path, keyfile: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let stage = |name: &'static str| move |_| { eprintln!("fixture_stage_failed={name}"); name };
    let location = ProfileLocation::new(profile).map_err(stage("location"))?;
    let keys = KeyFile::load(keyfile).map_err(stage("keyfile"))?;
    let reader = ProfileReader::open(location, keys,
        ReadOptions { stopped_or_consistent_snapshot: true, ..Default::default() }).map_err(stage("open"))?;
    let labels = reader.labels().map_err(stage("labels"))?;
    let threads = reader.threads(&ListQuery { limit: Some(200), ..Default::default() }).map_err(stage("threads"))?;
    let messages = reader.messages(&MessageQuery { limit: Some(200), ..Default::default() }).map_err(stage("messages"))?;
    if threads.items.len() != 1 || messages.items.len() != 3 || labels.is_empty() {
        eprintln!("fixture_count_mismatch threads={} messages={} labels={}", threads.items.len(), messages.items.len(), labels.len());
        return Err("synthetic reader count mismatch".into());
    }
    println!("{{\"ok\":true,\"threads\":1,\"messages\":3,\"consumer\":\"wechat-profile-2.5.0\"}}");
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let result = match args.get(1).map(String::as_str) {
        Some("create") if args.len() == 3 => create(Path::new(&args[2])),
        Some("verify") if args.len() == 4 => verify(Path::new(&args[2]), Path::new(&args[3])),
        _ => Err("usage: snsbox-key-fixture create NEW_DIR | verify PROFILE KEYFILE".into()),
    };
    // Do not format underlying errors, paths, or potentially secret SQL statements.
    if result.is_err() {
        eprintln!("{{\"ok\":false,\"code\":\"synthetic_fixture_failed\"}}");
        std::process::exit(1);
    }
}
