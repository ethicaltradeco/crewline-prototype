CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, person_id TEXT REFERENCES people(id), status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login_at TEXT);
CREATE TABLE organization_members (organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'worker', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (organization_id, user_id));
CREATE TABLE auth_codes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_seen_at TEXT);
CREATE TABLE audit_log (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), actor_user_id TEXT REFERENCES users(id), action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, old_value TEXT, new_value TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX idx_auth_codes_user ON auth_codes(user_id, created_at DESC);
CREATE INDEX idx_sessions_token ON sessions(token_hash, expires_at);
INSERT INTO users (id, email, person_id) VALUES ('u1', 'james@northline.test', 'p1');
INSERT INTO organization_members (organization_id, user_id, role) VALUES ('org1', 'u1', 'owner');
