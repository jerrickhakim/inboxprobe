import type { Email } from "postal-mime";
import { type Account, accountByToken, bearer, type Env, HttpError, json, limitParam, parseAddress, sha256 } from "./common";
import { appPasswordLogin } from "./mail";

// A calendar for every address, over CalDAV (RFC 4791), so the iPhone's Calendar app syncs it. iOS finds
// the server from the address (the _caldavs._tcp SRV record, then /.well-known/caldav), signs in over Basic
// auth with the address and its token, and walks principal → calendar home → calendar:
//
//   /dav/                                     where discovery lands: who's signed in
//   /dav/principals/<local>/                  the account: its calendar home and email address
//   /dav/calendars/<local>/                   the calendar home, holding the one calendar
//   /dav/calendars/<local>/default/           the calendar: PROPFIND, PROPPATCH, REPORT
//   /dav/calendars/<local>/default/<name>     one event: GET, PUT, DELETE, PROPFIND
//
// /setup.mobileconfig?address= is a profile that adds the account in one tap. Invites mailed to the
// address land in the same calendar (addInvites), and GET /events lists it as JSON for agents.
// Scheduling (sending invites, replying to them) isn't here: iOS sees no outbox and doesn't try.

const DAV = "DAV:";
const CALDAV = "urn:ietf:params:xml:ns:caldav";
const CS = "http://calendarserver.org/ns/";
const ICAL = "http://apple.com/ns/ical/";
const PREFIXES: Record<string, string> = { [DAV]: "d", [CALDAV]: "c", [CS]: "cs", [ICAL]: "ic" };

const CALENDAR = "default";
const CALENDAR_DATA = `{${CALDAV}}calendar-data`;
const SYNC_TOKEN = "urn:email-server:sync:";
const MAX_BODY = 1024 * 1024;
const DAV_HEADERS = { DAV: "1, 3, calendar-access", Allow: "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT" };

type Calendar = { account_id: string; revision: number; name: string | null; color: string | null };

type EventRow = {
  name: string;
  uid: string | null;
  ics: string | null;
  etag: string | null;
  summary: string | null;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string | null;
  revision: number;
  updated_at: number;
};

/** Each property's value as XML, keyed in Clark notation: `{DAV:}displayname`. */
type Props = Record<string, string>;

type Paths = { root: string; principal: string; home: string; calendar: string };

export async function davRoute(request: Request, parts: string[], env: Env): Promise<Response> {
  const method = request.method;
  if (method === "OPTIONS") return new Response(null, { headers: DAV_HEADERS });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) throw new HttpError(413, "That's too big.");

  const account = await davAccount(request, env);
  const paths = pathsOf(account);
  const segments = parts.map(decodeSegment);

  if (segments.length === 0) {
    if (method !== "PROPFIND") throw new HttpError(405, "Use PROPFIND.");
    return multistatus(response(paths.root, rootProps(paths), await requestedProps(request)));
  }

  const [kind, owner, ...rest] = segments;
  if ((kind !== "principals" && kind !== "calendars") || !owner) throw new HttpError(404, "Not found.");
  if (owner !== account.local) throw new HttpError(403, "That's another address's.");

  if (kind === "principals") {
    if (rest.length) throw new HttpError(404, "Not found.");
    if (method !== "PROPFIND") throw new HttpError(405, "Use PROPFIND.");
    return multistatus(response(paths.principal, principalProps(account, paths, env), await requestedProps(request)));
  }

  if (rest.length === 0) {
    if (method !== "PROPFIND") throw new HttpError(405, "Use PROPFIND.");
    const wanted = await requestedProps(request);
    let body = response(paths.home, homeProps(paths), wanted);
    if (depth(request) > 0) body += response(paths.calendar, calendarProps(await calendarOf(account.id, env), paths), wanted);
    return multistatus(body);
  }

  if (rest[0] !== CALENDAR) {
    if (method === "MKCALENDAR" || method === "MKCOL") throw new HttpError(403, "Each address has one calendar.");
    throw new HttpError(404, "Not found.");
  }

  if (rest.length === 1) {
    const calendar = await calendarOf(account.id, env);
    if (method === "PROPFIND") {
      const wanted = await requestedProps(request);
      let body = response(paths.calendar, calendarProps(calendar, paths), wanted);
      if (depth(request) > 0) for (const row of await liveEvents(account.id, env)) body += response(eventPath(paths, row.name), eventProps(row), wanted);
      return multistatus(body);
    }
    if (method === "PROPPATCH") return proppatch(request, calendar, paths, env);
    if (method === "REPORT") return report(request, calendar, paths, env);
    if (method === "MKCALENDAR" || method === "MKCOL") throw new HttpError(405, "The calendar already exists.");
    throw new HttpError(405, "Use PROPFIND, PROPPATCH or REPORT.");
  }

  if (rest.length === 2) return eventRoute(request, rest[1], account, paths, env);
  throw new HttpError(404, "Not found.");
}

/** Basic auth with the address (or its local part) and an app password or its token; a bare Bearer token works too, for scripts. */
async function davAccount(request: Request, env: Env): Promise<Account> {
  const challenge = { "www-authenticate": `Basic realm="${env.DOMAIN}", charset="UTF-8"` };
  const basic = request.headers.get("authorization")?.match(/^Basic\s+(\S+)$/i);
  let user: string | null = null;
  let password = bearer(request);
  if (basic) {
    try {
      const decoded = new TextDecoder().decode(Uint8Array.from(atob(basic[1]), (c) => c.charCodeAt(0)));
      const colon = decoded.indexOf(":");
      if (colon > 0) (user = decoded.slice(0, colon).trim().toLowerCase()), (password = decoded.slice(colon + 1));
    } catch {}
  }
  if (basic && user && password) {
    const login = await appPasswordLogin(env, user, password);
    if (login) return login.account;
  }
  const account = password ? await accountByToken(password, env) : null;
  const local = user?.includes("@") ? parseAddress(user, env.DOMAIN) : user;
  if (!account || (basic && account.local !== local)) throw new HttpError(401, "Sign in with the address and an app password.", challenge);
  return account;
}

function pathsOf(account: Account): Paths {
  const local = encodeURIComponent(account.local);
  const home = `/dav/calendars/${local}/`;
  return { root: "/dav/", principal: `/dav/principals/${local}/`, home, calendar: `${home}${CALENDAR}/` };
}

const eventPath = (paths: Paths, name: string) => paths.calendar + encodeURIComponent(name);

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "That path isn't valid.");
  }
}

function depth(request: Request): number {
  return request.headers.get("depth")?.trim() === "0" ? 0 : 1;
}

// ── Properties ────────────────────────────────────────────────────────────────────────────────

const href = (path: string) => `<d:href>${escapeXml(path)}</d:href>`;
const privileges = (...names: string[]) => names.map((name) => `<d:privilege><d:${name}/></d:privilege>`).join("");

function rootProps(paths: Paths): Props {
  return {
    [`{${DAV}}resourcetype`]: "<d:collection/>",
    [`{${DAV}}current-user-principal`]: href(paths.principal),
  };
}

function principalProps(account: Account, paths: Paths, env: Env): Props {
  const address = `${account.local}@${env.DOMAIN}`;
  return {
    [`{${DAV}}resourcetype`]: "<d:principal/>",
    [`{${DAV}}displayname`]: escapeXml(address),
    [`{${DAV}}current-user-principal`]: href(paths.principal),
    [`{${DAV}}principal-URL`]: href(paths.principal),
    [`{${DAV}}current-user-privilege-set`]: privileges("read"),
    [`{${CALDAV}}calendar-home-set`]: href(paths.home),
    [`{${CALDAV}}calendar-user-address-set`]: href(`mailto:${address}`) + href(paths.principal),
    [`{${CS}}email-address-set`]: `<cs:email-address>${escapeXml(address)}</cs:email-address>`,
  };
}

function homeProps(paths: Paths): Props {
  return {
    [`{${DAV}}resourcetype`]: "<d:collection/>",
    [`{${DAV}}current-user-principal`]: href(paths.principal),
    [`{${DAV}}owner`]: href(paths.principal),
    [`{${DAV}}current-user-privilege-set`]: privileges("read"),
  };
}

function calendarProps(calendar: Calendar, paths: Paths): Props {
  const props: Props = {
    [`{${DAV}}resourcetype`]: "<d:collection/><c:calendar/>",
    [`{${DAV}}displayname`]: escapeXml(calendar.name ?? "Calendar"),
    [`{${DAV}}current-user-principal`]: href(paths.principal),
    [`{${DAV}}owner`]: href(paths.principal),
    [`{${DAV}}current-user-privilege-set`]: privileges("read", "write", "write-properties", "write-content", "bind", "unbind", "read-current-user-privilege-set"),
    [`{${DAV}}supported-report-set`]: ["c:calendar-multiget", "c:calendar-query", "d:sync-collection"]
      .map((name) => `<d:supported-report><d:report><${name}/></d:report></d:supported-report>`)
      .join(""),
    [`{${DAV}}sync-token`]: SYNC_TOKEN + calendar.revision,
    [`{${CS}}getctag`]: String(calendar.revision),
    [`{${CALDAV}}supported-calendar-component-set`]: '<c:comp name="VEVENT"/>',
    [`{${CALDAV}}supported-calendar-data`]: '<c:calendar-data content-type="text/calendar" version="2.0"/>',
    [`{${CALDAV}}max-resource-size`]: String(MAX_BODY),
  };
  if (calendar.color) props[`{${ICAL}}calendar-color`] = escapeXml(calendar.color);
  return props;
}

function eventProps(row: EventRow): Props {
  const ics = row.ics ?? "";
  return {
    [`{${DAV}}resourcetype`]: "",
    [`{${DAV}}getetag`]: escapeXml(row.etag ?? ""),
    [`{${DAV}}getcontenttype`]: "text/calendar; charset=utf-8; component=vevent",
    [`{${DAV}}getcontentlength`]: String(new TextEncoder().encode(ics).byteLength),
    [`{${DAV}}getlastmodified`]: new Date(row.updated_at).toUTCString(),
    [CALENDAR_DATA]: escapeXml(ics),
  };
}

/** The props a PROPFIND or REPORT names in its <prop>, or "all" for allprop, propname or no body. */
async function requestedProps(request: Request): Promise<string[] | "all"> {
  return propsIn(parseXml(await request.text()));
}

function propsIn(doc: XmlNode | null): string[] | "all" {
  const prop = doc && find(doc, DAV, "prop");
  return prop ? prop.children.map((node) => `{${node.ns}}${node.name}`) : "all";
}

function response(path: string, props: Props, wanted: string[] | "all"): string {
  const keys = wanted === "all" ? Object.keys(props).filter((key) => key !== CALENDAR_DATA) : wanted;
  const found = keys.filter((key) => key in props);
  const missing = keys.filter((key) => !(key in props));
  let out = `<d:response>${href(path)}`;
  if (found.length) out += propstat(found.map((key) => element(key, props[key])), "200 OK");
  if (missing.length) out += propstat(missing.map((key) => element(key, "")), "404 Not Found");
  return `${out}</d:response>`;
}

const propstat = (elements: string[], status: string) => `<d:propstat><d:prop>${elements.join("")}</d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat>`;

/** `{ns}name` as an element, with the ns's prefix when it's one of ours and its own xmlns when it isn't. */
function element(key: string, inner: string): string {
  const [, ns, name] = key.match(/^\{(.*)\}(.+)$/) ?? ["", "", key];
  const prefix = PREFIXES[ns];
  const open = prefix ? `${prefix}:${name}` : `x:${name} xmlns:x="${escapeXml(ns)}"`;
  const close = prefix ? `${prefix}:${name}` : `x:${name}`;
  return inner ? `<${open}>${inner}</${close}>` : `<${open}/>`;
}

function multistatus(body: string): Response {
  const xmlns = Object.entries(PREFIXES).map(([ns, prefix]) => ` xmlns:${prefix}="${ns}"`).join("");
  return davXml(207, `<d:multistatus${xmlns}>${body}</d:multistatus>`);
}

function davXml(status: number, body: string): Response {
  return new Response(`<?xml version="1.0" encoding="utf-8"?>\n${body}`, {
    status,
    headers: { "content-type": "application/xml; charset=utf-8", DAV: DAV_HEADERS.DAV },
  });
}

/** A failed precondition, as RFC 4918 writes it: 403 with the condition's element. */
function davError(condition: string): Response {
  return davXml(403, `<d:error xmlns:d="${DAV}" xmlns:c="${CALDAV}"><${condition}/></d:error>`);
}

// ── The calendar ──────────────────────────────────────────────────────────────────────────────

/** The account's calendar, made on first use. */
async function calendarOf(accountId: string, env: Env): Promise<Calendar> {
  const calendar = await env.DB.prepare(
    "INSERT INTO calendars (account_id) VALUES (?) ON CONFLICT (account_id) DO UPDATE SET revision = revision RETURNING *",
  )
    .bind(accountId)
    .first<Calendar>();
  return calendar!;
}

async function liveEvents(accountId: string, env: Env): Promise<EventRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM events WHERE account_id = ? AND ics IS NOT NULL ORDER BY name").bind(accountId).all<EventRow>();
  return results;
}

/** Name and color are all a client can change. Anything else it sets is answered as done and dropped. */
async function proppatch(request: Request, calendar: Calendar, paths: Paths, env: Env): Promise<Response> {
  const doc = parseXml(await request.text());
  if (!doc || doc.ns !== DAV || doc.name !== "propertyupdate") throw new HttpError(400, "Send a propertyupdate.");
  let { name, color } = calendar;
  const touched: string[] = [];
  for (const op of doc.children) {
    if (op.ns !== DAV || (op.name !== "set" && op.name !== "remove")) continue;
    for (const prop of find(op, DAV, "prop")?.children ?? []) {
      const key = `{${prop.ns}}${prop.name}`;
      const value = op.name === "set" ? prop.text.trim() || null : null;
      touched.push(key);
      if (key === `{${DAV}}displayname`) name = value?.slice(0, 200) ?? null;
      if (key === `{${ICAL}}calendar-color`) color = value?.slice(0, 32) ?? null;
    }
  }
  await env.DB.prepare("UPDATE calendars SET name = ?, color = ? WHERE account_id = ?").bind(name, color, calendar.account_id).run();
  return multistatus(`<d:response>${href(paths.calendar)}${propstat(touched.map((key) => element(key, "")), "200 OK")}</d:response>`);
}

async function report(request: Request, calendar: Calendar, paths: Paths, env: Env): Promise<Response> {
  const doc = parseXml(await request.text());
  if (!doc) throw new HttpError(400, "Send a REPORT body.");
  const wanted = propsIn(doc);

  if (doc.ns === CALDAV && doc.name === "calendar-multiget") {
    const rows = new Map((await liveEvents(calendar.account_id, env)).map((row) => [row.name, row]));
    const body = doc.children
      .filter((node) => node.ns === DAV && node.name === "href")
      .map((node) => {
        const path = node.text.trim();
        const row = rows.get(nameIn(path, paths) ?? "");
        return row ? response(eventPath(paths, row.name), eventProps(row), wanted) : `<d:response>${href(path)}<d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;
      });
    return multistatus(body.join(""));
  }

  if (doc.ns === CALDAV && doc.name === "calendar-query") {
    // Every event matches but a query for some other component (to-dos); a time range isn't applied, and
    // clients take the extra events without complaint.
    const wants = find(doc, CALDAV, "filter") && find(find(doc, CALDAV, "filter")!, CALDAV, "comp-filter");
    const component = wants && find(wants, CALDAV, "comp-filter")?.attrs.name?.toUpperCase();
    const rows = component && component !== "VEVENT" ? [] : await liveEvents(calendar.account_id, env);
    return multistatus(rows.map((row) => response(eventPath(paths, row.name), eventProps(row), wanted)).join(""));
  }

  if (doc.ns === DAV && doc.name === "sync-collection") {
    const token = find(doc, DAV, "sync-token")?.text.trim() ?? "";
    let since = 0;
    if (token) {
      const revision = token.startsWith(SYNC_TOKEN) ? Number(token.slice(SYNC_TOKEN.length)) : NaN;
      if (!Number.isInteger(revision) || revision < 0 || revision > calendar.revision) return davError("d:valid-sync-token");
      since = revision;
    }
    // From the start, only what's there; after a token, every change since, deletions included.
    const { results } = since
      ? await env.DB.prepare("SELECT * FROM events WHERE account_id = ? AND revision > ? ORDER BY revision").bind(calendar.account_id, since).all<EventRow>()
      : { results: await liveEvents(calendar.account_id, env) };
    const body = results.map((row) =>
      row.ics === null
        ? `<d:response>${href(eventPath(paths, row.name))}<d:status>HTTP/1.1 404 Not Found</d:status></d:response>`
        : response(eventPath(paths, row.name), eventProps(row), wanted),
    );
    return multistatus(`${body.join("")}<d:sync-token>${SYNC_TOKEN}${calendar.revision}</d:sync-token>`);
  }

  return davError("d:supported-report");
}

/** The event name an href points at in this calendar, or null when it's somewhere else. */
function nameIn(path: string, paths: Paths): string | null {
  let pathname: string;
  try {
    pathname = new URL(path, "https://calendar.invalid").pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(paths.calendar)) return null;
  const rest = pathname.slice(paths.calendar.length);
  try {
    return rest && !rest.includes("/") ? decodeURIComponent(rest) : null;
  } catch {
    return null;
  }
}

async function eventRoute(request: Request, name: string, account: Account, paths: Paths, env: Env): Promise<Response> {
  const method = request.method;
  if (!name || name.length > 255) throw new HttpError(404, "No such event.");
  const row = await env.DB.prepare("SELECT * FROM events WHERE account_id = ? AND name = ? AND ics IS NOT NULL").bind(account.id, name).first<EventRow>();

  if (method === "GET" || method === "HEAD") {
    if (!row) throw new HttpError(404, "No such event.");
    return new Response(method === "HEAD" ? null : row.ics, {
      headers: { "content-type": "text/calendar; charset=utf-8", etag: row.etag!, "last-modified": new Date(row.updated_at).toUTCString() },
    });
  }
  if (method === "PROPFIND") {
    if (!row) throw new HttpError(404, "No such event.");
    return multistatus(response(eventPath(paths, name), eventProps(row), await requestedProps(request)));
  }
  if (method === "PUT") {
    checkPreconditions(request, row);
    const ics = await request.text();
    if (ics.length > MAX_BODY) throw new HttpError(413, "That event is too big.");
    if (!/^BEGIN:VCALENDAR\r?$/im.test(ics) || !/^BEGIN:VEVENT\r?$/im.test(ics)) return davError("c:supported-calendar-component");
    if (!eventFields(ics).uid) return davError("c:valid-calendar-object-resource");
    let etag: string;
    try {
      etag = await writeEvent(account.id, name, ics, env);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return davError("c:no-uid-conflict");
      throw error;
    }
    return new Response(null, { status: row ? 204 : 201, headers: { etag } });
  }
  if (method === "DELETE") {
    if (!row) throw new HttpError(404, "No such event.");
    checkPreconditions(request, row);
    await removeEvent(account.id, name, env);
    return new Response(null, { status: 204 });
  }
  throw new HttpError(405, "Use GET, PUT, DELETE or PROPFIND.");
}

/** If-None-Match: * for a new event, If-Match: <etag> for one the client read: what keeps two phones from overwriting each other. */
function checkPreconditions(request: Request, row: EventRow | null) {
  const ifNoneMatch = request.headers.get("if-none-match")?.trim();
  const ifMatch = request.headers.get("if-match")?.trim();
  if (ifNoneMatch === "*" && row) throw new HttpError(412, "That event already exists.");
  if (ifMatch && (!row || (ifMatch !== "*" && !ifMatch.split(",").map((tag) => tag.trim().replace(/^W\//, "")).includes(row.etag!)))) {
    throw new HttpError(412, "The event changed since you read it.");
  }
}

/** Every change bumps the calendar's revision and stamps the event with it, in one transaction. */
const bump = (accountId: string, env: Env) =>
  env.DB.prepare("INSERT INTO calendars (account_id, revision) VALUES (?, 1) ON CONFLICT (account_id) DO UPDATE SET revision = revision + 1").bind(accountId);

async function writeEvent(accountId: string, name: string, ics: string, env: Env): Promise<string> {
  const fields = eventFields(ics);
  const etag = `"${(await sha256(ics)).slice(0, 32)}"`;
  await env.DB.batch([
    bump(accountId, env),
    env.DB.prepare(
      `INSERT INTO events (account_id, name, uid, ics, etag, summary, starts_at, ends_at, timezone, revision, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT revision FROM calendars WHERE account_id = ?), ?)
       ON CONFLICT (account_id, name) DO UPDATE SET uid = excluded.uid, ics = excluded.ics, etag = excluded.etag, summary = excluded.summary,
         starts_at = excluded.starts_at, ends_at = excluded.ends_at, timezone = excluded.timezone, revision = excluded.revision, updated_at = excluded.updated_at`,
    ).bind(accountId, name, fields.uid, ics, etag, fields.summary, fields.start, fields.end, fields.timezone, accountId, Date.now()),
  ]);
  return etag;
}

async function removeEvent(accountId: string, name: string, env: Env) {
  await env.DB.batch([
    bump(accountId, env),
    env.DB.prepare(
      `UPDATE events SET uid = NULL, ics = NULL, etag = NULL, summary = NULL, starts_at = NULL, ends_at = NULL, timezone = NULL,
         revision = (SELECT revision FROM calendars WHERE account_id = ?), updated_at = ?
       WHERE account_id = ? AND name = ?`,
    ).bind(accountId, Date.now(), accountId, name),
  ]);
}

// ── Invites by mail ───────────────────────────────────────────────────────────────────────────

/**
 * An invite mailed to the address (a text/calendar part, as Google, Outlook and iCloud send) goes into
 * its calendar: REQUEST and PUBLISH add or update the event by UID, CANCEL removes it. Replies are ignored.
 */
export async function addInvites(accountId: string, email: Email, env: Env) {
  const part = email.attachments.find((a) => a.mimeType === "text/calendar" || a.mimeType === "application/ics");
  if (!part) return;
  const text = typeof part.content === "string" ? part.content : new TextDecoder().decode(part.content);
  const method = (part.method ?? text.match(/^METHOD:(.*)$/im)?.[1] ?? "PUBLISH").trim().toUpperCase();
  // A calendar's own copy carries no METHOD (RFC 4791 4.1); that's only for the message.
  const ics = text.replace(/^METHOD:.*\r?\n/gim, "");
  const { uid } = eventFields(ics);
  if (!uid || ics.length > MAX_BODY) return;

  const existing = await env.DB.prepare("SELECT name FROM events WHERE account_id = ? AND uid = ?").bind(accountId, uid).first<{ name: string }>();
  if (method === "CANCEL") {
    if (existing) await removeEvent(accountId, existing.name, env);
    return;
  }
  if (method !== "REQUEST" && method !== "PUBLISH") return;
  await writeEvent(accountId, existing?.name ?? `${(await sha256(uid)).slice(0, 32)}.ics`, ics, env);
}

// ── JSON, for agents ──────────────────────────────────────────────────────────────────────────

/** GET /events?from=2026-10-24&limit — events starting at or after `from`, soonest first; GET /events/:id — one as iCalendar. */
export async function eventsRoute(method: string, rest: string[], url: URL, account: Account, env: Env): Promise<Response> {
  if (method !== "GET") throw new HttpError(405, "Use GET.");
  if (rest.length === 0) {
    const from = url.searchParams.get("from");
    const { results } = await env.DB.prepare(
      `SELECT name, uid, summary, starts_at, ends_at, timezone, updated_at FROM events
       WHERE account_id = ? AND ics IS NOT NULL ${from ? "AND starts_at >= ?" : ""} ORDER BY starts_at, name LIMIT ?`,
    )
      .bind(...(from ? [account.id, from] : [account.id]), limitParam(url))
      .all<EventRow>();
    return json({
      events: results.map((row) => ({
        id: row.name,
        uid: row.uid,
        summary: row.summary,
        start: row.starts_at,
        end: row.ends_at,
        timezone: row.timezone,
        updated_at: row.updated_at,
      })),
    });
  }
  const row = rest.length === 1 && (await env.DB.prepare("SELECT ics, etag FROM events WHERE account_id = ? AND name = ? AND ics IS NOT NULL").bind(account.id, decodeSegment(rest[0])).first<EventRow>());
  if (!row) throw new HttpError(404, "No such event.");
  return new Response(row.ics, { headers: { "content-type": "text/calendar; charset=utf-8", etag: row.etag! } });
}

// ── The iOS profile ───────────────────────────────────────────────────────────────────────────

/**
 * GET /setup.mobileconfig?address=name@DOMAIN — opened in Safari on an iPhone, it adds the calendar account
 * (and the Mail account, when MAIL_HOST is set) in a few taps. It holds no secret: iOS asks for the password,
 * an app password for the address (POST /app-passwords), while installing.
 * Its UUIDs come from the address, so installing it again replaces the account rather than adding another.
 */
export async function setupProfile(url: URL, env: Env): Promise<Response> {
  const address = url.searchParams.get("address")?.trim().toLowerCase() ?? "";
  const local = parseAddress(address, env.DOMAIN);
  const account =
    local && address === `${local}@${env.DOMAIN.toLowerCase()}` && (await env.DB.prepare("SELECT id FROM accounts WHERE local = ?").bind(local).first());
  if (!account) throw new HttpError(404, `No such address. Pass it as ?address=name@${env.DOMAIN}.`);

  const secure = url.protocol === "https:";
  const digest = await sha256(`caldav:${address}`);
  const uuid = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`.toUpperCase();
  const reverse = env.DOMAIN.toLowerCase().split(".").reverse().join(".");
  const value = (v: string | number | boolean) => (typeof v === "boolean" ? `<${v}/>` : typeof v === "number" ? `<integer>${v}</integer>` : `<string>${escapeXml(v)}</string>`);
  const dict = (entries: Record<string, string | number | boolean>, extra = "") =>
    `<dict>${extra}${Object.entries(entries).map(([key, v]) => `<key>${key}</key>${value(v)}`).join("")}</dict>`;

  const caldav = dict({
    CalDAVAccountDescription: address,
    CalDAVHostName: url.hostname,
    CalDAVPort: Number(url.port) || (secure ? 443 : 80),
    CalDAVPrincipalURL: `${url.protocol}//${url.host}/dav/principals/${encodeURIComponent(local)}/`,
    CalDAVUseSSL: secure,
    CalDAVUsername: address,
    PayloadDescription: `The calendar for ${address}`,
    PayloadDisplayName: "Calendar",
    PayloadIdentifier: `${reverse}.caldav.${local}`,
    PayloadType: "com.apple.caldav.account",
    PayloadUUID: uuid(digest.slice(32)),
    PayloadVersion: 1,
  });
  // With the IMAP/SMTP service up (MAIL_HOST), the same profile adds the Mail account. Both use implicit TLS.
  const mail =
    env.MAIL_HOST &&
    dict({
      EmailAccountDescription: address,
      EmailAccountType: "EmailTypeIMAP",
      EmailAddress: address,
      IncomingMailServerAuthentication: "EmailAuthPassword",
      IncomingMailServerHostName: env.MAIL_HOST,
      IncomingMailServerPortNumber: 993,
      IncomingMailServerUseSSL: true,
      IncomingMailServerUsername: address,
      OutgoingMailServerAuthentication: "EmailAuthPassword",
      OutgoingMailServerHostName: env.MAIL_HOST,
      OutgoingMailServerPortNumber: 465,
      OutgoingMailServerUseSSL: true,
      OutgoingMailServerUsername: address,
      OutgoingPasswordSameAsIncomingPassword: true,
      PayloadDescription: `Mail for ${address}`,
      PayloadDisplayName: "Mail",
      PayloadIdentifier: `${reverse}.mail.${local}`,
      PayloadType: "com.apple.mail.managed",
      PayloadUUID: uuid((await sha256(`mail:${address}`)).slice(0, 32)),
      PayloadVersion: 1,
    });
  const profile = dict(
    {
      PayloadDescription: `Adds ${mail ? "mail and the calendar" : "the calendar"} for ${address}. Its password is an app password for the address.`,
      PayloadDisplayName: `${address} ${mail ? "mail and calendar" : "calendar"}`,
      PayloadIdentifier: `${reverse}.setup.${local}`,
      PayloadRemovalDisallowed: false,
      PayloadType: "Configuration",
      PayloadUUID: uuid(digest),
      PayloadVersion: 1,
    },
    `<key>PayloadContent</key><array>${mail || ""}${caldav}</array>`,
  );
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">${profile}</plist>
`;
  return new Response(body, {
    headers: { "content-type": "application/x-apple-aspen-config", "content-disposition": `attachment; filename="${local}-calendar.mobileconfig"` },
  });
}

// ── iCalendar ─────────────────────────────────────────────────────────────────────────────────

type EventFields = { uid: string | null; summary: string | null; start: string | null; end: string | null; timezone: string | null };

/** What GET /events shows of an event, read out of its first VEVENT. Dates become ISO (2026-10-24T15:00:00Z, or 2026-10-24 all day). */
export function eventFields(ics: string): EventFields {
  const fields: EventFields = { uid: null, summary: null, start: null, end: null, timezone: null };
  let level = -1; // -1 outside the VEVENT, 0 in it, more inside its alarms
  for (const line of ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
    const { name, params, value } = contentLine(line);
    if (name === "BEGIN") {
      if (level >= 0) level++;
      else if (value.trim().toUpperCase() === "VEVENT") level = 0;
    } else if (name === "END") {
      if (level === 0) break;
      if (level > 0) level--;
    } else if (level === 0) {
      if (name === "UID") fields.uid = value.trim() || null;
      else if (name === "SUMMARY") fields.summary = value.replace(/\\([\\;,nN])/g, (_, c: string) => (c.toLowerCase() === "n" ? "\n" : c));
      else if (name === "DTSTART") (fields.start = icsDate(value)), (fields.timezone = params.TZID ?? null);
      else if (name === "DTEND") fields.end = icsDate(value);
    }
  }
  return fields;
}

/** NAME;PARAM=x;PARAM="y:z":value, split at the first colon outside quotes. */
function contentLine(line: string) {
  let at = 0;
  for (let quoted = false; at < line.length; at++) {
    if (line[at] === '"') quoted = !quoted;
    else if (line[at] === ":" && !quoted) break;
  }
  const [name, ...rawParams] = line.slice(0, at).split(";");
  const params: Record<string, string> = {};
  for (const param of rawParams) {
    const eq = param.indexOf("=");
    if (eq > 0) params[param.slice(0, eq).toUpperCase()] = param.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(at + 1) };
}

function icsDate(value: string): string {
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/);
  if (!m) return value.trim();
  const [, y, mo, d, h, mi, s, z] = m;
  return h ? `${y}-${mo}-${d}T${h}:${mi}:${s}${z}` : `${y}-${mo}-${d}`;
}

// ── XML ───────────────────────────────────────────────────────────────────────────────────────

/** Just enough XML for WebDAV bodies: elements with resolved namespaces, attributes and text. */
type XmlNode = { ns: string; name: string; attrs: Record<string, string>; children: XmlNode[]; text: string };

const XML_TOKEN =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<(\/?)([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;

export function parseXml(source: string): XmlNode | null {
  const root: XmlNode = { ns: "", name: "", attrs: {}, children: [], text: "" };
  const stack: { node: XmlNode; scope: Map<string, string> }[] = [{ node: root, scope: new Map() }];
  for (const [, cdata, closing, tag, rawAttrs, selfClosing, text] of source.matchAll(XML_TOKEN)) {
    const top = stack.at(-1)!;
    if (cdata !== undefined) top.node.text += cdata;
    else if (text !== undefined) top.node.text += decodeEntities(text);
    else if (!tag) continue; // a comment, processing instruction or doctype
    else if (closing) {
      if (stack.length > 1) stack.pop();
    } else {
      const scope = new Map(top.scope);
      const attrs: Record<string, string> = {};
      for (const [, key, double, single] of (rawAttrs ?? "").matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        const v = decodeEntities(double ?? single ?? "");
        if (key === "xmlns") scope.set("", v);
        else if (key.startsWith("xmlns:")) scope.set(key.slice(6), v);
        else attrs[key.includes(":") ? key.slice(key.indexOf(":") + 1) : key] = v;
      }
      const colon = tag.indexOf(":");
      const node: XmlNode = { ns: scope.get(colon > 0 ? tag.slice(0, colon) : "") ?? "", name: tag.slice(colon + 1), attrs, children: [], text: "" };
      top.node.children.push(node);
      if (!selfClosing) stack.push({ node, scope });
    }
  }
  return root.children[0] ?? null;
}

/** The first element called {ns}name under node, at any depth. */
function find(node: XmlNode, ns: string, name: string): XmlNode | undefined {
  for (const child of node.children) {
    if (child.ns === ns && child.name === name) return child;
    const deeper = find(child, ns, name);
    if (deeper) return deeper;
  }
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (whole, entity: string) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? whole;
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}
