ALTER TABLE push_subscription ADD COLUMN agent_completed INTEGER NOT NULL DEFAULT 1 CHECK (agent_completed IN (0, 1));
ALTER TABLE push_subscription ADD COLUMN approval_requested INTEGER NOT NULL DEFAULT 1 CHECK (approval_requested IN (0, 1));
ALTER TABLE push_subscription ADD COLUMN machine_offline INTEGER NOT NULL DEFAULT 1 CHECK (machine_offline IN (0, 1));
ALTER TABLE push_subscription ADD COLUMN tested_at INTEGER;
