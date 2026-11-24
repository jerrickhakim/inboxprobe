import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { eventFields, parseXml } from "../src/calendar";
import worker from "../src/index";

type Init = RequestInit & { auth?: string; depth?: string; headers?: Record<string, string> };

const call = (path: string, init: Init = {}) => {
  const headers = new Headers(init.headers);
  if (init.auth) headers.set("authorization", init.auth);
  if (init.depth) headers.set("depth", init.depth);
  return exports.default.fetch(new Request(`https://dav.test.dev${path}`, { ...init, headers }));
};

const basic = (user: string, password: string) => `Basic ${btoa(`${user}:${password}`)}`;

async function createAccount(name: string) {
  const response = await call("/accounts", { method: "POST", auth: "Bearer admin", body: JSON.stringify({ name }) });
  expect(response.status).toBe(201);
  const account = await response.json<{ id: string; address: string; token: string }>();
  return { ...account, auth: basic(account.address, account.token) };
}

async function deliver(to: string, raw: string) {
  const message = {
    from: "organizer@elsewhere.com",
    to,
    raw: new Blob([raw]).stream(),
    rawSize: raw.length,
    headers: new Headers(),
    setReject: () => {},
  } as unknown as ForwardableEmailMessage;
  await worker.email(message, env as never);
}

const propfind = (props: string) =>
  `<?xml version="1.0"?><A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:B="http://calendarserver.org/ns/"><A:prop>${props}</A:prop></A:propfind>`;

const event = (uid: string, summary: string, method = "") =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//EN",
    ...(method ? [`METHOD:${method}`] : []),
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20261020T120000Z",
    "DTSTART;TZID=America/New_York:20261030T150000",
    "DTEND;TZID=America/New_York:20261030T160000",
    `SUMMARY:${summary}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "SUMMARY:Not the event's",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

const invite = (to: string, uid: string, summary: string, method: string) =>
  [
    "From: organizer@elsewhere.com",
    `To: ${to}`,
    `Subject: Invitation: ${summary}`,
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain",
    "",
    "You're invited.",
    "--b",
    `Content-Type: text/calendar; charset=utf-8; method=${method}`,
    "",
    event(uid, summary, method),
    "--b--",
  ].join("\r\n");

describe("discovery", () => {
  it("sends /.well-known/caldav to /dav/", async () => {
    const response = await call("/.well-known/caldav", { method: "PROPFIND", redirect: "manual" });
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/dav/");
  });

  it("asks for Basic auth, and takes only the address that owns the token", async () => {
    const sam = await createAccount("cal-sam");
    const other = await createAccount("cal-other");

    const anonymous = await call("/dav/", { method: "PROPFIND" });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toMatch(/^Basic realm="test\.dev"/);

    expect((await call("/dav/", { method: "PROPFIND", auth: basic(other.address, sam.token) })).status).toBe(401);
    expect((await call("/dav/", { method: "PROPFIND", auth: basic("cal-sam", sam.token) })).status).toBe(207);
    expect((await call("/dav/calendars/cal-other/", { method: "PROPFIND", auth: sam.auth })).status).toBe(403);
  });

  it("walks root → principal → home → calendar, as iOS does", async () => {
    const sam = await createAccount("cal-walk");

    const root = await (await call("/dav/", { method: "PROPFIND", auth: sam.auth, depth: "0", body: propfind("<A:current-user-principal/>") })).text();
    expect(root).toContain("<d:current-user-principal><d:href>/dav/principals/cal-walk/</d:href></d:current-user-principal>");

    const principal = await (
      await call("/dav/principals/cal-walk/", {
        method: "PROPFIND",
        auth: sam.auth,
        depth: "0",
        body: propfind("<C:calendar-home-set/><C:calendar-user-address-set/><C:schedule-outbox-URL/>"),
      })
    ).text();
    expect(principal).toContain("<c:calendar-home-set><d:href>/dav/calendars/cal-walk/</d:href></c:calendar-home-set>");
    expect(principal).toContain("<d:href>mailto:cal-walk@test.dev</d:href>");
    // No scheduling, so the outbox is missing and iOS doesn't try to send invites.
    expect(principal).toMatch(/<c:schedule-outbox-URL\/><\/d:prop><d:status>HTTP\/1.1 404 Not Found/);

    const home = await (
      await call("/dav/calendars/cal-walk/", {
        method: "PROPFIND",
        auth: sam.auth,
        depth: "1",
        body: propfind("<A:resourcetype/><B:getctag/><A:sync-token/><C:supported-calendar-component-set/><X:unknown xmlns:X=\"urn:x\"/>"),
      })
    ).text();
    expect(home).toContain("<d:href>/dav/calendars/cal-walk/default/</d:href>");
    expect(home).toContain("<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>");
    expect(home).toContain("<cs:getctag>0</cs:getctag>");
    expect(home).toContain('<c:comp name="VEVENT"/>');
    expect(home).toContain('<x:unknown xmlns:x="urn:x"/>');
  });

  it("serves an iOS profile for an address, with no secret in it", async () => {
    const sam = await createAccount("cal-profile");
    const response = await call(`/setup.mobileconfig?address=${sam.address}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-apple-aspen-config");
    const body = await response.text();
    expect(body).toContain("<key>CalDAVHostName</key><string>dav.test.dev</string>");
    expect(body).toContain("<key>CalDAVUsername</key><string>cal-profile@test.dev</string>");
    expect(body).toContain("<key>CalDAVPrincipalURL</key><string>https://dav.test.dev/dav/principals/cal-profile/</string>");
    expect(body).not.toContain(sam.token);
    expect(body).not.toContain("CalDAVPassword");
    // The same address gets the same profile, so installing it again replaces it.
    expect(await (await call(`/setup.mobileconfig?address=${sam.address}`)).text()).toBe(body);

    expect((await call("/setup.mobileconfig?address=nobody@test.dev")).status).toBe(404);
    expect((await call("/setup.mobileconfig?address=cal-profile@elsewhere.com")).status).toBe(404);
  });
});

describe("events", () => {
  it("puts, reads, lists and deletes events, with etags and preconditions", async () => {
    const sam = await createAccount("cal-events");
    const path = "/dav/calendars/cal-events/default/A1.ics";

    const created = await call(path, { method: "PUT", auth: sam.auth, headers: { "if-none-match": "*" }, body: event("uid-1", "Lunch") });
    expect(created.status).toBe(201);
    const etag = created.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);

    expect((await call(path, { method: "PUT", auth: sam.auth, headers: { "if-none-match": "*" }, body: event("uid-1", "Again") })).status).toBe(412);
    expect((await call("/dav/calendars/cal-events/default/B.ics", { method: "PUT", auth: sam.auth, body: event("uid-1", "Same UID") })).status).toBe(403);
    expect((await call(path, { method: "PUT", auth: sam.auth, body: "not a calendar" })).status).toBe(403);

    const got = await call(path, { auth: sam.auth });
    expect(got.headers.get("etag")).toBe(etag);
    expect(await got.text()).toContain("SUMMARY:Lunch");

    const listing = await (await call("/dav/calendars/cal-events/default/", { method: "PROPFIND", auth: sam.auth, depth: "1", body: propfind("<A:getetag/>") })).text();
    expect(listing).toContain(`<d:href>${path}</d:href><d:propstat><d:prop><d:getetag>${etag.replace(/"/g, "&quot;")}</d:getetag>`);

    const multiget = await (
      await call("/dav/calendars/cal-events/default/", {
        method: "REPORT",
        auth: sam.auth,
        depth: "1",
        body: `<C:calendar-multiget xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><A:prop><A:getetag/><C:calendar-data/></A:prop><A:href>${path}</A:href><A:href>/dav/calendars/cal-events/default/gone.ics</A:href></C:calendar-multiget>`,
      })
    ).text();
    expect(multiget).toContain("SUMMARY:Lunch");
    expect(multiget).toMatch(/gone\.ics<\/d:href><d:status>HTTP\/1\.1 404/);

    const json = await (await call("/events", { auth: `Bearer ${sam.token}` })).json<{ events: Record<string, unknown>[] }>();
    expect(json.events).toEqual([
      expect.objectContaining({ id: "A1.ics", uid: "uid-1", summary: "Lunch", start: "2026-10-30T15:00:00", end: "2026-10-30T16:00:00", timezone: "America/New_York" }),
    ]);

    const updated = await call(path, { method: "PUT", auth: sam.auth, headers: { "if-match": etag }, body: event("uid-1", "Late lunch") });
    expect(updated.status).toBe(204);
    expect((await call(path, { method: "DELETE", auth: sam.auth, headers: { "if-match": etag } })).status).toBe(412);
    expect((await call(path, { method: "DELETE", auth: sam.auth, headers: { "if-match": updated.headers.get("etag")! } })).status).toBe(204);
    expect((await call(path, { auth: sam.auth })).status).toBe(404);
  });

  it("syncs changes since a token, deletions included", async () => {
    const sam = await createAccount("cal-sync");
    const calendar = "/dav/calendars/cal-sync/default/";
    const sync = async (token: string) =>
      (
        await call(calendar, {
          method: "REPORT",
          auth: sam.auth,
          body: `<A:sync-collection xmlns:A="DAV:"><A:sync-token>${token}</A:sync-token><A:sync-level>1</A:sync-level><A:prop><A:getetag/></A:prop></A:sync-collection>`,
        })
      ).text();

    await call(`${calendar}one.ics`, { method: "PUT", auth: sam.auth, body: event("one", "One") });
    await call(`${calendar}two.ics`, { method: "PUT", auth: sam.auth, body: event("two", "Two") });
    const first = await sync("");
    expect(first).toContain("one.ics");
    expect(first).toContain("two.ics");
    const token = first.match(/<d:sync-token>([^<]+)<\/d:sync-token>/)![1];
    expect(token).toBe("urn:email-server:sync:2");

    await call(`${calendar}one.ics`, { method: "DELETE", auth: sam.auth });
    await call(`${calendar}three.ics`, { method: "PUT", auth: sam.auth, body: event("three", "Three") });
    const next = await sync(token);
    expect(next).toMatch(/one\.ics<\/d:href><d:status>HTTP\/1\.1 404/);
    expect(next).toContain("three.ics</d:href><d:propstat>");
    expect(next).not.toContain("two.ics");
    expect(next).toContain("<d:sync-token>urn:email-server:sync:4</d:sync-token>");

    const stale = await call(calendar, { method: "REPORT", auth: sam.auth, body: `<A:sync-collection xmlns:A="DAV:"><A:sync-token>urn:email-server:sync:99</A:sync-token></A:sync-collection>` });
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain("valid-sync-token");
  });

  it("renames and recolors the calendar", async () => {
    const sam = await createAccount("cal-patch");
    const calendar = "/dav/calendars/cal-patch/default/";
    const patched = await call(calendar, {
      method: "PROPPATCH",
      auth: sam.auth,
      body: `<A:propertyupdate xmlns:A="DAV:" xmlns:I="http://apple.com/ns/ical/"><A:set><A:prop><A:displayname>Work</A:displayname><I:calendar-color>#FF2968FF</I:calendar-color></A:prop></A:set></A:propertyupdate>`,
    });
    expect(patched.status).toBe(207);
    const props = await (await call(calendar, { method: "PROPFIND", auth: sam.auth, depth: "0", body: propfind("<A:displayname/><I:calendar-color xmlns:I=\"http://apple.com/ns/ical/\"/>") })).text();
    expect(props).toContain("<d:displayname>Work</d:displayname>");
    expect(props).toContain("<ic:calendar-color>#FF2968FF</ic:calendar-color>");
  });

  it("files mailed invites, updates them by UID, and drops cancelled ones", async () => {
    const sam = await createAccount("cal-invites");
    const events = async () => (await (await call("/events", { auth: `Bearer ${sam.token}` })).json<{ events: { id: string; summary: string }[] }>()).events;

    await deliver(sam.address, invite(sam.address, "meet-1@elsewhere.com", "Kickoff", "REQUEST"));
    expect((await events()).map((e) => e.summary)).toEqual(["Kickoff"]);
    const [{ id }] = await events();
    const ics = await (await call(`/events/${id}`, { auth: `Bearer ${sam.token}` })).text();
    expect(ics).not.toContain("METHOD:");

    await deliver(sam.address, invite(sam.address, "meet-1@elsewhere.com", "Kickoff (moved)", "REQUEST"));
    expect((await events()).map((e) => e.summary)).toEqual(["Kickoff (moved)"]);

    await deliver(sam.address, invite(sam.address, "meet-1@elsewhere.com", "Kickoff", "CANCEL"));
    expect(await events()).toEqual([]);
  });

  it("deletes the calendar with the account", async () => {
    const sam = await createAccount("cal-gone");
    await call("/dav/calendars/cal-gone/default/x.ics", { method: "PUT", auth: sam.auth, body: event("x", "X") });
    expect((await call("/account", { method: "DELETE", auth: `Bearer ${sam.token}` })).status).toBe(204);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE account_id = ?").bind(sam.id).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe("parsing", () => {
  it("reads the event's own fields, not its alarm's, from folded lines", () => {
    const fields = eventFields("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:abc\r\nSUMMARY:Board\\, quarterly\r\n  review\r\nDTSTART;VALUE=DATE:20261101\r\nBEGIN:VALARM\r\nSUMMARY:x\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR");
    expect(fields).toEqual({ uid: "abc", summary: "Board, quarterly review", start: "2026-11-01", end: null, timezone: null });
  });

  it("resolves namespaces by URI, whatever the prefix", () => {
    const doc = parseXml('<?xml version="1.0"?><propfind xmlns="DAV:"><prop><getetag/><x:color xmlns:x="urn:c">a &amp; b</x:color></prop></propfind>')!;
    expect(doc).toMatchObject({ ns: "DAV:", name: "propfind" });
    expect(doc.children[0].children.map((c) => [c.ns, c.name, c.text])).toEqual([
      ["DAV:", "getetag", ""],
      ["urn:c", "color", "a & b"],
    ]);
  });
});
