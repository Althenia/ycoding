ALTER TABLE push_subscription ADD COLUMN quota_pace INTEGER NOT NULL DEFAULT 1 CHECK (quota_pace IN (0, 1));
