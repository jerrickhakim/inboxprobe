-- One row per address. The token is never stored, only its SHA-256.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  local TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- The index of each account's mail. The message itself is in R2 at <account_id>/<id>.eml.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  from_address TEXT NOT NULL,
  from_name TEXT,
  to_address TEXT NOT NULL,
  subject TEXT,
  snippet TEXT,
  size INTEGER NOT NULL,
  attachments INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX messages_by_account ON messages (account_id, received_at DESC, id DESC);
