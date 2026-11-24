-- One calendar per address, made the first time it's used. revision counts every change to its events:
-- it's the calendar's ctag and sync token, and each event keeps the revision that last changed it.
CREATE TABLE calendars (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  color TEXT
);

-- Each event as the client (or an invite) sent it, at /dav/calendars/<local>/default/<name>. A deleted
-- event stays as a tombstone, ics and uid NULL, so a sync-collection REPORT can say it's gone.
-- summary, starts_at, ends_at and timezone are read out of the ics for GET /events.
CREATE TABLE events (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  uid TEXT,
  ics TEXT,
  etag TEXT,
  summary TEXT,
  starts_at TEXT,
  ends_at TEXT,
  timezone TEXT,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, name)
);
CREATE UNIQUE INDEX events_by_uid ON events (account_id, uid);
CREATE INDEX events_by_revision ON events (account_id, revision);
