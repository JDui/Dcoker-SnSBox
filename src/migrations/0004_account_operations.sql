CREATE TABLE account_operations (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL,
 upstream_id TEXT, request_key TEXT NOT NULL UNIQUE, request TEXT NOT NULL,
 body TEXT NOT NULL, created_at TEXT NOT NULL
);
