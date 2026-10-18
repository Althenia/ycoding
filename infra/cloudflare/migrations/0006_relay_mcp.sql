CREATE TABLE IF NOT EXISTS mcp_device (
  device_id TEXT PRIMARY KEY REFERENCES device (id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  enable_epoch TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_client (
  client_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('dcr', 'cimd')),
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  auth_method TEXT NOT NULL CHECK (auth_method = 'none'),
  created_at INTEGER NOT NULL,
  first_authorized_at INTEGER
);

CREATE INDEX IF NOT EXISTS mcp_client_pending_idx ON mcp_client (created_at) WHERE first_authorized_at IS NULL;

CREATE TABLE IF NOT EXISTS mcp_authorization (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_client (client_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  client_state TEXT,
  code_challenge TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('notice', 'google', 'exchanging', 'consent')),
  google_state_hash TEXT,
  google_nonce TEXT,
  google_verifier TEXT,
  csrf_hash TEXT,
  owner_id TEXT REFERENCES "user" (id) ON DELETE CASCADE,
  enable_epoch TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consume_nonce TEXT
);

CREATE INDEX IF NOT EXISTS mcp_authorization_device_idx ON mcp_authorization (device_id);
CREATE INDEX IF NOT EXISTS mcp_authorization_expiry_idx ON mcp_authorization (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_authorization_nonce_idx ON mcp_authorization (consume_nonce) WHERE consume_nonce IS NOT NULL;

CREATE TABLE IF NOT EXISTS mcp_grant (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_client (client_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  enable_epoch TEXT NOT NULL,
  consented_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS mcp_grant_binding_idx ON mcp_grant (owner_id, device_id, client_id);
CREATE INDEX IF NOT EXISTS mcp_grant_device_idx ON mcp_grant (device_id);
CREATE INDEX IF NOT EXISTS mcp_grant_expiry_idx ON mcp_grant (expires_at);

CREATE TABLE IF NOT EXISTS mcp_code (
  code_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES mcp_grant (id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consume_nonce TEXT
);

CREATE INDEX IF NOT EXISTS mcp_code_grant_idx ON mcp_code (grant_id);
CREATE INDEX IF NOT EXISTS mcp_code_expiry_idx ON mcp_code (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_code_nonce_idx ON mcp_code (consume_nonce) WHERE consume_nonce IS NOT NULL;

CREATE TABLE IF NOT EXISTS mcp_token (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES mcp_grant (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consume_nonce TEXT,
  revoked_at INTEGER,
  rotated_to TEXT
);

CREATE INDEX IF NOT EXISTS mcp_token_grant_idx ON mcp_token (grant_id);
CREATE INDEX IF NOT EXISTS mcp_token_expiry_idx ON mcp_token (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_token_nonce_idx ON mcp_token (consume_nonce) WHERE consume_nonce IS NOT NULL;
