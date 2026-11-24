import { type Env, HttpError } from "./common";

// A public MCP server at /mcp (Streamable HTTP, stateless: every POST is answered with JSON, no sessions
// or SSE), so any agent can add it and get an inbox of its own:
//
//   create_inbox   { name? }                                  → { address, token }
//   check_mail     { token, message_id?, wait_seconds?, subject?, from? }
//                                                            → a message in full (links and codes pulled out) and the inbox
//   delete_inbox   { token }                                  → the address and all its mail, gone
//
// Anyone may create an inbox, so creating is rate limited per IP by the MCP_CREATE binding. A Worker
// without that binding has no MCP server: its addresses stay behind the admin token.
// The tools call the REST routes in index.ts, so the API and MCP answer the same.

type Call = (path: string, init?: RequestInit & { token?: string }) => Promise<Response>;
type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_WAIT = 50;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version, mcp-session-id",
};

const TOOLS = [
  {
    name: "create_inbox",
    description:
      "Create a real email address that can receive mail, for testing signup, verification, password reset, magic link, OTP and invite emails. Returns the address and a token; keep the token, the other tools need it and it is shown only once.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The part before the @. Leave it out for a random one." } },
    },
  },
  {
    name: "check_mail",
    description:
      "Read an inbox. With message_id, returns that message in full. Otherwise returns the oldest unread message matching subject/from (waiting up to wait_seconds for one to arrive) in full, with its links and one-time codes pulled out, and marks it read; plus the newest messages in the inbox.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "The token create_inbox returned." },
        message_id: { type: "string", description: "Read this message in full." },
        wait_seconds: { type: "number", description: `How long to wait for a matching unread message, 0–${MAX_WAIT}. Default 0.` },
        subject: { type: "string", description: "Only a message whose subject matches this (a case-insensitive regex)." },
        from: { type: "string", description: "Only a message whose sender's address matches this (a case-insensitive regex)." },
      },
      required: ["token"],
    },
  },
  {
    name: "delete_inbox",
    description: "Delete the address and every message in it. Do this when the test is done.",
    inputSchema: {
      type: "object",
      properties: { token: { type: "string", description: "The token create_inbox returned." } },
      required: ["token"],
    },
  },
];

export async function mcpRoute(request: Request, env: Env, call: Call): Promise<Response> {
  if (!env.MCP_CREATE) throw new HttpError(404, "Not found.");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return new Response("This MCP server answers POST only.", { status: 405, headers: { ...CORS, allow: "POST" } });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
  }
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const messages = (Array.isArray(body) ? body : [body]) as Rpc[];
  const answers = (await Promise.all(messages.map((message) => handle(message, env, call, ip)))).filter((a) => a !== null);
  if (!answers.length) return new Response(null, { status: 202, headers: CORS });
  return reply(Array.isArray(body) ? answers : answers[0]);
}

async function handle(message: Rpc, env: Env, call: Call, ip: string): Promise<object | null> {
  // A notification (no id) gets no answer.
  if (!message || typeof message !== "object" || message.id === undefined) return null;
  const { id, method, params = {} } = message;
  const ok = (result: object) => ({ jsonrpc: "2.0", id, result });

  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return ok({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "inboxprobe", version: "1.0.0" },
        instructions: `Real inboxes on @${env.DOMAIN} for testing email flows. create_inbox, then check_mail with wait_seconds after your app sends, then delete_inbox.`,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await runTool(String(params.name), args, env, call, ip);
        return ok({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result });
      } catch (error) {
        const text = error instanceof HttpError ? error.message : "Something went wrong.";
        if (!(error instanceof HttpError)) console.error(error);
        return ok({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `No method ${method}.` } };
  }
}

async function runTool(name: string, args: Record<string, unknown>, env: Env, call: Call, ip: string): Promise<Record<string, unknown>> {
  if (name === "create_inbox") {
    const { success } = await env.MCP_CREATE!.limit({ key: ip });
    if (!success) throw new HttpError(429, "Too many inboxes from here; wait a minute.");
    const created = await api(call, "/accounts", env.ADMIN_TOKEN, { method: "POST", body: JSON.stringify(args.name ? { name: args.name } : {}) });
    return { address: created.address, token: created.token };
  }

  const token = typeof args.token === "string" ? args.token : "";
  if (!token) throw new HttpError(400, "Pass the token create_inbox returned.");

  if (name === "delete_inbox") {
    await api(call, "/account", token, { method: "DELETE" });
    return { deleted: true };
  }

  if (name === "check_mail") {
    if (typeof args.message_id === "string" && args.message_id) {
      return { message: await read(call, token, args.message_id) };
    }
    const subject = pattern(args.subject, "subject");
    const from = pattern(args.from, "from");
    const deadline = Date.now() + Math.min(Math.max(Number(args.wait_seconds) || 0, 0), MAX_WAIT) * 1000;
    for (;;) {
      // Only unread mail counts, so waiting twice gets the second email.
      const { messages } = await api(call, "/messages?limit=50&unread=true", token);
      const hit = (messages as Summary[]).reverse().find((m) => (!subject || subject.test(m.subject ?? "")) && (!from || from.test(m.from.address ?? "")));
      if (hit) return { message: await read(call, token, hit.id), inbox: (await api(call, "/messages?limit=10", token)).messages };
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return { message: null, inbox: (await api(call, "/messages?limit=10", token)).messages };
  }

  throw new HttpError(400, `No tool ${name}.`);
}

type Summary = { id: string; subject: string | null; from: { address: string | null } };

/** The message in full, with its links and one-time codes pulled out, as the test-inbox skill's `read` gives it. */
async function read(call: Call, token: string, id: string) {
  const message = await api(call, `/messages/${encodeURIComponent(id)}`, token);
  const html: string = message.html ?? "";
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
  const bare = [...`${message.text ?? ""} ${html}`.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)].map((m) => m[0].replace(/&amp;/g, "&"));
  const links = [...new Set([...hrefs, ...bare].map(unwrap))].filter((l) => /^https?:/.test(l));
  const plain = `${message.subject ?? ""} ${message.text ?? html.replace(/<[^>]+>/g, " ")}`;
  const codes = [...new Set([...plain.matchAll(/(?<![\w/#=.-])\d{4,8}(?![\w/-]|\.\w)/g)].map((m) => m[0]))];
  return { ...message, links, codes };
}

/** Google's redirect wrapper (google.com/url?q=…), which Gmail-sent mail adds, unwrapped to the real link. */
function unwrap(link: string): string {
  try {
    const url = new URL(link);
    if (/(^|\.)google\.com$/.test(url.hostname) && url.pathname === "/url" && url.searchParams.get("q")) return url.searchParams.get("q")!;
  } catch {}
  return link;
}

function pattern(value: unknown, field: string): RegExp | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return new RegExp(value, "i");
  } catch {
    throw new HttpError(400, `\`${field}\` isn't a valid regex.`);
  }
}

/** A REST route's JSON answer; its error becomes the tool's. */
async function api(call: Call, path: string, token: string | undefined, init: RequestInit = {}): Promise<any> {
  const response = await call(path, { ...init, token });
  if (response.status === 204) return {};
  const body = await response.json<Record<string, unknown>>();
  if (!response.ok) throw new HttpError(response.status, String(body.error ?? "Something went wrong."));
  return body;
}

function reply(body: unknown): Response {
  return Response.json(body, { headers: CORS });
}
