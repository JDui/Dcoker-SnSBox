CREATE TABLE conversations (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, upstream_id TEXT NOT NULL,
 kind TEXT NOT NULL, title TEXT NOT NULL, last_at TEXT, body TEXT NOT NULL,
 UNIQUE(account_id,kind,upstream_id)
);
CREATE TABLE messages (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 account_id TEXT NOT NULL, upstream_id TEXT, timestamp TEXT NOT NULL,
 status TEXT NOT NULL, search_text TEXT NOT NULL, body TEXT NOT NULL
);
CREATE UNIQUE INDEX message_source ON messages(account_id,conversation_id,upstream_id) WHERE upstream_id IS NOT NULL;
CREATE INDEX message_history ON messages(conversation_id,timestamp DESC,id DESC);
CREATE TABLE outbox (key TEXT PRIMARY KEY, request TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id), upstream_ref TEXT, upstream_kind TEXT);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
CREATE TABLE media (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE checkpoints (account_id TEXT PRIMARY KEY, cursor TEXT NOT NULL);
