// What the mail routes (index.ts) and the calendar (calendar.ts) both use.

export interface Env {
  DB: D1Database;
  MAIL: R2Bucket;
  DOMAIN: string;
  ADMIN_TOKEN?: string;
  /** The key an IMAP/SMTP service (not in this repo) uses for /internal/*. Without it those routes are off. */
  INTERNAL_TOKEN?: string;
  /** Where that service answers (mail.example.com). When set, the iOS profile adds the Mail account too. */
  MAIL_HOST?: string;
  /** Caps public inbox creation over /mcp per IP. Without it there's no MCP server (mcp.ts). */
  MCP_CREATE?: RateLimit;
}

export type Account = { id: string; local: string; created_at: number };

export const MAX_LIMIT = 100;

export function limitParam(url: URL): number {
  return Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), MAX_LIMIT);
}

/** The local part `to` is for on `domain`, lowercased and without a +tag; null when it's another domain's. */
export function parseAddress(to: string, domain: string): string | null {
  const at = to.lastIndexOf("@");
  if (at < 1 || to.slice(at + 1).toLowerCase() !== domain.toLowerCase()) return null;
  return to.slice(0, at).toLowerCase().split("+")[0] || null;
}

export function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  return header?.match(/^Bearer\s+(.+)$/i)?.[1].trim() ?? null;
}

/** The account a token belongs to, or null. */
export function accountByToken(token: string, env: Env): Promise<Account | null> {
  return sha256(token).then((hash) => env.DB.prepare("SELECT id, local, created_at FROM accounts WHERE token_hash = ?").bind(hash).first<Account>());
}

/** Compares two secrets in constant time (by their digests, so lengths don't leak either). */
export async function sameSecret(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([given, expected].map((s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
  return crypto.subtle.timingSafeEqual(a, b);
}

export function randomString(length: number, alphabet: "alnum" | "base64url" | "lower"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  if (alphabet === "base64url") return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const chars = alphabet === "lower" ? "abcdefghijklmnopqrstuvwxyz" : "abcdefghijklmnopqrstuvwxyz0123456789";
  // 256 isn't a multiple of the alphabet's size, so the bytes past its last multiple are redrawn to keep every character equally likely.
  const limit = 256 - (256 % chars.length);
  let out = "";
  for (const byte of bytes) out += byte < limit ? chars[byte % chars.length] : "";
  return out.length === length ? out : out + randomString(length - out.length, alphabet);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  throw new HttpError(400, "The body must be a JSON object.");
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers?: HeadersInit,
  ) {
    super(message);
  }
}
