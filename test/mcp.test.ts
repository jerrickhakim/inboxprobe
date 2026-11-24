import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

let nextId = 1;
const rpc = async (method: string, params: Record<string, unknown> = {}, ip = "198.51.100.1") => {
  const response = await exports.default.fetch(
    new Request("https://mail.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
  );
  expect(response.status).toBe(200);
  return response.json<{ result?: any; error?: { code: number } }>();
};
const tool = async (name: string, args: Record<string, unknown>, ip?: string) => (await rpc("tools/call", { name, arguments: args }, ip)).result;

async function deliver(to: string, raw: string) {
  const message = {
    from: "sender@elsewhere.com",
    to,
    raw: new Blob([raw]).stream(),
    rawSize: raw.length,
    headers: new Headers(),
    setReject: () => {},
  } as unknown as ForwardableEmailMessage;
  await worker.email(message, env as never);
}

describe("mcp", () => {
  it("initializes and lists the three tools", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.capabilities.tools).toEqual({});
    const list = await rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["create_inbox", "check_mail", "delete_inbox"]);
  });

  it("answers a notification with 202 and an unknown method with an error", async () => {
    const response = await exports.default.fetch(
      new Request("https://mail.test/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }),
    );
    expect(response.status).toBe(202);
    expect((await rpc("nope")).error?.code).toBe(-32601);
  });

  it("creates an inbox without the admin token, reads mail with codes and links, and deletes it", async () => {
    const created = await tool("create_inbox", { name: "mcp-flow" });
    expect(created.structuredContent.address).toBe("mcp-flow@test.dev");
    const { token } = created.structuredContent;

    expect((await tool("check_mail", { token })).structuredContent.message).toBeNull();

    await deliver(
      "mcp-flow@test.dev",
      ["From: App <app@elsewhere.com>", "To: mcp-flow@test.dev", "Subject: Your code", "", "Your code is 482913. Or open https://app.example/verify?t=abc (v2.5, build 1234.5)"].join("\r\n"),
    );
    const found = (await tool("check_mail", { token, subject: "code", wait_seconds: 5 })).structuredContent;
    expect(found.message.codes).toEqual(["482913"]);
    expect(found.message.links).toContain("https://app.example/verify?t=abc");
    expect(found.inbox).toHaveLength(1);
    // Read now, so it isn't found again.
    expect((await tool("check_mail", { token, subject: "code" })).structuredContent.message).toBeNull();
    expect((await tool("check_mail", { token, message_id: found.message.id })).structuredContent.message.subject).toBe("Your code");

    expect((await tool("delete_inbox", { token })).structuredContent.deleted).toBe(true);
    const gone = await tool("check_mail", { token });
    expect(gone.isError).toBe(true);
  });

  it("rate limits creating inboxes per IP", async () => {
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await tool("create_inbox", {}, "203.0.113.9"));
    expect(results.some((r) => r.isError && r.content[0].text.includes("Too many"))).toBe(true);
  });
});
