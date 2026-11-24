import { bearer, type Env, HttpError, json, readJson, sameSecret } from "./common";
import { receive, recipientAccount } from "./receive";
import {
  addMessage,
  appPasswordLogin,
  copyMessages,
  expunge,
  flagsOf,
  mailboxById,
  mailboxByName,
  mailChanges,
  mailState,
  metaOf,
  storeFlags,
} from "./mail";

// The IMAP/SMTP service's view of the mail (a separate service, not in this repo). It takes INTERNAL_TOKEN, not an
// account's: the service signs a person in with an app password (POST /internal/login), then acts for
// that account. Calls are coarse, one per IMAP command, and each change goes through mail.ts.
//
//   POST /internal/login                         { username, password } → { account_id, address, credential_id }
//   GET  /internal/accounts/:id/state            every mailbox and message's metadata, and the change cursor
//   GET  /internal/accounts/:id/changes?since    what changed after the cursor (IDLE and NOOP replay these)
//   POST /internal/accounts/:id/store            { mailbox_id, uids, op: add|remove|set, flags }
//   POST /internal/accounts/:id/expunge          { mailbox_id, uids? }
//   POST /internal/accounts/:id/copy             { mailbox_id, uids, dest_id, move }
//   POST /internal/accounts/:id/append?mailbox_id|mailbox&flags&date&key   the raw message as the body
//   GET  /internal/blobs/<key>                   a message body, for a service without R2 credentials
//   GET  /internal/recipients/<address>          200 when mail to it would be taken, 404 when not (inbound SMTP's RCPT)
//   POST /internal/deliver?from&to               inbound SMTP's DATA: the raw message, filed as Email Routing would
//
// A route for an account that's gone answers 404, and the service ends that account's sessions.

const MAX_APPEND = 50 * 1024 * 1024;

export async function internalRoute(request: Request, url: URL, parts: string[], env: Env): Promise<Response> {
  if (!env.INTERNAL_TOKEN) throw new HttpError(403, "Internal routes need the INTERNAL_TOKEN secret set.");
  if (!(await sameSecret(bearer(request) ?? "", env.INTERNAL_TOKEN))) throw new HttpError(401, "Internal routes need the internal token.");
  const method = request.method;

  if (parts[0] === "login" && parts.length === 1 && method === "POST") {
    const body = await readJson(request);
    const login = await appPasswordLogin(env, String(body.username ?? ""), String(body.password ?? ""));
    if (!login) throw new HttpError(401, "Wrong address or app password.");
    return json({ account_id: login.account.id, address: `${login.account.local}@${env.DOMAIN}`, credential_id: login.credentialId });
  }

  if (parts[0] === "blobs" && parts.length > 1 && method === "GET") {
    const object = await env.MAIL.get(parts.slice(1).map(decodeURIComponent).join("/"));
    if (!object) throw new HttpError(404, "No such body.");
    return new Response(object.body, { headers: { "content-type": "message/rfc822" } });
  }

  // Inbound SMTP, for a domain whose MX points at the mail service rather than Email Routing.
  if (parts[0] === "recipients" && parts.length === 2 && method === "GET") {
    if (!(await recipientAccount(env, decodeURIComponent(parts[1])))) throw new HttpError(404, "No such address here.");
    return json({ ok: true });
  }
  if (parts[0] === "deliver" && parts.length === 1 && method === "POST") {
    const to = url.searchParams.get("to") ?? "";
    const account = await recipientAccount(env, to);
    if (!account) throw new HttpError(404, "No such address here.");
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_APPEND) throw new HttpError(413, "That message is too big.");
    await receive(env, account, raw, url.searchParams.get("from") ?? "", to);
    return json({ ok: true }, 201);
  }

  if (parts[0] !== "accounts" || parts.length !== 3) throw new HttpError(404, "Not found.");
  const accountId = parts[1];
  const exists = await env.DB.prepare("SELECT 1 FROM accounts WHERE id = ?").bind(accountId).first();
  if (!exists) throw new HttpError(404, "No such account.");

  switch (`${method} ${parts[2]}`) {
    case "GET state":
      return json(await mailState(env, accountId));

    case "GET changes": {
      const since = Number(url.searchParams.get("since") ?? 0);
      if (!Number.isInteger(since) || since < 0) throw new HttpError(400, "`since` is a cursor from state or changes.");
      return json(await mailChanges(env, accountId, since, 500));
    }

    case "POST store": {
      const body = await readJson(request);
      const op = body.op;
      if (op !== "add" && op !== "remove" && op !== "set") throw new HttpError(400, "op is add, remove or set.");
      const rows = await storeFlags(env, accountId, { mailboxId: mailboxIdOf(body), uids: uidsOf(body.uids) }, op, stringsOf(body.flags));
      return json({ messages: rows.map((row) => ({ uid: row.uid, flags: flagsOf(row) })) });
    }

    case "POST expunge": {
      const body = await readJson(request);
      const uids = await expunge(env, accountId, mailboxIdOf(body), body.uids == null ? null : uidsOf(body.uids));
      return json({ uids });
    }

    case "POST copy": {
      const body = await readJson(request);
      const source = await mailboxById(env, accountId, mailboxIdOf(body));
      const dest = await mailboxById(env, accountId, String(body.dest_id ?? ""));
      const { source: moved, copies } = await copyMessages(env, accountId, source, uidsOf(body.uids), dest, body.move === true);
      return json({
        uid_validity: dest.uid_validity,
        source_uids: moved.map((row) => row.uid),
        messages: copies.map(metaOf),
      });
    }

    case "POST append": {
      // By id from IMAP's APPEND; by name (INBOX) for what the service files itself, such as bounce notices.
      const named = url.searchParams.get("mailbox");
      const mailbox = named ? await mailboxByName(env, accountId, named) : await mailboxById(env, accountId, url.searchParams.get("mailbox_id") ?? "");
      if (Number(request.headers.get("content-length") ?? 0) > MAX_APPEND) throw new HttpError(413, "That message is too big.");
      const raw = await request.arrayBuffer();
      if (raw.byteLength > MAX_APPEND) throw new HttpError(413, "That message is too big.");
      const date = Number(url.searchParams.get("date"));
      const row = await addMessage(env, mailbox, {
        raw,
        flags: (url.searchParams.get("flags") ?? "").split(" ").filter(Boolean),
        receivedAt: Number.isFinite(date) && date > 0 ? date : undefined,
        appendKey: url.searchParams.get("key") || undefined,
      });
      return json({ uid_validity: mailbox.uid_validity, message: metaOf(row) });
    }
  }
  throw new HttpError(404, "Not found.");
}

function mailboxIdOf(body: Record<string, unknown>): string {
  if (typeof body.mailbox_id !== "string" || !body.mailbox_id) throw new HttpError(400, "Pass mailbox_id.");
  return body.mailbox_id;
}

function uidsOf(value: unknown): number[] {
  if (!Array.isArray(value) || !value.every((uid) => Number.isInteger(uid) && uid > 0)) throw new HttpError(400, "uids is a list of UIDs.");
  return value as number[];
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((flag) => typeof flag === "string")) throw new HttpError(400, "flags is a list of flags.");
  return value as string[];
}
