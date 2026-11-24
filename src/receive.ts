import PostalMime from "postal-mime";
import { addInvites } from "./calendar";
import { type Account, type Env, parseAddress } from "./common";
import { addMessage, inbox } from "./mail";

// Mail arriving for an address, from either door: Cloudflare Email Routing (email() in index.ts) or
// the mail service's own inbound SMTP (POST /internal/deliver), for a domain whose MX points at it.

/** The account mail to `to` belongs to (name+tag@DOMAIN included), or null. */
export function recipientAccount(env: Env, to: string): Promise<Account | null> {
  const local = parseAddress(to, env.DOMAIN);
  if (!local) return Promise.resolve(null);
  return env.DB.prepare("SELECT id, local, created_at FROM accounts WHERE local = ?").bind(local).first<Account>();
}

/** Files a message in the account's INBOX, and any invite in it in the calendar. */
export async function receive(env: Env, account: Account, raw: ArrayBuffer, envelopeFrom: string, envelopeTo: string) {
  const parsed = await PostalMime.parse(raw);
  await addMessage(env, await inbox(env, account.id), { raw, parsed, envelopeFrom, envelopeTo });
  // The mail is already kept, so a bad invite only logs.
  await addInvites(account.id, parsed, env).catch((error) => console.error("invite", error));
}
