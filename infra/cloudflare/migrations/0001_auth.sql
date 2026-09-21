-- YCoding remote access: authentication and device metadata only.
--
-- This database never stores transcripts, message projections, streaming deltas,
-- tool output, session contents, or file contents. Session data stays on the
-- user's machine and crosses the relay only as live WebSocket frames.
--
-- Credentials are stored hashed: browser session IDs (yc_session cookie tokens),
-- enrollment code hashes, and device credential IDs (access/refresh tokens) are
-- SHA-256 hex digests of the secret the client holds. Device private keys never
-- leave the device; only the public JWK is stored.
--
-- Stored in plaintext because the protocols need them, in single-use expiring rows
-- only: oauth_transaction.nonce and code_verifier (10 minute lifetime) and
-- device_challenge.nonce (2 minute lifetime). Neither is returned to a browser or
-- logged.
--
-- Retention: a bounded sweep deletes rows 7 days after expiry (at most 500 rows
-- per table per pass), hourly by cron and at most once per hour per isolate on
-- request handling. Revoked rows keep their revoked_at marker until then.

CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS identity (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);

CREATE INDEX IF NOT EXISTS identity_user_idx ON identity (user_id);

CREATE TABLE IF NOT EXISTS browser_session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  rotated_from TEXT,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS browser_session_user_idx ON browser_session (user_id);
CREATE INDEX IF NOT EXISTS browser_session_expiry_idx ON browser_session (expires_at);

CREATE TABLE IF NOT EXISTS oauth_transaction (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_after TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  user_id TEXT REFERENCES "user" (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS oauth_transaction_expiry_idx ON oauth_transaction (expires_at);

CREATE TABLE IF NOT EXISTS device (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key_jwk TEXT NOT NULL,
  key_algorithm TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS device_user_idx ON device (user_id);

CREATE TABLE IF NOT EXISTS enrollment (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  device_id TEXT
);

CREATE INDEX IF NOT EXISTS enrollment_user_idx ON enrollment (user_id);
CREATE INDEX IF NOT EXISTS enrollment_expiry_idx ON enrollment (expires_at);

CREATE TABLE IF NOT EXISTS device_challenge (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS device_challenge_device_idx ON device_challenge (device_id);
CREATE INDEX IF NOT EXISTS device_challenge_expiry_idx ON device_challenge (expires_at);

CREATE TABLE IF NOT EXISTS device_credential (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  rotated_to TEXT
);

CREATE INDEX IF NOT EXISTS device_credential_device_idx ON device_credential (device_id);
CREATE INDEX IF NOT EXISTS device_credential_expiry_idx ON device_credential (expires_at);
