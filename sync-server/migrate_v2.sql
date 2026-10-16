-- v2：账号＝邮箱＋主密码（端到端加密：服务器只存登录校验值的哈希和包了一层的数据密钥），每台设备单独令牌
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN salt TEXT;
ALTER TABLE users ADD COLUMN kdf TEXT;
ALTER TABLE users ADD COLUMN auth_hash TEXT;
ALTER TABLE users ADD COLUMN wrapped_key TEXT;
ALTER TABLE users ADD COLUMN recovery_hash TEXT;
ALTER TABLE users ADD COLUMN fails INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  name TEXT NOT NULL,
  device TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user);
