ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1));
ALTER TABLE conversations ADD COLUMN muted INTEGER NOT NULL DEFAULT 0 CHECK(muted IN (0,1));
UPDATE conversations SET body=json_set(body,'$.pinned',json('false'),'$.muted',json('false'),'$.unread',json(CASE WHEN COALESCE(json_extract(body,'$.unreadCount'),0)>0 THEN 'true' ELSE 'false' END));
CREATE TABLE local_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO local_state(key,value) VALUES('conversation_order_revision',0);
CREATE INDEX conversation_order ON conversations(pinned DESC,last_at DESC,id DESC);
