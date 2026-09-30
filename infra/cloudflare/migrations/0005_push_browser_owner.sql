DROP TABLE push_subscription;

CREATE TABLE push_subscription (
  endpoint TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  browser_session_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  agent_completed INTEGER NOT NULL DEFAULT 1 CHECK (agent_completed IN (0, 1)),
  approval_requested INTEGER NOT NULL DEFAULT 1 CHECK (approval_requested IN (0, 1)),
  machine_offline INTEGER NOT NULL DEFAULT 1 CHECK (machine_offline IN (0, 1)),
  tested_at INTEGER
);

CREATE INDEX push_subscription_account_idx ON push_subscription (account_id);
CREATE UNIQUE INDEX push_subscription_browser_session_idx ON push_subscription (browser_session_id);
