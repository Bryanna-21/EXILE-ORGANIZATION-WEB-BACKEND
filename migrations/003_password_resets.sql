CREATE TABLE password_resets(id INTEGER PRIMARY KEY,admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,code_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,used INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE INDEX ix_pr_admin ON password_resets(admin_id,created_at);
