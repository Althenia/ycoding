CREATE TABLE IF NOT EXISTS push_subscription (
  endpoint TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS push_subscription_account_idx ON push_subscription (account_id);
