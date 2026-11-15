CREATE TABLE remote_media (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, source_key TEXT NOT NULL,
 source TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
 UNIQUE(account_id,source_key)
);
