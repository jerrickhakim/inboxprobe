import PostalMime, { type Email } from "postal-mime";
import { type Account, type Env, HttpError, randomString, sha256 } from "./common";

// The one way mail changes. New mail, the REST API and the IMAP service (through /internal/*) all
// add, flag, copy, move and delete messages here, so every change takes its UIDs from the same
// counters and lands in mail_changes, which the IMAP service replays to keep open sessions current.
//
// D1 and R2 can't commit together, so a body is written to R2 before its row, and deleted after
// the last row pointing at it: a failure leaves an unreferenced body at worst, never a row without one.

/** Every account's folders, in the order clients list them, with each one's SPECIAL-USE attribute. */
export const MAILBOXES: [name: string, specialUse: string | null][] = [
  ["INBOX", null],
  ["Sent", "\\Sent"],
  ["Drafts", "\\Drafts"],
  ["Archive", "\\Archive"],
  ["Junk", "\\Junk"],
  ["Trash", "\\Trash"],
];

export type Mailbox = { id: string; account_id: string; name: string; special_use: string | null; uid_validity: number; next_uid: number };

export type MessageRow = {
  id: string;
  account_id: string;
  mailbox_id: string;
  uid: number;
  from_address: string;
  from_name: string | null;
  to_address: string;
  subject: string | null;
  snippet: string | null;
  size: number;
  attachments: number;
  received_at: number;
  read: number;
  flags: string;
  blob: string;
};

/** What the IMAP service keeps of a message. */
export type MessageMeta = { uid: number; flags: string[]; size: number; date: number; blob: string };

/** Statements making an account's folders (any it lacks). UIDVALIDITY is the creation time in seconds, as many servers use. */
export function createMailboxes(env: Env, accountId: string): D1PreparedStatement[] {
  const now = Date.now();
  return MAILBOXES.map(([name, specialUse], i) =>
    env.DB.prepare("INSERT OR IGNORE INTO mailboxes (id, account_id, name, special_use, uid_validity, next_uid, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)").bind(
      crypto.randomUUID(),
      accountId,
      name,
      specialUse,
      Math.floor(now / 1000),
      now + i,
    ),
  );
}

/** The account's INBOX, making its folders first if it has none (an address made before they existed). */
export async function inbox(env: Env, accountId: string): Promise<Mailbox> {
  const found = await env.DB.prepare("SELECT * FROM mailboxes WHERE account_id = ? AND name = 'INBOX'").bind(accountId).first<Mailbox>();
  if (found) return found;
  await env.DB.batch(createMailboxes(env, accountId));
  return mailboxByName(env, accountId, "INBOX");
}

/**
 * Gives every account its folders, and files messages with no mailbox (written by the Worker of
 * before 0003_mailboxes, between that migration and the deploy) into the inbox under new UIDs.
 * POST /admin/repair runs it; it's safe to run again.
 */
export async function repair(env: Env): Promise<{ accounts: number; messages: number }> {
  const { results: bare } = await env.DB.prepare("SELECT id FROM accounts a WHERE NOT EXISTS (SELECT 1 FROM mailboxes b WHERE b.account_id = a.id)").all<{ id: string }>();
  for (const { id } of bare) await env.DB.batch(createMailboxes(env, id));
  const { results: strays } = await env.DB.prepare("SELECT id, account_id FROM messages WHERE mailbox_id IS NULL ORDER BY received_at, id").all<{ id: string; account_id: string }>();
  for (const stray of strays) {
    const box = await inbox(env, stray.account_id);
    await env.DB.batch([
      env.DB.prepare("UPDATE mailboxes SET next_uid = next_uid + 1 WHERE id = ?").bind(box.id),
      env.DB.prepare("UPDATE messages SET mailbox_id = ?, uid = (SELECT next_uid - 1 FROM mailboxes WHERE id = ?), blob = account_id || '/' || id || '.eml' WHERE id = ?").bind(
        box.id,
        box.id,
        stray.id,
      ),
      change(env, stray.account_id, "add", box.id, null),
    ]);
  }
  return { accounts: bare.length, messages: strays.length };
}

export async function mailboxByName(env: Env, accountId: string, name: string): Promise<Mailbox> {
  // INBOX is case-insensitive (RFC 3501 5.1); the other names are matched as given.
  const mailbox = await env.DB.prepare("SELECT * FROM mailboxes WHERE account_id = ? AND (name = ? OR (name = 'INBOX' AND upper(?) = 'INBOX'))")
    .bind(accountId, name, name)
    .first<Mailbox>();
  if (!mailbox) throw new HttpError(404, `No mailbox called ${name}.`);
  return mailbox;
}

export async function mailboxById(env: Env, accountId: string, id: string): Promise<Mailbox> {
  const mailbox = await env.DB.prepare("SELECT * FROM mailboxes WHERE account_id = ? AND id = ?").bind(accountId, id).first<Mailbox>();
  if (!mailbox) throw new HttpError(404, "No such mailbox.");
  return mailbox;
}

// ── Flags ─────────────────────────────────────────────────────────────────────────────────────

const SYSTEM_FLAGS: Record<string, string> = {
  "\\seen": "\\Seen",
  "\\answered": "\\Answered",
  "\\flagged": "\\Flagged",
  "\\deleted": "\\Deleted",
  "\\draft": "\\Draft",
};

/** \Recent is the server's to set, and we never set it. Flags are case-insensitive; system flags keep their usual case. */
function canonicalFlags(flags: string[]): string[] {
  const seen = new Map<string, string>();
  for (const flag of flags) {
    const key = flag.toLowerCase();
    if (!flag || key === "\\recent" || /[\s()"{}\]%*\\]/.test(flag.slice(key.startsWith("\\") ? 1 : 0))) continue;
    seen.set(key, SYSTEM_FLAGS[key] ?? flag);
  }
  return [...seen.values()];
}

export function flagsOf(row: Pick<MessageRow, "read" | "flags">): string[] {
  return [...(row.read ? ["\\Seen"] : []), ...row.flags.split(" ").filter(Boolean)];
}

function columnsOf(flags: string[]): { read: number; flags: string } {
  const list = canonicalFlags(flags);
  return { read: list.includes("\\Seen") ? 1 : 0, flags: list.filter((flag) => flag !== "\\Seen").join(" ") };
}

export function metaOf(row: Pick<MessageRow, "uid" | "read" | "flags" | "size" | "received_at" | "blob">): MessageMeta {
  return { uid: row.uid, flags: flagsOf(row), size: row.size, date: row.received_at, blob: row.blob };
}

// ── Adding ────────────────────────────────────────────────────────────────────────────────────

type NewMessage = {
  raw: ArrayBuffer;
  parsed?: Email;
  flags?: string[];
  receivedAt?: number;
  /** The SMTP envelope, for mail from outside; an APPENDed message takes them from its headers. */
  envelopeFrom?: string;
  envelopeTo?: string;
  /** Makes a retried APPEND land once. */
  appendKey?: string;
};

/** Stores a message in a mailbox under the mailbox's next UID. */
export async function addMessage(env: Env, mailbox: Mailbox, message: NewMessage): Promise<MessageRow> {
  const accountId = mailbox.account_id;
  if (message.appendKey) {
    const existing = await env.DB.prepare("SELECT * FROM messages WHERE account_id = ? AND append_key = ?").bind(accountId, message.appendKey).first<MessageRow>();
    if (existing) return existing;
  }

  const parsed = message.parsed ?? (await PostalMime.parse(message.raw));
  const id = messageId();
  const blob = `${accountId}/${id}.eml`;
  const { read, flags } = columnsOf(message.flags ?? []);
  await env.MAIL.put(blob, message.raw, { httpMetadata: { contentType: "message/rfc822" } });

  try {
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE mailboxes SET next_uid = next_uid + 1 WHERE id = ?").bind(mailbox.id),
      env.DB.prepare(
        `INSERT INTO messages (id, account_id, mailbox_id, uid, from_address, from_name, to_address, subject, snippet, size, attachments, received_at, read, flags, blob, append_key)
         VALUES (?, ?, ?, (SELECT next_uid - 1 FROM mailboxes WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        accountId,
        mailbox.id,
        mailbox.id,
        (message.envelopeFrom ?? parsed.from?.address ?? "").toLowerCase(),
        parsed.from?.name || null,
        (message.envelopeTo ?? parsed.to?.[0]?.address ?? "").toLowerCase(),
        parsed.subject ?? null,
        snippet(parsed),
        message.raw.byteLength,
        parsed.attachments.length,
        message.receivedAt ?? Date.now(),
        read,
        flags,
        blob,
        message.appendKey ?? null,
      ),
      change(env, accountId, "add", mailbox.id, null),
      env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id),
    ]);
    return (results[3].results as MessageRow[])[0];
  } catch (error) {
    await env.MAIL.delete(blob);
    // Two tries of the same APPEND at once: the other one landed.
    if (message.appendKey && String(error).includes("UNIQUE")) {
      const existing = await env.DB.prepare("SELECT * FROM messages WHERE account_id = ? AND append_key = ?").bind(accountId, message.appendKey).first<MessageRow>();
      if (existing) return existing;
    }
    throw error;
  }
}

/** A change row. With uid null it records the UID a statement just before it in the batch took. */
function change(env: Env, accountId: string, kind: "add" | "flags" | "expunge" | "revoke", mailboxId: string | null, uid: number | null, detail: string | null = null) {
  if (uid === null && mailboxId) {
    return env.DB.prepare(
      "INSERT INTO mail_changes (account_id, kind, mailbox_id, uid, detail, created_at) VALUES (?, ?, ?, (SELECT next_uid - 1 FROM mailboxes WHERE id = ?), ?, ?)",
    ).bind(accountId, kind, mailboxId, mailboxId, detail, Date.now());
  }
  return env.DB.prepare("INSERT INTO mail_changes (account_id, kind, mailbox_id, uid, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
    accountId,
    kind,
    mailboxId,
    uid,
    detail,
    Date.now(),
  );
}

// ── Changing ──────────────────────────────────────────────────────────────────────────────────

/** Rows of a mailbox by UID (or of an account by id), in UID order. D1 takes at most 100 bound values a query. */
async function rowsWhere(env: Env, accountId: string, where: { mailboxId: string; uids: number[] } | { ids: string[] }): Promise<MessageRow[]> {
  const keys: (string | number)[] = "ids" in where ? where.ids : where.uids;
  const rows: MessageRow[] = [];
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    const marks = chunk.map(() => "?").join(", ");
    const { results } =
      "ids" in where
        ? await env.DB.prepare(`SELECT * FROM messages WHERE account_id = ? AND id IN (${marks})`).bind(accountId, ...chunk).all<MessageRow>()
        : await env.DB.prepare(`SELECT * FROM messages WHERE account_id = ? AND mailbox_id = ? AND uid IN (${marks})`).bind(accountId, where.mailboxId, ...chunk).all<MessageRow>();
    rows.push(...results);
  }
  return rows.sort((a, b) => a.uid - b.uid);
}

async function runChunked(env: Env, statements: D1PreparedStatement[], size = 50) {
  for (let i = 0; i < statements.length; i += size) await env.DB.batch(statements.slice(i, i + size));
}

/** STORE: adds, removes or sets flags. Returns every message it matched with its flags now. */
export async function storeFlags(
  env: Env,
  accountId: string,
  where: { mailboxId: string; uids: number[] } | { ids: string[] },
  op: "add" | "remove" | "set",
  flags: string[],
): Promise<MessageRow[]> {
  const rows = await rowsWhere(env, accountId, where);
  const given = canonicalFlags(flags).map((flag) => flag.toLowerCase());
  const statements: D1PreparedStatement[] = [];
  for (const row of rows) {
    const current = flagsOf(row);
    const next =
      op === "set" ? flags : op === "add" ? [...current, ...flags] : current.filter((flag) => !given.includes(flag.toLowerCase()));
    const columns = columnsOf(next);
    if (columns.read === row.read && columns.flags === row.flags) continue;
    Object.assign(row, columns);
    statements.push(
      env.DB.prepare("UPDATE messages SET read = ?, flags = ? WHERE id = ?").bind(columns.read, columns.flags, row.id),
      change(env, accountId, "flags", row.mailbox_id, row.uid),
    );
  }
  await runChunked(env, statements);
  return rows;
}

/** EXPUNGE: deletes the mailbox's messages flagged \Deleted (only those among `uids`, for UID EXPUNGE). */
export async function expunge(env: Env, accountId: string, mailboxId: string, uids: number[] | null): Promise<number[]> {
  const { results } = await env.DB.prepare("SELECT * FROM messages WHERE account_id = ? AND mailbox_id = ? AND (' ' || flags || ' ') LIKE '% \\Deleted %'")
    .bind(accountId, mailboxId)
    .all<MessageRow>();
  const wanted = uids && new Set(uids);
  const rows = results.filter((row) => !wanted || wanted.has(row.uid)).sort((a, b) => a.uid - b.uid);
  await removeMessages(env, accountId, rows);
  return rows.map((row) => row.uid);
}

/** Deletes messages for good, whatever their flags: the REST API's DELETE, and EXPUNGE once it has picked them. */
export async function removeMessages(env: Env, accountId: string, rows: Pick<MessageRow, "id" | "mailbox_id" | "uid" | "blob">[]) {
  if (!rows.length) return;
  await runChunked(
    env,
    rows.flatMap((row) => [env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(row.id), change(env, accountId, "expunge", row.mailbox_id, row.uid)]),
  );
  await collectBlobs(env, [...new Set(rows.map((row) => row.blob))]);
}

/** Deletes the bodies no message points at any more. */
async function collectBlobs(env: Env, blobs: string[]) {
  for (let i = 0; i < blobs.length; i += 90) {
    const chunk = blobs.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT DISTINCT blob FROM messages WHERE blob IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk)
      .all<{ blob: string }>();
    const kept = new Set(results.map((row) => row.blob));
    const gone = chunk.filter((blob) => !kept.has(blob));
    if (gone.length) await env.MAIL.delete(gone);
  }
}

/**
 * COPY and MOVE: each message gets the destination's next UID, keeping its flags and sharing its body.
 * A MOVE removes the source in the same transaction as the copy, ten messages at a time.
 */
export async function copyMessages(
  env: Env,
  accountId: string,
  source: Mailbox,
  uids: number[],
  dest: Mailbox,
  move: boolean,
): Promise<{ source: MessageRow[]; copies: MessageRow[] }> {
  if (source.id === dest.id) throw new HttpError(400, "The source and destination are the same mailbox.");
  const rows = await rowsWhere(env, accountId, { mailboxId: source.id, uids });
  const ids = rows.map(() => messageId());
  for (let i = 0; i < rows.length; i += 10) {
    const statements = rows.slice(i, i + 10).flatMap((row, j) => {
      const copy = [
        env.DB.prepare("UPDATE mailboxes SET next_uid = next_uid + 1 WHERE id = ?").bind(dest.id),
        env.DB.prepare(
          `INSERT INTO messages (id, account_id, mailbox_id, uid, from_address, from_name, to_address, subject, snippet, size, attachments, received_at, read, flags, blob)
           SELECT ?, account_id, ?, (SELECT next_uid - 1 FROM mailboxes WHERE id = ?), from_address, from_name, to_address, subject, snippet, size, attachments, received_at, read, flags, blob
           FROM messages WHERE id = ?`,
        ).bind(ids[i + j], dest.id, dest.id, row.id),
        change(env, accountId, "add", dest.id, null),
      ];
      if (move) copy.push(env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(row.id), change(env, accountId, "expunge", source.id, row.uid));
      return copy;
    });
    await env.DB.batch(statements);
  }
  const copies = await rowsWhere(env, accountId, { ids });
  return { source: rows, copies: ids.map((id) => copies.find((row) => row.id === id)!) };
}

// ── For the IMAP service ──────────────────────────────────────────────────────────────────────

/** Every mailbox with every message's metadata, and the change cursor they're current to: one consistent read. */
export async function mailState(env: Env, accountId: string) {
  const [cursor, mailboxes, messages] = await env.DB.batch([
    env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS cursor FROM mail_changes WHERE account_id = ?").bind(accountId),
    env.DB.prepare("SELECT * FROM mailboxes WHERE account_id = ? ORDER BY created_at, rowid").bind(accountId),
    env.DB.prepare("SELECT mailbox_id, uid, read, flags, size, received_at, blob FROM messages WHERE account_id = ? ORDER BY mailbox_id, uid").bind(accountId),
  ]);
  const byMailbox = new Map<string, MessageMeta[]>();
  for (const row of messages.results as (MessageRow & { mailbox_id: string })[]) {
    const list = byMailbox.get(row.mailbox_id) ?? [];
    list.push(metaOf(row));
    byMailbox.set(row.mailbox_id, list);
  }
  return {
    cursor: (cursor.results[0] as { cursor: number }).cursor,
    mailboxes: (mailboxes.results as Mailbox[]).map((mailbox) => ({
      ...mailboxJson(mailbox),
      messages: byMailbox.get(mailbox.id) ?? [],
    })),
  };
}

export function mailboxJson(mailbox: Mailbox) {
  return { id: mailbox.id, name: mailbox.name, special_use: mailbox.special_use, uid_validity: mailbox.uid_validity, uid_next: mailbox.next_uid };
}

/** Changes after `since`, each with its message as it is now (null once it's gone). */
export async function mailChanges(env: Env, accountId: string, since: number, limit: number) {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.kind, c.mailbox_id, c.uid, c.detail, m.read, m.flags, m.size, m.received_at, m.blob
     FROM mail_changes c LEFT JOIN messages m ON m.mailbox_id = c.mailbox_id AND m.uid = c.uid
     WHERE c.account_id = ? AND c.id > ? ORDER BY c.id LIMIT ?`,
  )
    .bind(accountId, since, limit + 1)
    .all<{ id: number; kind: string; mailbox_id: string | null; uid: number | null; detail: string | null } & Partial<MessageRow>>();
  const page = results.slice(0, limit);
  return {
    changes: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      mailbox_id: row.mailbox_id,
      uid: row.uid,
      detail: row.detail,
      message: row.blob ? metaOf(row as MessageRow) : null,
    })),
    cursor: page.at(-1)?.id ?? since,
    more: results.length > limit,
  };
}

// ── App passwords ─────────────────────────────────────────────────────────────────────────────

/** Four groups of four letters (75 bits), easy to type on a phone: abcd-efgh-ijkl-mnop. */
export async function createAppPassword(env: Env, accountId: string, name: string) {
  const letters = randomString(16, "lower");
  const password = letters.match(/.{4}/g)!.join("-");
  const row = { id: crypto.randomUUID(), name: name.slice(0, 100) || "Device", created_at: Date.now() };
  await env.DB.prepare("INSERT INTO app_passwords (id, account_id, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(row.id, accountId, row.name, await sha256(letters), row.created_at)
    .run();
  return { ...row, password };
}

/** The account an address and app password sign in to, and which password it was; null when they don't match. */
export async function appPasswordLogin(env: Env, user: string, password: string): Promise<{ account: Account; credentialId: string } | null> {
  const letters = password.toLowerCase().replace(/[\s-]/g, "");
  if (!/^[a-z]{16}$/.test(letters)) return null;
  const row = await env.DB.prepare(
    "SELECT a.id, a.local, a.created_at, p.id AS credential_id FROM app_passwords p JOIN accounts a ON a.id = p.account_id WHERE p.password_hash = ?",
  )
    .bind(await sha256(letters))
    .first<Account & { credential_id: string }>();
  // The username is the address, or just its local part.
  const name = user.trim().toLowerCase();
  const at = name.lastIndexOf("@");
  const local = at < 0 ? name : name.slice(0, at);
  if (!row || local !== row.local || (at >= 0 && name.slice(at + 1) !== env.DOMAIN.toLowerCase())) return null;
  await env.DB.prepare("UPDATE app_passwords SET last_used_at = ? WHERE id = ?").bind(Date.now(), row.credential_id).run();
  return { account: { id: row.id, local: row.local, created_at: row.created_at }, credentialId: row.credential_id };
}

/** Deletes an app password, and tells the IMAP service to end the sessions signed in with it. */
export async function deleteAppPassword(env: Env, accountId: string, id: string): Promise<boolean> {
  const [deleted] = await env.DB.batch([
    env.DB.prepare("DELETE FROM app_passwords WHERE id = ? AND account_id = ?").bind(id, accountId),
    change(env, accountId, "revoke", null, null, id),
  ]);
  return (deleted.meta.changes ?? 0) > 0;
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────

/** Sortable by time, then random: received_at orders the list, this only breaks ties. */
export function messageId(): string {
  return `${Date.now().toString(36)}${randomString(8, "alnum")}`;
}

export function snippet(email: Email): string | null {
  const text = email.text ?? email.html?.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]+>/gi, " ");
  const flat = text?.replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, 200) : null;
}
