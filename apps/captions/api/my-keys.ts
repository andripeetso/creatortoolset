import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { AuthVars } from "./auth";
import { env } from "./lib/env";
import { providerSettings } from "./lib/providers";
import { budgetLeft } from "./lib/workspaces";
import { DEMO_USER, findUser, isDemoName, isGuestName, LOCAL_USER, USERNAME_RE, type SessionUser } from "./users";
import { MY_KEYS, type MyKeyEnv, type MyKeyView } from "../contracts/service-keys";

/**
 * Settings → My API keys (contracts/service-keys.ts MY_KEYS) and the one resolver every paid service call goes
 * through. Each account's keys: $DATA_DIR/my-keys/<username>.json (0600), never logged, never sent back (last 4 only).
 *
 * keyFor(actor, service): the actor's own key; else the server's key (Settings → API keys or the .env) only for the
 * platform admin (not the Anthropic key: an admin's AI is their own provider or key), a member whose workspace owner gave them an API budget (services the budget can price, billed with
 * addSpend by the caller), or a guest or the demo when an admin switched that on; else none, with the message that
 * says which key to add. No actor = none: background work always names whose work it is.
 */

const DIR = () => path.join(env.dataDir, "my-keys");
const NAMES = new Set<string>(MY_KEYS.map((k) => k.env));
const nameOf = (e: MyKeyEnv) => MY_KEYS.find((k) => k.env === e)!.name;
// ponytail: the budget is one dollar figure, so it covers only the services the app can price (AI tokens,
// transcript minutes); a per-service budget if owners want to pay for audio or research too
const BUDGETED = new Set<MyKeyEnv>(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPGRAM_API_KEY"]);

type Keys = Partial<Record<MyKeyEnv, string>>;
const cache = new Map<string, Keys>();

function fileOf(username: string): string | null {
  const u = username.toLowerCase();
  return USERNAME_RE.test(u) && !isGuestName(u) && !isDemoName(u) ? path.join(DIR(), `${u}.json`) : null;
}

export function myKeys(username: string): Keys {
  const hit = cache.get(username);
  if (hit) return hit;
  const file = fileOf(username);
  let keys: Keys = {};
  try {
    if (file) keys = JSON.parse(readFileSync(file, "utf-8")) as Keys;
  } catch {
    /* none saved */
  }
  cache.set(username, keys);
  return keys;
}

export function saveMyKey(username: string, name: MyKeyEnv, value: string | null): void {
  const file = fileOf(username);
  if (!file) throw new Error("No keys for this account");
  const next = { ...myKeys(username) };
  if (value) next[name] = value;
  else delete next[name];
  mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  renameSync(tmp, file);
  cache.set(username, next);
}

/** An account was deleted: its keys go with it. */
export function forgetMyKeys(username: string): void {
  const file = fileOf(username);
  if (file) rmSync(file, { force: true });
  cache.delete(username);
}

/** Who asks: a session, or a username (background work names its owner). */
export type Actor = Pick<SessionUser, "username" | "role" | "demo"> | string | null | undefined;

export type KeyRoute = { key: string; bill?: string; missing?: undefined } | { key: ""; bill?: undefined; missing: string };

export const addKeyMessage = (name: MyKeyEnv) => `Add your ${nameOf(name)} key in Settings → My API keys`;

/** A platform admin, or the solo install's own account (APP_SECRET unset): the server's keys are theirs. */
export const isAdminActor = (name: string) => findUser(name)?.role === "admin" || (!env.appSecret && name === LOCAL_USER.username);

function who(actor: Actor): { username: string; guest: boolean; demo: boolean; admin: boolean } {
  const username = (typeof actor === "string" ? actor : actor?.username) ?? "";
  const role = typeof actor === "object" && actor ? actor.role : undefined;
  const guest = role === "guest" || isGuestName(username);
  const demo = (typeof actor === "object" && !!actor?.demo) || username === DEMO_USER || isDemoName(username);
  return { username, guest, demo, admin: !guest && !demo && !!username && (role === "admin" || isAdminActor(username)) };
}

export function keyFor(actor: Actor, name: MyKeyEnv): KeyRoute {
  const w = who(actor);
  const server = process.env[name] || "";
  if (w.guest || w.demo) {
    const on = w.guest ? providerSettings().api.guests : providerSettings().api.demo;
    if (on && server) return { key: server };
    return { key: "", missing: `${nameOf(name)} is off ${w.guest ? "in guest mode: sign in with an account" : "for the demo"}` };
  }
  if (!w.username) return { key: "", missing: addKeyMessage(name) };
  const own = myKeys(w.username)[name];
  if (own) return { key: own };
  // the server's Anthropic key is never the admin's AI: their AI is their own provider or their own key (ai-complete.ts aiFor)
  if (w.admin) return server && name !== "ANTHROPIC_API_KEY" ? { key: server } : { key: "", missing: addKeyMessage(name) };
  const left = BUDGETED.has(name) ? budgetLeft(w.username) : null;
  if (left !== null && left <= 0) return { key: "", missing: `Your API budget for this month is used up: ask your workspace's owner, or ${addKeyMessage(name).toLowerCase()}` };
  if (left !== null && server) return { key: server, bill: w.username };
  return { key: "", missing: addKeyMessage(name) };
}

/** Settings → My API keys. Accounts only: a guest or a demo visitor has none (the server's, when switched on). */
export const myKeysApp = new Hono<{ Variables: AuthVars }>();

myKeysApp.use("*", async (c, next) => {
  const u = c.get("user");
  return u.role === "guest" || u.demo || isDemoName(u.username) || u.username === DEMO_USER ? c.json({ error: "Sign in with an account to keep your own keys" }, 403) : next();
});

myKeysApp.get("/", (c) => {
  const u = c.get("user");
  const mine = myKeys(u.username);
  return c.json(
    MY_KEYS.map((k): MyKeyView => {
      const value = mine[k.env];
      const r = value ? null : keyFor(u, k.env);
      return {
        env: k.env, name: k.name, what: k.what, ...("where" in k ? { where: k.where } : {}),
        set: !!value, ...(value ? { last4: value.slice(-4) } : {}),
        ...(r?.key ? { server: r.bill ? "budget" : "admin" } : {}),
      } as MyKeyView;
    }),
  );
});

myKeysApp.put("/:env", async (c) => {
  const name = c.req.param("env");
  if (!NAMES.has(name)) return c.json({ error: "No such key" }, 404);
  const b = (await c.req.json().catch(() => null)) as { value?: unknown } | null;
  const value = typeof b?.value === "string" ? b.value.trim() : b?.value === null ? null : undefined;
  if (value === undefined || value === "" || (value && (value.length > 500 || /\s/.test(value))))
    return c.json({ error: "Paste the key (one line, no spaces), or null to forget it" }, 400);
  saveMyKey(c.get("user").username, name as MyKeyEnv, value);
  return c.json({ ok: true });
});
