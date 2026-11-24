-- Folders, for IMAP (the iPhone Mail app, through the Go service in mail/). Every account has the same
-- fixed set, made with the account. UIDs are numbered per mailbox from next_uid and never reused;
-- uid_validity is set once and never changes, because a mailbox is never deleted and recreated.
CREATE TABLE mailboxes (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  special_use TEXT,
  uid_validity INTEGER NOT NULL,
  next_uid INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, name)
);

-- Each message now sits in a mailbox under a UID. `read` stays the \Seen flag; `flags` holds the others,
-- space-separated (\Flagged \Answered \Draft \Deleted and keywords such as $Forwarded). `blob` is the
-- R2 key of its body, which a COPY shares, so a body is deleted only when no message points at it.
-- `append_key` makes a retried APPEND land once.
ALTER TABLE messages ADD COLUMN mailbox_id TEXT;
ALTER TABLE messages ADD COLUMN uid INTEGER;
ALTER TABLE messages ADD COLUMN flags TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN blob TEXT;
ALTER TABLE messages ADD COLUMN append_key TEXT;

INSERT INTO mailboxes (id, account_id, name, special_use, uid_validity, next_uid, created_at)
SELECT lower(hex(randomblob(16))), id, 'INBOX', NULL, CAST(strftime('%s', 'now') AS INTEGER), 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 0 FROM accounts;
INSERT INTO mailboxes (id, account_id, name, special_use, uid_validity, next_uid, created_at)
SELECT lower(hex(randomblob(16))), id, 'Sent', '\Sent', CAST(strftime('%s', 'now') AS INTEGER), 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 1 FROM accounts;
INSERT INTO mailboxes (id, account_id, name, special_use, uid_validity, next_uid, created_at)
SELECT lower(hex(randomblob(16))), id, 'Drafts', '\Drafts', CAST(strftime('%s', 'now') AS INTEGER), 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 2 FROM accounts;
INSERT INTO mailboxes (id, account_id, name, special_use, uid_validity, next_uid, created_at)
SELECT lower(hex(randomblob(16))), id, 'Archive', '\Archive', CAST(strftime('%s', 'now') AS INTEGER), 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 3 FROM accounts;
INSERT INTO mailboxes (id, account_id, name, special_use, uid_validity, next_uid, created_at)
SELECT lower(hex(randomblob(16))), id, 'Junk', '\Junk', CAST(strftime('%s', 'now') AS INTEGER), 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 4 FROM accounts;
INSERT INTO mailboxes (id, account_id, name, special_use, uid_validity, next_uid, created_at)
SELECT lower(hex(randomblob(16))), id, 'Trash', '\Trash', CAST(strftime('%s', 'now') AS INTEGER), 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 5 FROM accounts;

-- What's there now is the inbox, numbered oldest first.
UPDATE messages SET
  mailbox_id = (SELECT m.id FROM mailboxes m WHERE m.account_id = messages.account_id AND m.name = 'INBOX'),
  blob = account_id || '/' || id || '.eml',
  uid = (SELECT COUNT(*) FROM messages o WHERE o.account_id = messages.account_id AND (o.received_at, o.id) <= (messages.received_at, messages.id));
UPDATE mailboxes SET next_uid = COALESCE((SELECT MAX(uid) FROM messages WHERE mailbox_id = mailboxes.id), 0) + 1;

CREATE UNIQUE INDEX messages_by_uid ON messages (mailbox_id, uid);
CREATE INDEX messages_by_mailbox ON messages (mailbox_id, received_at DESC, id DESC);
CREATE INDEX messages_by_blob ON messages (blob);
CREATE UNIQUE INDEX messages_by_append_key ON messages (account_id, append_key);

-- Every change to an account's mail, in order: what the IMAP service replays to keep open sessions
-- current (new mail, flags set over the API, deletions). kind is add, flags, expunge or revoke (an app
-- password was deleted: `detail` is its id, and sessions signed in with it end).
CREATE TABLE mail_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  mailbox_id TEXT,
  uid INTEGER,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX mail_changes_by_account ON mail_changes (account_id, id);

-- Passwords for a device's mail and calendar, each revocable on its own. Only their SHA-256 is kept.
-- They can't use the REST API: the account token can delete the account, and a phone shouldn't hold that.
CREATE TABLE app_passwords (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX app_passwords_by_account ON app_passwords (account_id);
