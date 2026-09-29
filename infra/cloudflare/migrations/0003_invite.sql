-- YCoding remote invite metadata only: no transcript, session content, or tool output.
-- Invite and access-key secrets are stored only as SHA-256 hex hashes; neither is
-- logged or retained in plaintext. Invites do not expire or enter the expiry sweep.
-- Deleting a redeemed invite deletes its independent user account; dependent
-- browser sessions, devices, credentials, enrollments, and pushes cascade away.

CREATE TABLE invite (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  user_id TEXT UNIQUE REFERENCES "user" (id),
  key_hash TEXT UNIQUE
);
