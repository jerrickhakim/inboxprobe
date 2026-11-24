import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

// The mail model the IMAP service sees through /internal/*, and how the REST API's reads, moves and
// deletes show up in it as changes.

const call = (path: string, init: RequestInit & { token?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  return exports.default.fetch(new Request(`https://mail.test${path}`, { ...init, headers }));
};

const internal = <T = Record<string, unknown>>(path: string, body?: unknown, init: RequestInit = {}) =>
  call(`/internal${path}`, {
    method: body === undefined ? "GET" : "POST",
    token: "internal",
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  }).then(async (response) => {
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return response.json<T>();
  });

async function createAccount(name: string) {
  const response = await call("/accounts", { method: "POST", token: "admin", body: JSON.stringify({ name }) });
  expect(response.status).toBe(201);
  return response.json<{ id: string; address: string; token: string }>();
}

async function deliver(to: string, subject: string) {
  const raw = [`From: Sam <sam@elsewhere.com>`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${subject}@elsewhere.com>`, "", "Hello."].join("\r\n");
  const message = {
    from: "sam@elsewhere.com",
    to,
    raw: new Blob([raw]).stream(),
    rawSize: raw.length,
    headers: new Headers(),
    setReject: (reason: string) => {
      throw new Error(reason);
    },
  } as unknown as ForwardableEmailMessage;
  await worker.email(message, env as never);
}

type Meta = { uid: number; flags: string[]; size: number; date: number; blob: string };
type State = { cursor: number; mailboxes: { id: string; name: string; special_use: string | null; uid_validity: number; uid_next: number; messages: Meta[] }[] };
type Changes = { cursor: number; more: boolean; changes: { id: number; kind: string; mailbox_id: string; uid: number; detail: string | null; message: Meta | null }[] };

const state = (accountId: string) => internal<State>(`/accounts/${accountId}/state`);
const box = (s: State, name: string) => s.mailboxes.find((m) => m.name === name)!;

describe("mailboxes", () => {
  it("gives every new address the standard folders with SPECIAL-USE", async () => {
    const sam = await createAccount("mb-folders");
    const s = await state(sam.id);
    expect(s.mailboxes.map((m) => [m.name, m.special_use])).toEqual([
      ["INBOX", null],
      ["Sent", "\\Sent"],
      ["Drafts", "\\Drafts"],
      ["Archive", "\\Archive"],
      ["Junk", "\\Junk"],
      ["Trash", "\\Trash"],
    ]);
    expect(s.mailboxes.every((m) => m.uid_next === 1 && m.uid_validity > 0)).toBe(true);
    const listed = await (await call("/mailboxes", { token: sam.token })).json<{ mailboxes: { name: string; messages: number }[] }>();
    expect(listed.mailboxes.map((m) => m.name)).toEqual(["INBOX", "Sent", "Drafts", "Archive", "Junk", "Trash"]);
  });

  it("numbers new mail in the inbox and records each arrival", async () => {
    const sam = await createAccount("mb-uids");
    const before = await state(sam.id);
    await deliver(sam.address, "one");
    await deliver(sam.address, "two");
    const after = await state(sam.id);
    expect(box(after, "INBOX").messages.map((m) => [m.uid, m.flags])).toEqual([
      [1, []],
      [2, []],
    ]);
    expect(box(after, "INBOX").uid_next).toBe(3);

    const { changes } = await internal<Changes>(`/accounts/${sam.id}/changes?since=${before.cursor}`);
    expect(changes.map((c) => [c.kind, c.uid])).toEqual([
      ["add", 1],
      ["add", 2],
    ]);
    expect(changes[0].message).toMatchObject({ uid: 1, flags: [] });
  });
});

describe("one inbox for the API and IMAP", () => {
  it("shows a read over the API as a \\Seen change, and STORE as read in the API", async () => {
    const sam = await createAccount("mb-seen");
    await deliver(sam.address, "hello");
    const [listed] = (await (await call("/messages", { token: sam.token })).json<{ messages: { id: string }[] }>()).messages;
    const { cursor } = await state(sam.id);

    await call(`/messages/${listed.id}`, { token: sam.token });
    const { changes } = await internal<Changes>(`/accounts/${sam.id}/changes?since=${cursor}`);
    expect(changes).toEqual([expect.objectContaining({ kind: "flags", uid: 1, message: expect.objectContaining({ flags: ["\\Seen"] }) })]);

    const inbox = box(await state(sam.id), "INBOX");
    const stored = await internal<{ messages: { uid: number; flags: string[] }[] }>(`/accounts/${sam.id}/store`, {
      mailbox_id: inbox.id,
      uids: [1],
      op: "set",
      flags: ["\\flagged", "$Forwarded"],
    });
    expect(stored.messages).toEqual([{ uid: 1, flags: ["\\Flagged", "$Forwarded"] }]);
    const unread = await (await call("/messages?unread=true", { token: sam.token })).json<{ messages: unknown[] }>();
    expect(unread.messages).toHaveLength(1);
  });

  it("moves to Trash, expunges only \\Deleted mail, and deletes over the API as an expunge", async () => {
    const sam = await createAccount("mb-move");
    for (const subject of ["a", "b", "c"]) await deliver(sam.address, subject);
    const s = await state(sam.id);
    const inbox = box(s, "INBOX");
    const trash = box(s, "Trash");

    const moved = await internal<{ uid_validity: number; source_uids: number[]; messages: Meta[] }>(`/accounts/${sam.id}/copy`, {
      mailbox_id: inbox.id,
      uids: [1],
      dest_id: trash.id,
      move: true,
    });
    expect(moved).toMatchObject({ uid_validity: trash.uid_validity, source_uids: [1], messages: [expect.objectContaining({ uid: 1 })] });

    await internal(`/accounts/${sam.id}/store`, { mailbox_id: inbox.id, uids: [2, 3], op: "add", flags: ["\\Deleted"] });
    // UID EXPUNGE only takes the UIDs it names.
    expect(await internal(`/accounts/${sam.id}/expunge`, { mailbox_id: inbox.id, uids: [3] })).toEqual({ uids: [3] });
    expect(box(await state(sam.id), "INBOX").messages.map((m) => m.uid)).toEqual([2]);

    const { cursor } = await state(sam.id);
    const [left] = (await (await call("/messages", { token: sam.token })).json<{ messages: { id: string }[] }>()).messages;
    expect((await call(`/messages/${left.id}`, { method: "DELETE", token: sam.token })).status).toBe(204);
    const { changes } = await internal<Changes>(`/accounts/${sam.id}/changes?since=${cursor}`);
    expect(changes.map((c) => [c.kind, c.mailbox_id, c.uid, c.message])).toEqual([["expunge", inbox.id, 2, null]]);

    const trashed = await (await call("/messages?mailbox=Trash", { token: sam.token })).json<{ messages: { subject: string }[] }>();
    expect(trashed.messages.map((m) => m.subject)).toEqual(["a"]);
  });

  it("keeps a body while a copy still points at it", async () => {
    const sam = await createAccount("mb-blobs");
    await deliver(sam.address, "shared");
    const s = await state(sam.id);
    const inbox = box(s, "INBOX");
    await internal(`/accounts/${sam.id}/copy`, { mailbox_id: inbox.id, uids: [1], dest_id: box(s, "Archive").id, move: false });
    const blob = inbox.messages[0].blob;

    await internal(`/accounts/${sam.id}/store`, { mailbox_id: inbox.id, uids: [1], op: "add", flags: ["\\Deleted"] });
    await internal(`/accounts/${sam.id}/expunge`, { mailbox_id: inbox.id });
    expect(await env.MAIL.head(blob)).not.toBeNull();

    const archive = box(await state(sam.id), "Archive");
    await internal(`/accounts/${sam.id}/store`, { mailbox_id: archive.id, uids: [1], op: "add", flags: ["\\Deleted"] });
    await internal(`/accounts/${sam.id}/expunge`, { mailbox_id: archive.id });
    expect(await env.MAIL.head(blob)).toBeNull();
  });

  it("appends a sent message once, however many times it's retried", async () => {
    const sam = await createAccount("mb-append");
    const sent = box(await state(sam.id), "Sent");
    const raw = `From: ${sam.address}\r\nTo: pat@elsewhere.com\r\nSubject: Hi Pat\r\n\r\nHello.`;
    const path = `/accounts/${sam.id}/append?mailbox_id=${sent.id}&flags=${encodeURIComponent("\\Seen")}&date=1792000000000&key=k1`;
    const first = await internal<{ uid_validity: number; message: Meta }>(path, raw);
    const again = await internal<{ uid_validity: number; message: Meta }>(path, raw);
    expect(again).toEqual(first);
    expect(first.message).toMatchObject({ uid: 1, flags: ["\\Seen"], date: 1792000000000 });
    const listed = await (await call("/messages?mailbox=Sent", { token: sam.token })).json<{ messages: { subject: string; to: string; from: { address: string } }[] }>();
    expect(listed.messages).toEqual([expect.objectContaining({ subject: "Hi Pat", to: "pat@elsewhere.com", from: expect.objectContaining({ address: sam.address }) })]);
    // The inbox's counts are the inbox's alone.
    expect(await (await call("/account", { token: sam.token })).json()).toMatchObject({ messages: 0, unread: 0 });
  });

  it("serves bodies to a service without R2 credentials", async () => {
    const sam = await createAccount("mb-body");
    await deliver(sam.address, "body");
    const [message] = box(await state(sam.id), "INBOX").messages;
    const response = await call(`/internal/blobs/${message.blob}`, { token: "internal" });
    expect(await response.text()).toContain("Subject: body");
  });
});

describe("app passwords", () => {
  it("signs in to IMAP with the address and an app password, never the account token", async () => {
    const sam = await createAccount("mb-login");
    const created = await call("/app-passwords", { method: "POST", token: sam.token, body: JSON.stringify({ name: "iPhone" }) });
    expect(created.status).toBe(201);
    const { id, password } = await created.json<{ id: string; password: string }>();
    expect(password).toMatch(/^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/);

    const login = (username: string, pass: string) =>
      call("/internal/login", { method: "POST", token: "internal", body: JSON.stringify({ username, password: pass }) });
    expect(await (await login(sam.address, password.toUpperCase().replace(/-/g, " "))).json()).toEqual({
      account_id: sam.id,
      address: sam.address,
      credential_id: id,
    });
    expect((await login("mb-login", password)).status).toBe(200);
    expect((await login("mb-loginx", password)).status).toBe(401);
    expect((await login("mb-login@elsewhere.com", password)).status).toBe(401);
    expect((await login(sam.address, sam.token)).status).toBe(401);

    const listed = await (await call("/app-passwords", { token: sam.token })).json<{ app_passwords: { id: string; name: string; last_used_at: number | null }[] }>();
    expect(listed.app_passwords).toEqual([expect.objectContaining({ id, name: "iPhone", last_used_at: expect.any(Number) })]);

    // Revoking it stops new sign-ins and tells the IMAP service to end the sessions it opened.
    const { cursor } = await state(sam.id);
    expect((await call(`/app-passwords/${id}`, { method: "DELETE", token: sam.token })).status).toBe(204);
    expect((await login(sam.address, password)).status).toBe(401);
    const { changes } = await internal<Changes>(`/accounts/${sam.id}/changes?since=${cursor}`);
    expect(changes).toEqual([expect.objectContaining({ kind: "revoke", detail: id })]);
  });

  it("works for CalDAV too, and the admin can make one for setting up a phone", async () => {
    const sam = await createAccount("mb-dav");
    const made = await call(`/admin/accounts/${sam.id}/app-passwords`, { method: "POST", token: "admin", body: "{}" });
    const { password } = await made.json<{ password: string }>();
    const dav = await call("/dav/", { method: "PROPFIND", headers: { authorization: `Basic ${btoa(`${sam.address}:${password}`)}` } });
    expect(dav.status).toBe(207);
  });

  it("puts Mail in the iOS profile when the mail host is set", async () => {
    const sam = await createAccount("mb-profile");
    const body = await (await call(`/setup.mobileconfig?address=${sam.address}`)).text();
    expect(body).toContain("<key>PayloadType</key><string>com.apple.mail.managed</string>");
    expect(body).toContain("<key>IncomingMailServerHostName</key><string>mail.test.dev</string>");
    expect(body).toContain("<key>IncomingMailServerPortNumber</key><integer>993</integer>");
    expect(body).toContain("<key>OutgoingMailServerPortNumber</key><integer>465</integer>");
    expect(body).not.toContain("Password</key><string>");
  });
});

describe("repair", () => {
  it("gives folders to an address without them and files mail left without a mailbox", async () => {
    // As the Worker of before 0003_mailboxes would have left them.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO accounts (id, local, token_hash, created_at) VALUES ('old-account', 'mb-old', 'old-hash', 1)"),
      env.DB.prepare(
        "INSERT INTO messages (id, account_id, from_address, to_address, size, received_at) VALUES ('old-2', 'old-account', 'x@y', 'mb-old@test.dev', 5, 200), ('old-1', 'old-account', 'x@y', 'mb-old@test.dev', 5, 100)",
      ),
    ]);
    const repaired = await (await call("/admin/repair", { method: "POST", token: "admin" })).json<{ accounts: number; messages: number }>();
    expect(repaired).toMatchObject({ messages: 2 });
    const inbox = box(await state("old-account"), "INBOX");
    expect(inbox.messages.map((m) => [m.uid, m.blob])).toEqual([
      [1, "old-account/old-1.eml"],
      [2, "old-account/old-2.eml"],
    ]);
    expect(inbox.uid_next).toBe(3);
    expect(await (await call("/admin/repair", { method: "POST", token: "admin" })).json()).toEqual({ accounts: 0, messages: 0 });
  });

  it("lets new mail make the folders of an address that has none", async () => {
    await env.DB.prepare("INSERT INTO accounts (id, local, token_hash, created_at) VALUES ('bare-account', 'mb-bare', 'bare-hash', 1)").run();
    await deliver("mb-bare@test.dev", "first");
    expect(box(await state("bare-account"), "INBOX").messages).toHaveLength(1);
  });
});

describe("inbound SMTP", () => {
  it("says which recipients exist, and files delivered mail as Email Routing would", async () => {
    const sam = await createAccount("mb-inbound");
    expect((await call(`/internal/recipients/${encodeURIComponent("mb-inbound+news@test.dev")}`, { token: "internal" })).status).toBe(200);
    expect((await call("/internal/recipients/nobody%40test.dev", { token: "internal" })).status).toBe(404);
    expect((await call("/internal/recipients/mb-inbound%40elsewhere.com", { token: "internal" })).status).toBe(404);

    const raw = "From: Pat <pat@elsewhere.com>\r\nTo: mb-inbound@test.dev\r\nSubject: Over SMTP\r\n\r\nHello.";
    const delivered = await call("/internal/deliver?from=pat%40elsewhere.com&to=mb-inbound%40test.dev", { method: "POST", token: "internal", body: raw });
    expect(delivered.status).toBe(201);
    const listed = await (await call("/messages", { token: sam.token })).json<{ messages: { subject: string; from: { address: string } }[] }>();
    expect(listed.messages).toEqual([expect.objectContaining({ subject: "Over SMTP", from: expect.objectContaining({ address: "pat@elsewhere.com" }) })]);
    expect(box(await state(sam.id), "INBOX").messages).toHaveLength(1);

    expect((await call("/internal/deliver?from=x%40y.com&to=nobody%40test.dev", { method: "POST", token: "internal", body: raw })).status).toBe(404);
  });
});

describe("internal routes", () => {
  it("need the internal token, and answer 404 for an account that's gone", async () => {
    const sam = await createAccount("mb-gone");
    expect((await call(`/internal/accounts/${sam.id}/state`, { token: "admin" })).status).toBe(401);
    await call("/account", { method: "DELETE", token: sam.token });
    expect((await call(`/internal/accounts/${sam.id}/state`, { token: "internal" })).status).toBe(404);
  });
});
