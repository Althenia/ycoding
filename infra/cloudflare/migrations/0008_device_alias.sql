ALTER TABLE device ADD COLUMN alias TEXT CHECK (alias IS NULL OR length(alias) BETWEEN 1 AND 48);
