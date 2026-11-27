import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { AuthVars } from "./auth";
import { env } from "./lib/env";
import { findUser, LOCAL_USER, USERNAME_RE, type SessionUser } from "./users";
import { keySaved, serverKeyFrom, teamUseOn } from "./service-keys";
import { localModelApp } from "./local-model";
import { budgetRefusal, type Holder } from "./lib/service-usage";
import { budgetLeft, teamRefusal, workspaceOf } from "./lib/workspaces";
import { JOBS, type JobId } from "../contracts/providers";
import { MY_KEYS, type MyKeyEnv, type MyKeyView } from "../contracts/service-keys";

/**
 * Settings → API keys (contracts/service-keys.ts MY_KEYS) and the one resolver every paid service call goes
 * through. Each account's keys: $DATA_DIR/my-keys/<username>.json (0600), never logged, never sent back (last 4 only).
 *
 * keyFor(actor, service): the actor's own key; else the server's key (Settings → API keys or the .env) only for the
 * platform admin (not the Anthropic key: an admin's AI is their own provider or key); else none, with the message
 * that says which key to add. No actor = none: background work always names whose work it is.
 */

const DIR = () => path.join(env.dataDir, "my-keys");
const NAMES = new Set<string>(MY_KEYS.map((k) => k.env));
const nameOf = (e: MyKeyEnv) => MY_KEYS.find((k) => k.env === e)!.name;

type Keys = Partial<Record<MyKeyEnv, string>>;
const cache = new Map<string, Keys>();

function fileOf(username: string): string | null {
  const u = username.toLowerCase();
  return USERNAME_RE.test(u) ? path.join(DIR(), `${u}.json`) : null;
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

/** Who asks: a session, or a username (background work names its owner). */
export type Actor = Pick<SessionUser, "username" | "role"> | string | null | undefined;

export type KeyRoute = { key: string; missing?: undefined } | { key: ""; missing: string };

export const addKeyMessage = (name: MyKeyEnv) => `Add your ${nameOf(name)} key in Settings → API keys`;

/** A platform admin, or the solo install's own account (APP_SECRET unset): the server's keys are theirs. */
export const isAdminActor = (name: string) => findUser(name)?.role === "admin" || (!env.appSecret && name === LOCAL_USER.username);

/**
 * The server's key (the .env's, or the one pasted in Server keys) that serves this actor: an admin, or a member of an
 * admin's team while the Team use switch is on; "" otherwise.
 */
export function serverKeyOf(actor: Actor, name: MyKeyEnv): string {
  const username = (typeof actor === "string" ? actor : actor?.username) ?? "";
  const role = typeof actor === "object" && actor ? actor.role : undefined;
  if (!username || role === "visitor") return "";
  // the server's Anthropic key is never the admin's AI: their AI is their own provider or their own key (ai-complete.ts aiFor)
  if (name === "ANTHROPIC_API_KEY") return "";
  return role === "admin" || isAdminActor(username) || hostsTeam(username) ? process.env[name] || "" : "";
}

/**
 * Team use is on and this account is on a team an admin of this server owns. A customer's team on a hosted server never
 * gets the server's keys: only its AI budget, which is billed (teamAiKey).
 */
function hostsTeam(username: string): boolean {
  if (!teamUseOn()) return false;
  const owner = workspaceOf(username)?.members.find((m) => m.role === "owner")?.username;
  return !!owner && owner !== username && isAdminActor(owner);
}

/**
 * The server's Anthropic key for one call of a member on a team budget (ai-complete.ts onBudget, its only caller): only
 * while the admin's Team use switch is on (Settings → API keys → Server keys), the team allows the tool, and both the
 * member's and the team's monthly budgets have money left; else what is missing. Its own AI never gets it.
 */
export function teamAiKey(username: string, job: JobId): KeyRoute {
  const left = budgetLeft(username);
  if (left === null) return { key: "", missing: "No team budget for this account" };
  if (!teamUseOn()) return { key: "", missing: "Needs Team use on this server: ask the admin" };
  const refused = teamRefusal(username, job);
  if (refused === "tool") return { key: "", missing: `${JOBS.find((j) => j.id === job)?.label ?? job} can't use the server's key: ask the admin` };
  if (left <= 0) return { key: "", missing: "Budget used up this month: ask the admin" };
  if (refused === "team budget") return { key: "", missing: "Team budget used up this month: ask the admin" };
  const key = process.env.ANTHROPIC_API_KEY || "";
  return key ? { key } : { key: "", missing: "Needs an Anthropic key on this server: ask the admin" };
}

/** The actor has this key (their own, or the server's that serves them), whatever its budget: for "which keys are set" (Home, setup), never to run a call. */
export function hasKey(actor: Actor, name: MyKeyEnv): boolean {
  const username = (typeof actor === "string" ? actor : actor?.username) ?? "";
  const role = typeof actor === "object" && actor ? actor.role : undefined;
  return !!username && role !== "visitor" && (!!myKeys(username)[name] || !!serverKeyOf(actor, name));
}

export function keyFor(actor: Actor, name: MyKeyEnv): KeyRoute {
  const username = (typeof actor === "string" ? actor : actor?.username) ?? "";
  const role = typeof actor === "object" && actor ? actor.role : undefined;
  if (!username || role === "visitor") return { key: "", missing: addKeyMessage(name) };
  // a key that spent its monthly budget (Settings → API keys) serves nothing until next month or a higher budget
  const held = (holder: Holder): KeyRoute | null => {
    const why = budgetRefusal(name, holder);
    return why ? { key: "", missing: why } : null;
  };
  const own = myKeys(username)[name];
  if (own) return held(`own:${username}`) ?? { key: own };
  const server = serverKeyOf(actor, name);
  if (server) return held("server") ?? { key: server };
  return { key: "", missing: addKeyMessage(name) };
}

/** Settings → API keys. Accounts only: a share-link visitor has none. */
export const myKeysApp = new Hono<{ Variables: AuthVars }>();

myKeysApp.use("*", async (c, next) => (c.get("user").role === "visitor" ? c.json({ error: "Sign in with an account to keep your own keys" }, 403) : next()));

myKeysApp.get("/", (c) => {
  const u = c.get("user");
  const mine = myKeys(u.username);
  return c.json(
    MY_KEYS.map((k): MyKeyView => {
      const value = mine[k.env];
      // the server's key goes only to an admin (or the sole account of an own-computer install): only its last four go out
      const served = serverKeyOf(u, k.env);
      return {
        env: k.env, name: k.name, what: k.what, ...("where" in k ? { where: k.where } : {}),
        set: !!value, ...(value ? { last4: value.slice(-4) } : {}),
        ...(served ? { server: { from: serverKeyFrom(k.env) ?? "env", last4: served.slice(-4) } } : {}),
      } as MyKeyView;
    }),
  );
});

// the Local model box on the same page (local-model.ts): mounted before /:env, which would answer "No such key"
myKeysApp.route("/local-model", localModelApp);

myKeysApp.put("/:env", async (c) => {
  const name = c.req.param("env");
  if (!NAMES.has(name)) return c.json({ error: "No such key" }, 404);
  const b = (await c.req.json().catch(() => null)) as { value?: unknown } | null;
  const value = typeof b?.value === "string" ? b.value.trim() : b?.value === null ? null : undefined;
  if (value === undefined || value === "" || (value && (value.length > 500 || /\s/.test(value))))
    return c.json({ error: "Paste the key (one line, no spaces), or null to forget it" }, 400);
  saveMyKey(c.get("user").username, name as MyKeyEnv, value);
  if (value) await keySaved(name, c.get("user").username);
  return c.json({ ok: true });
});
