import PostalMime from "postal-mime";
import { davRoute, eventsRoute, setupProfile } from "./calendar";
import { type Account, accountByToken, bearer, type Env, HttpError, json, limitParam, parseAddress, randomString, readJson, sameSecret, sha256 } from "./common";
import { internalRoute } from "./internal";
import { mcpRoute } from "./mcp";
import { receive, recipientAccount } from "./receive";
import {
  copyMessages,
  createAppPassword,
  createMailboxes,
  deleteAppPassword,
  mailboxById,
  mailboxByName,
  type MessageRow,
  removeMessages,
  repair,
  storeFlags,
} from "./mail";

export { parseAddress } from "./common";

// An inbox per address on one apex domain (env.DOMAIN). Email Routing's catch-all hands every
// message to email() below; the REST API in fetch() makes addresses and reads their mail.
//
//   POST   /accounts                         { name? } → { id, address, token }
//   GET    /account                          the token's address and how much mail its inbox has
//   DELETE /account                          the address, its index and every message
//   GET    /mailboxes                        its folders (INBOX, Sent, Drafts, Archive, Junk, Trash) with counts
//   GET    /messages?mailbox&limit&before&unread   newest first, INBOX unless `mailbox` says; `next` pages
//   GET    /messages/:id                     parsed: text, html, attachments; marks it read
//   GET    /messages/:id/raw                 the message as received (message/rfc822)
//   GET    /messages/:id/attachments/:n      the n-th attachment
//   POST   /messages/:id/move                { mailbox } → the message, under its new id
//   DELETE /messages/:id                     gone for good (an IMAP client sees it expunged)
//   GET    /app-passwords                    passwords for a phone's Mail and Calendar
//   POST   /app-passwords                    { name } → { id, name, password }, shown once
//   DELETE /app-passwords/:id                revokes it and ends its IMAP sessions
//   GET    /events?from&limit                the address's calendar, soonest first (calendar.ts)
//   GET    /events/:id                       one event as iCalendar
//   POST   /mcp                              a public MCP server over these routes (mcp.ts)
//
// Each address also has a CalDAV calendar under /dav/ (calendar.ts), and its mail is served over
// IMAP and SMTP by a separate service (not in this repo), which talks to /internal/* (internal.ts). Every change to
// mail goes through mail.ts, so the API and IMAP clients see the same inbox.
//
// Everything but POST /accounts takes the account's token as `Authorization: Bearer`.
// POST /accounts takes ADMIN_TOKEN that way, and is off without it.
// /admin/* (see adminRoute) takes ADMIN_TOKEN too: every inbox at once, for a person looking it all over.

/** Names nobody gets to claim: the ones mail systems and people trust to be the domain's own. */
const RESERVED = new Set([
  "abuse", "admin", "administrator", "billing", "help", "hostmaster", "info", "mailer-daemon",
  "noreply", "no-reply", "postmaster", "root", "security", "support", "webmaster",
]);
const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export default {
  fetch: respond,

  async email(message, env) {
    if (!env.DOMAIN) {
      console.error(NO_DOMAIN);
      message.setReject("This mail server isn't set up yet.");
      return;
    }
    const account = await recipientAccount(env, message.to);
    if (!account) {
      message.setReject("No such address here.");
      return;
    }
    await receive(env, account, await new Response(message.raw).arrayBuffer(), message.from, message.to);
  },
} satisfies ExportedHandler<Env>;

// The domain is configuration, never code: without the DOMAIN var, the Worker refuses to run.
const NO_DOMAIN = "Set the DOMAIN var in wrangler.jsonc to the domain addresses live on (example.com).";

async function respond(request: Request, env: Env): Promise<Response> {
  if (!env.DOMAIN) return json({ error: NO_DOMAIN }, 500);
  try {
    return await route(request, env);
  } catch (error) {
    if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status, headers: error.headers });
    console.error(error);
    return json({ error: "Something went wrong." }, 500);
  }
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method;

  if (method === "GET" && url.pathname === "/health") return json({ ok: true, domain: env.DOMAIN });

  if (parts[0] === "accounts" && parts.length === 1) {
    if (method !== "POST") throw new HttpError(405, "Use POST.");
    return createAccount(request, env);
  }

  if (parts[0] === "mcp" && parts.length === 1) {
    return mcpRoute(request, env, (path, { token, ...init } = {}) => {
      const headers = new Headers(init.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);
      return respond(new Request(new URL(path, url), { ...init, headers }), env);
    });
  }

  if (parts[0] === "admin") return adminRoute(request, url, parts.slice(1), env);
  if (parts[0] === "internal") return internalRoute(request, url, parts.slice(1), env);

  // Calendar discovery: iOS looks here first (RFC 6764), and some clients ask the root itself.
  if (url.pathname === "/.well-known/caldav") return new Response(null, { status: 301, headers: { location: "/dav/" } });
  if (parts[0] === "dav") {
    // TEMP: log what iOS asks and what it gets, while getting the iPhone working.
    const asked = await request.clone().text();
    const answer = await davRoute(request, parts.slice(1), env).catch((error) => {
      console.log("DAV", method, url.pathname, request.headers.get("depth"), asked.slice(0, 3000), "→ error", String(error));
      throw error;
    });
    console.log("DAV", method, url.pathname, request.headers.get("depth"), asked.slice(0, 3000), "→", answer.status, JSON.stringify([...answer.headers]), (await answer.clone().text()).slice(0, 3000));
    return answer;
  }
  if (method === "PROPFIND" && parts.length === 0) return davRoute(request, [], env);
  if (method === "GET" && url.pathname === "/setup.mobileconfig") return setupProfile(url, env);

  const account = await authenticate(request, env);

  if (parts[0] === "account" && parts.length === 1) {
    if (method === "GET") {
      const count = await env.DB.prepare(
        "SELECT COUNT(*) AS total, SUM(read = 0) AS unread FROM messages WHERE account_id = ? AND mailbox_id = (SELECT id FROM mailboxes WHERE account_id = ? AND name = 'INBOX')",
      )
        .bind(account.id, account.id)
        .first<{ total: number; unread: number | null }>();
      return json({
        id: account.id,
        address: `${account.local}@${env.DOMAIN}`,
        created_at: account.created_at,
        messages: count?.total ?? 0,
        unread: count?.unread ?? 0,
      });
    }
    if (method === "DELETE") {
      await deleteAccount(account, env);
      return new Response(null, { status: 204 });
    }
    throw new HttpError(405, "Use GET or DELETE.");
  }

  if (parts[0] === "mailboxes" && parts.length === 1) {
    if (method !== "GET") throw new HttpError(405, "Use GET.");
    const { results } = await env.DB.prepare(
      `SELECT b.name, b.special_use, COUNT(m.id) AS messages, COALESCE(SUM(m.read = 0), 0) AS unread
       FROM mailboxes b LEFT JOIN messages m ON m.mailbox_id = b.id
       WHERE b.account_id = ? GROUP BY b.id ORDER BY b.created_at, b.rowid`,
    )
      .bind(account.id)
      .all();
    return json({ mailboxes: results });
  }

  if (parts[0] === "messages") {
    if (parts.length === 1) {
      if (method !== "GET") throw new HttpError(405, "Use GET.");
      const mailbox = await mailboxByName(env, account.id, url.searchParams.get("mailbox") || "INBOX");
      return messagePage(url, ["mailbox_id = ?"], [mailbox.id], env, "* FROM messages", "");
    }
    const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ? AND account_id = ?").bind(parts[1], account.id).first<MessageRow>();
    if (!row) throw new HttpError(404, "No such message.");
    if (parts.length === 3 && parts[2] === "move") {
      if (method !== "POST") throw new HttpError(405, "Use POST.");
      return moveMessage(request, row, env);
    }
    return messageRoute(method, parts.slice(2), row, env, { markRead: true });
  }

  if (parts[0] === "app-passwords") {
    if (parts.length === 1 && method === "GET") {
      const { results } = await env.DB.prepare("SELECT id, name, created_at, last_used_at FROM app_passwords WHERE account_id = ? ORDER BY created_at")
        .bind(account.id)
        .all();
      return json({ app_passwords: results });
    }
    if (parts.length === 1 && method === "POST") {
      const body = await readJson(request);
      return json(await createAppPassword(env, account.id, typeof body.name === "string" ? body.name : "Device"), 201);
    }
    if (parts.length === 2 && method === "DELETE") {
      if (!(await deleteAppPassword(env, account.id, parts[1]))) throw new HttpError(404, "No such app password.");
      return new Response(null, { status: 204 });
    }
    throw new HttpError(405, "Use GET, POST or DELETE.");
  }

  if (parts[0] === "events") return eventsRoute(method, parts.slice(1), url, account, env);

  throw new HttpError(404, "Not found.");
}

/**
 * The master key's view of every inbox, for a person (or a dashboard) looking over all the mail.
 * Reading here never marks mail read: agents' `wait` counts only unread mail, and a look mustn't steal it.
 *
 *   GET    /admin/accounts?limit                       every address, with inbox counts and its latest mail
 *   DELETE /admin/accounts/:id
 *   POST   /admin/accounts/:id/app-passwords           { name } → { id, name, password }, for setting up a phone
 *   GET    /admin/messages?account&mailbox&q&unread&limit&before  mail across every inbox (or one), newest first
 *   GET    /admin/messages/:id                         parsed, as the account's own route answers it
 *   GET    /admin/messages/:id/raw | /attachments/:n
 *   DELETE /admin/messages/:id
 *   POST   /admin/repair                               files mail left without a mailbox by the pre-0003 Worker
 */
async function adminRoute(request: Request, url: URL, parts: string[], env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN) throw new HttpError(403, "Admin routes need the ADMIN_TOKEN secret set.");
  if (!(await sameSecret(bearer(request) ?? "", env.ADMIN_TOKEN))) throw new HttpError(401, "Admin routes need the admin token.");
  const method = request.method;

  if (parts[0] === "repair" && parts.length === 1) {
    if (method !== "POST") throw new HttpError(405, "Use POST.");
    return json(await repair(env));
  }

  if (parts[0] === "accounts") {
    if (parts.length === 1) {
      if (method !== "GET") throw new HttpError(405, "Use GET.");
      const { results } = await env.DB.prepare(
        `SELECT a.id, a.local, a.created_at, COUNT(m.id) AS messages, COALESCE(SUM(m.read = 0), 0) AS unread, MAX(m.received_at) AS last_received_at
         FROM accounts a
         LEFT JOIN mailboxes b ON b.account_id = a.id AND b.name = 'INBOX'
         LEFT JOIN messages m ON m.mailbox_id = b.id
         GROUP BY a.id ORDER BY COALESCE(MAX(m.received_at), a.created_at) DESC LIMIT ?`,
      )
        .bind(limitParam(url))
        .all<Account & { messages: number; unread: number; last_received_at: number | null }>();
      return json({
        accounts: results.map(({ local, ...rest }) => ({ ...rest, address: `${local}@${env.DOMAIN}` })),
      });
    }
    const account = await env.DB.prepare("SELECT id, local, created_at FROM accounts WHERE id = ?").bind(parts[1]).first<Account>();
    if (!account) throw new HttpError(404, "No such account.");
    if (parts.length === 3 && parts[2] === "app-passwords") {
      if (method !== "POST") throw new HttpError(405, "Use POST.");
      const body = await readJson(request);
      return json(await createAppPassword(env, account.id, typeof body.name === "string" ? body.name : "Device"), 201);
    }
    if (parts.length !== 2) throw new HttpError(404, "Not found.");
    if (method !== "DELETE") throw new HttpError(405, "Use DELETE.");
    await deleteAccount(account, env);
    return new Response(null, { status: 204 });
  }

  if (parts[0] === "messages") {
    if (parts.length === 1) {
      if (method !== "GET") throw new HttpError(405, "Use GET.");
      const conditions = ["m.mailbox_id IN (SELECT id FROM mailboxes WHERE name = ?)"];
      const values: (string | number)[] = [url.searchParams.get("mailbox") || "INBOX"];
      const account = url.searchParams.get("account");
      if (account) conditions.push("m.account_id = ?"), values.push(account);
      const q = url.searchParams.get("q")?.trim();
      if (q) {
        conditions.push("(m.subject LIKE ? OR m.from_address LIKE ? OR m.to_address LIKE ? OR m.snippet LIKE ?)");
        const like = `%${q.replace(/[%_]/g, "")}%`;
        values.push(like, like, like, like);
      }
      return messagePage(url, conditions, values, env, "m.*, a.local AS local FROM messages m JOIN accounts a ON a.id = m.account_id", "m.");
    }
    const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(parts[1]).first<MessageRow>();
    if (!row) throw new HttpError(404, "No such message.");
    return messageRoute(method, parts.slice(2), row, env, { markRead: false });
  }

  throw new HttpError(404, "Not found.");
}

/** One message's routes, after the caller has found the row and checked it may see it. */
async function messageRoute(method: string, rest: string[], row: MessageRow, env: Env, opts: { markRead: boolean }): Promise<Response> {
  if (rest.length === 0) {
    if (method === "DELETE") {
      await removeMessages(env, row.account_id, [row]);
      return new Response(null, { status: 204 });
    }
    if (method !== "GET") throw new HttpError(405, "Use GET or DELETE.");
    const parsed = await PostalMime.parse(await readRaw(env, row.blob));
    if (opts.markRead && !row.read) await storeFlags(env, row.account_id, { ids: [row.id] }, "add", ["\\Seen"]);
    return json({
      ...summary(row),
      read: opts.markRead || row.read === 1,
      to: parsed.to?.map((a) => a.address).filter(Boolean) ?? [row.to_address],
      cc: parsed.cc?.map((a) => a.address).filter(Boolean) ?? [],
      reply_to: parsed.replyTo?.map((a) => a.address).filter(Boolean) ?? [],
      message_id: parsed.messageId ?? null,
      in_reply_to: parsed.inReplyTo ?? null,
      date: parsed.date ?? null,
      text: parsed.text ?? null,
      html: parsed.html ?? null,
      attachments: parsed.attachments.map((a, index) => ({
        index,
        filename: a.filename,
        mime_type: a.mimeType,
        size: byteLength(a.content),
        inline: a.disposition === "inline",
      })),
    });
  }

  if (method !== "GET") throw new HttpError(405, "Use GET.");
  if (rest.length === 1 && rest[0] === "raw") {
    const object = await env.MAIL.get(row.blob);
    if (!object) throw new HttpError(404, "The message's body is missing.");
    return new Response(object.body, { headers: { "content-type": "message/rfc822" } });
  }
  if (rest.length === 2 && rest[0] === "attachments") {
    const parsed = await PostalMime.parse(await readRaw(env, row.blob));
    const attachment = parsed.attachments[Number(rest[1])];
    if (!/^\d+$/.test(rest[1]) || !attachment) throw new HttpError(404, "No such attachment.");
    const filename = (attachment.filename ?? `attachment-${rest[1]}`).replace(/["\\\r\n]/g, "_");
    return new Response(attachment.content, {
      headers: { "content-type": attachment.mimeType || "application/octet-stream", "content-disposition": `attachment; filename="${filename}"` },
    });
  }
  throw new HttpError(404, "Not found.");
}

/** Moving takes the destination's next UID, so the message comes back under a new id. */
async function moveMessage(request: Request, row: MessageRow, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (typeof body.mailbox !== "string") throw new HttpError(400, "Pass the mailbox to move it to, such as Trash.");
  const source = await mailboxById(env, row.account_id, row.mailbox_id);
  const dest = await mailboxByName(env, row.account_id, body.mailbox);
  if (dest.id === source.id) return json({ ...summary(row), mailbox: dest.name });
  const { copies } = await copyMessages(env, row.account_id, source, [row.uid], dest, true);
  return json({ ...summary(copies[0]), mailbox: dest.name });
}

async function createAccount(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN) throw new HttpError(403, "Creating an address needs the ADMIN_TOKEN secret set.");
  if (!(await sameSecret(bearer(request) ?? "", env.ADMIN_TOKEN))) throw new HttpError(401, "Creating an address needs the admin token.");

  const body = await readJson(request);
  const asked = typeof body.name === "string" ? body.name.trim().toLowerCase() : undefined;
  if (asked !== undefined && (!LOCAL_PART.test(asked) || asked.includes("..") || asked.includes("+"))) {
    throw new HttpError(400, "A name is 1–64 lowercase letters, digits, dots, dashes or underscores, starting and ending with a letter or digit.");
  }
  if (asked && RESERVED.has(asked)) throw new HttpError(409, "That name is reserved.");

  const id = crypto.randomUUID();
  const token = `mt_${randomString(32, "base64url")}`;
  // Without a name, a random one; ten characters make a collision vanishingly rare, and one retry covers it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const local = asked ?? randomString(10, "alnum");
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO accounts (id, local, token_hash, created_at) VALUES (?, ?, ?, ?)").bind(id, local, await sha256(token), Date.now()),
        ...createMailboxes(env, id),
      ]);
      return json({ id, address: `${local}@${env.DOMAIN}`, token }, 201);
    } catch (error) {
      if (!String(error).includes("UNIQUE")) throw error;
      if (asked) throw new HttpError(409, "That address is taken.");
    }
  }
  throw new HttpError(500, "Couldn't find a free address; try again.");
}

async function deleteAccount(account: Account, env: Env) {
  // The R2 objects first: if this stops halfway, the account still exists and DELETE can run again.
  let cursor: string | undefined;
  do {
    const page = await env.MAIL.list({ prefix: `${account.id}/`, cursor });
    if (page.objects.length) await env.MAIL.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await env.DB.batch(
    ["messages", "mailboxes", "mail_changes", "app_passwords", "events", "calendars"]
      .map((table) => env.DB.prepare(`DELETE FROM ${table} WHERE account_id = ?`).bind(account.id))
      .concat(env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(account.id)),
  );
}

/** A page of messages, newest first, under `conditions` plus the `before` and `unread` params. Rows with a `local` say whose inbox. */
async function messagePage(url: URL, conditions: string[], values: (string | number)[], env: Env, from: string, column: string): Promise<Response> {
  const limit = limitParam(url);
  const before = url.searchParams.get("before");
  if (before) {
    const [at, id] = before.split("_");
    if (!/^\d+$/.test(at ?? "") || !id) throw new HttpError(400, "`before` is the `next` value of an earlier page.");
    conditions.push(`(${column}received_at, ${column}id) < (?, ?)`);
    values.push(Number(at), id);
  }
  if (url.searchParams.get("unread") === "true") conditions.push(`${column}read = 0`);

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(`SELECT ${from} ${where} ORDER BY ${column}received_at DESC, ${column}id DESC LIMIT ?`)
    .bind(...values, limit + 1)
    .all<MessageRow & { local?: string }>();
  const page = results.slice(0, limit);
  const last = page.at(-1);
  return json({
    messages: page.map((row) =>
      row.local === undefined ? summary(row) : { ...summary(row), account: { id: row.account_id, address: `${row.local}@${env.DOMAIN}` } },
    ),
    next: results.length > limit && last ? `${last.received_at}_${last.id}` : null,
  });
}

async function authenticate(request: Request, env: Env): Promise<Account> {
  const token = bearer(request);
  if (!token) throw new HttpError(401, "Send the account's token as `Authorization: Bearer <token>`.");
  const account = await accountByToken(token, env);
  if (!account) throw new HttpError(401, "That token isn't valid.");
  return account;
}

function summary(row: MessageRow) {
  return {
    id: row.id,
    from: { address: row.from_address, name: row.from_name },
    to: row.to_address,
    subject: row.subject,
    snippet: row.snippet,
    size: row.size,
    attachments: row.attachments,
    received_at: row.received_at,
    read: row.read === 1,
  };
}

async function readRaw(env: Env, key: string): Promise<ArrayBuffer> {
  const object = await env.MAIL.get(key);
  if (!object) throw new HttpError(404, "The message's body is missing.");
  return object.arrayBuffer();
}

function byteLength(content: ArrayBuffer | Uint8Array | string): number {
  return typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.byteLength;
}
