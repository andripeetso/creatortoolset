import type { ActivityRow } from "../contracts/activity";
import { MY_KEYS, type MyKeyEnv } from "../contracts/service-keys";
import { env } from "./lib/env";
import { isAdminActor, keyFor } from "./my-keys";
import { listUsers, LOCAL_USER } from "./users";

/**
 * Shared "the paid API is empty" detection so Deepgram, ElevenLabs, and
 * the cadence models all surface the same user-facing ask: tell the admin.
 */

export const OUT_OF_CREDITS_CODE = "OUT_OF_CREDITS";

export const outOfCreditsMessage = (what: string) =>
  `${what} is out of credits, so it can't run. Tell the admin so they can top it up.`;

/** Quota / billing exhaustion — not a per-minute rate limit. */
export function isOutOfCredits(status: number, body: string): boolean {
  if (status === 402) return true;
  const text = body.toLowerCase();
  return (
    /insufficient[_\s-]?quota/.test(text) ||
    /exceeded your current quota/.test(text) ||
    /credit balance is too low/.test(text) ||
    /purchase credits/.test(text) ||
    /billing_not_active/.test(text) ||
    /quota[_\s-]?exceeded/.test(text) ||
    /quota_exceeded/.test(text) ||
    /out of credits/.test(text) ||
    /insufficient credits/.test(text) ||
    /insufficient[_\s-]?funds/.test(text) ||
    /insufficient[_\s-]?credits/.test(text) ||
    /balance is not enough/.test(text) ||
    /payment required/.test(text) ||
    /payment_required/.test(text) ||
    /usage limit/.test(text) ||
    // Google AI Studio's prepay: "Your prepayment credits are depleted"
    /prepayment credits/.test(text) ||
    /credits are depleted/.test(text)
  );
}

/** Where each service's credit is topped up. */
const TOP_UP: Partial<Record<MyKeyEnv, string>> = {
  GEMINI_API_KEY: "aistudio.google.com/billing",
  DEEPGRAM_API_KEY: "console.deepgram.com",
  ELEVENLABS_API_KEY: "elevenlabs.io/app/subscription",
  ANTHROPIC_API_KEY: "console.anthropic.com/settings/billing",
  OPENAI_API_KEY: "platform.openai.com/settings/organization/billing",
  PERPLEXITY_API_KEY: "perplexity.ai/account/api",
};
const DAY = 24 * 3600_000;

/**
 * Keys whose credit ran out, by service and key: who was told, what stopped, when. A key's owner hears it once a day at
 * most (an inbox note: the Mac app shows it) and sees it on Home's Activity until a call on the key works again.
 * ponytail: in memory; a restart forgets, and the next failed call tells again
 */
export const creditGone = new Map<string, { name: MyKeyEnv; stopped: string; owners: string[]; at: number }>();

/** Who `key` serves: the accounts it is their own key for (keyFor), else the admins (the server's key). */
function ownersOf(name: MyKeyEnv, key: string): string[] {
  const all = [...listUsers().map((u) => u.username), ...(env.appSecret ? [] : [LOCAL_USER.username])];
  const own = all.filter((u) => keyFor(u, name).key === key);
  return own.length ? own : all.filter(isAdminActor);
}

/** `name`'s credit on `key` ran out and `stopped` (a few words: what no longer runs) stopped: its owners are told, once a day at most. */
export function creditOut(name: MyKeyEnv, key: string, stopped: string, now = Date.now()): void {
  if (!key) return;
  const id = `${name}:${key}`;
  const was = creditGone.get(id);
  if (was && now - was.at < DAY) return;
  const owners = ownersOf(name, key);
  creditGone.set(id, { name, stopped, owners, at: now });
  const text = `Out of credit, so it stopped. Top it up at ${TOP_UP[name] ?? "the service's site"}`;
  void import("./review")
    .then(({ notifyWorkshopOwner }) =>
      Promise.all(owners.map((o) => notifyWorkshopOwner(o, { kind: "failed", by: serviceName(name), name: stopped, text, href: "/settings/keys", ref: `credit:${name}` }))),
    )
    .catch(() => {});
}

/** A call on `key` worked: its credit is back, its warning goes. */
export function creditBack(name: MyKeyEnv, key: string): void {
  if (creditGone.size) creditGone.delete(`${name}:${key}`);
}

const serviceName = (name: MyKeyEnv) => MY_KEYS.find((k) => k.env === name)?.name ?? name;

/** Home's Activity rows for `username`: each of their keys out of credit, waiting on them. */
export const creditRows = (username: string): ActivityRow[] =>
  [...creditGone.values()]
    .filter((g) => g.owners.includes(username))
    .map((g) => ({
      id: `credit:${g.name}`,
      title: `${serviceName(g.name)}: out of credit`,
      detail: `${g.stopped} stopped · top up at ${TOP_UP[g.name] ?? "the service's site"}`,
      state: "ready",
      href: "/settings/keys",
    }));
