import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker, { parseAddress } from "../src/index";

const call = (path: string, init: RequestInit & { token?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  return exports.default.fetch(new Request(`https://mail.test${path}`, { ...init, headers }));
};

async function createAccount(name?: string) {
  const response = await call("/accounts", { method: "POST", token: "admin", body: JSON.stringify(name ? { name } : {}) });
  expect(response.status).toBe(201);
  return response.json<{ id: string; address: string; token: string }>();
}

/** Delivers `raw` to `to` the way Email Routing does; true when it was accepted. */
async function deliver(to: string, raw: string, from = "sender@elsewhere.com") {
  let rejected: string | undefined;
  const message = {
    from,
    to,
    raw: new Blob([raw]).stream(),
    rawSize: raw.length,
    headers: new Headers(),
    setReject: (reason: string) => (rejected = reason),
    forward: async () => ({ messageId: "" }),
    reply: async () => ({ messageId: "" }),
  } as unknown as ForwardableEmailMessage;
  await worker.email(message, env as never);
  return rejected === undefined;
}

const plain = (subject: string, body = "Hello there.") =>
  [`From: Sam <sender@elsewhere.com>`, `To: x@test.dev`, `Subject: ${subject}`, `Message-ID: <${subject}@elsewhere.com>`, "", body].join("\r\n");

const withAttachment = [
  "From: sender@elsewhere.com",
  "To: x@test.dev",
  "Subject: Files",
  'Content-Type: multipart/mixed; boundary="b"',
  "",
  "--b",
  "Content-Type: text/plain",
  "",
  "See attached.",
  "--b",
  'Content-Type: text/plain; name="notes.txt"',
  'Content-Disposition: attachment; filename="notes.txt"',
  "Content-Transfer-Encoding: base64",
  "",
  btoa("the notes"),
  "--b--",
].join("\r\n");

describe("accounts", () => {
  it("makes an address with a token, which reads it back", async () => {
    const account = await createAccount("jerrick");
    expect(account.address).toBe("jerrick@test.dev");
    expect(account.token).toMatch(/^mt_/);

    const me = await (await call("/account", { token: account.token })).json<Record<string, unknown>>();
    expect(me).toMatchObject({ address: "jerrick@test.dev", messages: 0, unread: 0 });
  });

  it("picks a random name when none is given", async () => {
    const account = await createAccount();
    expect(account.address).toMatch(/^[a-z0-9]{10}@test\.dev$/);
  });

  it("refuses taken, reserved and malformed names", async () => {
    await createAccount("taken");
    const make = (name: string) => call("/accounts", { method: "POST", token: "admin", body: JSON.stringify({ name }) });
    expect((await make("Taken")).status).toBe(409);
    expect((await make("postmaster")).status).toBe(409);
    for (const name of ["-dash", "a..b", "a+b", "has space", "x".repeat(65)]) expect((await make(name)).status).toBe(400);
  });

  it("needs the admin token to create, when one is set", async () => {
    expect((await call("/accounts", { method: "POST" })).status).toBe(401);
    expect((await call("/accounts", { method: "POST", token: "wrong" })).status).toBe(401);
  });

  it("refuses requests without a valid token", async () => {
    expect((await call("/messages")).status).toBe(401);
    expect((await call("/messages", { token: "mt_nope" })).status).toBe(401);
  });

  it("deletes the account and its mail; the address then rejects", async () => {
    const account = await createAccount("leaving");
    await deliver("leaving@test.dev", plain("bye"));
    expect((await env.MAIL.list({ prefix: `${account.id}/` })).objects).toHaveLength(1);

    expect((await call("/account", { method: "DELETE", token: account.token })).status).toBe(204);
    expect((await call("/account", { token: account.token })).status).toBe(401);
    expect((await env.MAIL.list({ prefix: `${account.id}/` })).objects).toHaveLength(0);
    expect(await deliver("leaving@test.dev", plain("again"))).toBe(false);
  });
});

describe("mail", () => {
  it("rejects mail for addresses that don't exist or other domains", async () => {
    await createAccount("real");
    expect(await deliver("ghost@test.dev", plain("hi"))).toBe(false);
    expect(await deliver("real@other.dev", plain("hi"))).toBe(false);
  });

  it("stores mail, lists it newest first, and reads it in full", async () => {
    const account = await createAccount("reader");
    expect(await deliver("Reader+news@TEST.dev", plain("first", "The first one."))).toBe(true);
    expect(await deliver("reader@test.dev", plain("second"))).toBe(true);

    const list = await (await call("/messages", { token: account.token })).json<any>();
    expect(list.messages.map((m: any) => m.subject)).toEqual(["second", "first"]);
    expect(list.messages[1]).toMatchObject({ from: { address: "sender@elsewhere.com", name: "Sam" }, snippet: "The first one.", read: false });

    const full = await (await call(`/messages/${list.messages[1].id}`, { token: account.token })).json<any>();
    expect(full).toMatchObject({ subject: "first", text: expect.stringContaining("The first one."), read: true, message_id: "<first@elsewhere.com>" });

    const unread = await (await call("/messages?unread=true", { token: account.token })).json<any>();
    expect(unread.messages.map((m: any) => m.subject)).toEqual(["second"]);

    const raw = await call(`/messages/${list.messages[1].id}/raw`, { token: account.token });
    expect(raw.headers.get("content-type")).toBe("message/rfc822");
    expect(new TextDecoder().decode(await raw.arrayBuffer())).toContain("Subject: first");
  });

  it("pages with the next cursor", async () => {
    const account = await createAccount("pager");
    for (const n of [1, 2, 3]) {
      await deliver("pager@test.dev", plain(`m${n}`));
      await new Promise((r) => setTimeout(r, 2));
    }
    const first = await (await call("/messages?limit=2", { token: account.token })).json<any>();
    expect(first.messages.map((m: any) => m.subject)).toEqual(["m3", "m2"]);
    const second = await (await call(`/messages?limit=2&before=${first.next}`, { token: account.token })).json<any>();
    expect(second.messages.map((m: any) => m.subject)).toEqual(["m1"]);
    expect(second.next).toBeNull();
  });

  it("serves attachments", async () => {
    const account = await createAccount("files");
    await deliver("files@test.dev", withAttachment);
    const [summary] = (await (await call("/messages", { token: account.token })).json<any>()).messages;
    expect(summary.attachments).toBe(1);

    const full = await (await call(`/messages/${summary.id}`, { token: account.token })).json<any>();
    expect(full.attachments).toEqual([{ index: 0, filename: "notes.txt", mime_type: "text/plain", size: 9, inline: false }]);

    const file = await call(`/messages/${summary.id}/attachments/0`, { token: account.token });
    expect(await file.text()).toBe("the notes");
    expect((await call(`/messages/${summary.id}/attachments/1`, { token: account.token })).status).toBe(404);
  });

  it("keeps each account's mail to itself, and deletes messages", async () => {
    const a = await createAccount("alice");
    const b = await createAccount("bob");
    await deliver("alice@test.dev", plain("private"));
    const [message] = (await (await call("/messages", { token: a.token })).json<any>()).messages;

    expect((await call(`/messages/${message.id}`, { token: b.token })).status).toBe(404);
    expect((await call(`/messages/${message.id}`, { method: "DELETE", token: b.token })).status).toBe(404);

    expect((await call(`/messages/${message.id}`, { method: "DELETE", token: a.token })).status).toBe(204);
    expect((await call(`/messages/${message.id}`, { token: a.token })).status).toBe(404);
    expect((await env.MAIL.list({ prefix: `${a.id}/` })).objects).toHaveLength(0);
  });
});

describe("admin", () => {
  it("needs the admin token, not an account's", async () => {
    const account = await createAccount("notadmin");
    expect((await call("/admin/accounts")).status).toBe(401);
    expect((await call("/admin/accounts", { token: account.token })).status).toBe(401);
    expect((await call("/admin/messages", { token: "admin" })).status).toBe(200);
  });

  it("lists every account with counts, latest mail first", async () => {
    await createAccount("quiet");
    await createAccount("busy");
    await deliver("busy@test.dev", plain("one"));
    await deliver("busy@test.dev", plain("two"));
    const { accounts } = await (await call("/admin/accounts", { token: "admin" })).json<any>();
    const busy = accounts.find((a: any) => a.address === "busy@test.dev");
    expect(busy).toMatchObject({ messages: 2, unread: 2 });
    expect(busy.last_received_at).toBeGreaterThan(0);
    expect(accounts[0].address).toBe("busy@test.dev");
    expect(accounts.find((a: any) => a.address === "quiet@test.dev")).toMatchObject({ messages: 0, unread: 0, last_received_at: null });
  });

  it("lists mail across inboxes, filters it, and reads it without marking it read", async () => {
    const a = await createAccount("ann");
    await createAccount("ben");
    await deliver("ann@test.dev", plain("invoice 7"));
    await deliver("ben@test.dev", plain("estimate 3"));

    const all = await (await call("/admin/messages", { token: "admin" })).json<any>();
    expect(all.messages.map((m: any) => m.account.address)).toEqual(expect.arrayContaining(["ann@test.dev", "ben@test.dev"]));
    const onlyAnn = await (await call(`/admin/messages?account=${a.id}`, { token: "admin" })).json<any>();
    expect(onlyAnn.messages.map((m: any) => m.subject)).toEqual(["invoice 7"]);
    const search = await (await call("/admin/messages?q=estimate", { token: "admin" })).json<any>();
    expect(search.messages.map((m: any) => m.subject)).toEqual(["estimate 3"]);

    const full = await (await call(`/admin/messages/${onlyAnn.messages[0].id}`, { token: "admin" })).json<any>();
    expect(full).toMatchObject({ subject: "invoice 7", read: false, text: expect.stringContaining("Hello") });
    const stillUnread = await (await call("/messages?unread=true", { token: a.token })).json<any>();
    expect(stillUnread.messages).toHaveLength(1);
  });

  it("deletes a message or a whole account", async () => {
    const a = await createAccount("gone");
    await deliver("gone@test.dev", plain("x"));
    await deliver("gone@test.dev", plain("y"));
    const { messages } = await (await call(`/admin/messages?account=${a.id}`, { token: "admin" })).json<any>();

    expect((await call(`/admin/messages/${messages[0].id}`, { method: "DELETE", token: "admin" })).status).toBe(204);
    expect((await (await call("/account", { token: a.token })).json<any>()).messages).toBe(1);

    expect((await call(`/admin/accounts/${a.id}`, { method: "DELETE", token: "admin" })).status).toBe(204);
    expect((await call("/account", { token: a.token })).status).toBe(401);
    expect((await env.MAIL.list({ prefix: `${a.id}/` })).objects).toHaveLength(0);
    expect((await call(`/admin/accounts/${a.id}`, { method: "DELETE", token: "admin" })).status).toBe(404);
  });
});

describe("parseAddress", () => {
  it("takes the local part on the domain, without a +tag", () => {
    expect(parseAddress("Jerrick+shop@Example.com", "example.com")).toBe("jerrick");
    expect(parseAddress("jerrick@sub.example.com", "example.com")).toBeNull();
    expect(parseAddress("+tag@example.com", "example.com")).toBeNull();
  });
});

describe("without a DOMAIN", () => {
  const unset = { ...env, DOMAIN: "" } as never;

  it("answers every request with how to set it", async () => {
    const response = await worker.fetch(new Request("https://mail.test/health"), unset);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("DOMAIN") });
  });

  it("rejects incoming mail", async () => {
    let rejected: string | undefined;
    const message = { to: "sam@example.com", setReject: (reason: string) => (rejected = reason) };
    await worker.email(message as unknown as ForwardableEmailMessage, unset);
    expect(rejected).toBeTruthy();
  });
});
