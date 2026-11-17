import type { ActivityChoice, ActivityRow } from "../contracts/activity";
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
export const creditGone = new Map<string, { name: MyKeyEnv; stopped: string; owners: string[]; at: number; choice?: CreditChoice }>();

/**
 * What an owner picked for the work that waits until the credit is back (Gemini only, Home's Activity): its timelines on
 * Antigravity, picture only, or none (Timelines off in those libraries). Kept until a call on the key works again.
 */
export type CreditChoice = "antigravity" | "without";

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
  creditGone.set(id, { ...was, name, stopped, owners, at: now });
  const text = `Out of credit, so it stopped. Top it up at ${TOP_UP[name] ?? "the service's site"}`;
  void import("./review")
    .then(({ notifyWorkshopOwner }) =>
      Promise.all(owners.map((o) => notifyWorkshopOwner(o, { kind: "failed", by: serviceName(name), name: stopped, text, href: "/settings/keys", ref: `credit:${name}` }))),
    )
    .catch(() => {});
}

/** What `key`'s owners picked while its credit is out (CreditChoice), if anything. */
export const creditChoice = (name: MyKeyEnv, key: string): CreditChoice | undefined => (key ? creditGone.get(`${name}:${key}`)?.choice : undefined);

/** `username` picked `choice` for `name`'s keys of theirs that are out of credit: the owners those keys serve (none: it is not theirs). */
export function chooseCredit(name: MyKeyEnv, username: string, choice: CreditChoice): string[] {
  const owners = new Set<string>();
  for (const g of creditGone.values())
    if (g.name === name && g.owners.includes(username)) {
      g.choice = choice;
      g.owners.forEach((o) => owners.add(o));
    }
  return [...owners];
}

/** A call on `key` worked: its credit is back, its warning goes. */
export function creditBack(name: MyKeyEnv, key: string): void {
  if (creditGone.size) creditGone.delete(`${name}:${key}`);
}

const serviceName = (name: MyKeyEnv) => MY_KEYS.find((k) => k.env === name)?.name ?? name;

/** The buttons of a key's row: Top up, and for Gemini the waiting timelines on Antigravity (`antigravity`: it runs) or none; Deepgram: the voice settings, where another model can write instead. */
function choicesOf(name: MyKeyEnv, choice: CreditChoice | undefined, antigravity: boolean): ActivityChoice[] {
  const top: ActivityChoice = { label: "Top up", url: `https://${TOP_UP[name] ?? ""}` };
  const out = TOP_UP[name] ? [top] : [];
  if (name === "DEEPGRAM_API_KEY") out.push({ label: "Use another voice model", url: "/settings/voice" });
  if (name !== "GEMINI_API_KEY") return out;
  if (antigravity && choice !== "antigravity") out.push({ label: "Use Antigravity until then", post: "/api/activity/credit/GEMINI_API_KEY/antigravity" });
  out.push({ label: "Continue without", post: "/api/activity/credit/GEMINI_API_KEY/without" });
  return out;
}

/** What a key's row says: what stopped, or what runs instead since its owner picked it. */
const detailOf = (g: { name: MyKeyEnv; stopped: string; choice?: CreditChoice }) =>
  g.choice === "antigravity"
    ? "Timelines are made on Antigravity, picture only, until it is topped up"
    : g.name === "GEMINI_API_KEY"
      ? `${g.stopped} wait · the rest carries on without Gemini`
      : `${g.stopped} stopped · top up at ${TOP_UP[g.name] ?? "the service's site"}`;

/** Home's Activity rows for `username`: each of their keys out of credit, waiting on them, with what they can do (choicesOf); one they let go on without (Continue without) waits no more. */
export const creditRows = (username: string, antigravity = false): ActivityRow[] =>
  [...creditGone.values()]
    .filter((g) => g.owners.includes(username) && g.choice !== "without")
    .map((g) => ({
      id: `credit:${g.name}`,
      title: `${serviceName(g.name)}: out of credit`,
      detail: detailOf(g),
      state: "ready",
      href: "/settings/keys",
      choices: choicesOf(g.name, g.choice, antigravity),
    }));
