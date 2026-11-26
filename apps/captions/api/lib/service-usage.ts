import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { MY_KEYS, type MyKeyEnv } from "../../contracts/service-keys";
import type { ActivityRow } from "../../contracts/activity";
import { BUDGET_NEAR, BUDGET_SERVICES, type KeyBudget, type ServiceLimit, type ServiceUsageLine, type ServiceUsageView } from "../../contracts/service-usage";
import type { AuthVars } from "../auth";
import { isAdminActor, myKeys } from "../my-keys";
import { listUsers, LOCAL_USER } from "../users";
import { env } from "./env";
import { readApify } from "./instagram/apify";
import { usageWorkspace } from "./mac-claude";

/**
 * What each paid service call used (Settings → API keys, the Usage page): an hourly tally by service, label (the tool
 * or process, in Home names), whose key paid, the account that asked and the workspace, kept 90 days. The AI tally
 * (mac-claude.ts recordUsage) is the same idea for AI providers; this one is for keys.
 */

export type ServiceId = MyKeyEnv | "APIFY_TOKEN";
type Whose = ServiceUsageLine["whose"];
type Cell = { calls: number; units: number; unit: string; costUsd: number };
/** hour → JSON [service, label, whose, user, workspace] → totals */
type Tally = Record<string, Record<string, Cell>>;

const FILE = () => path.join(env.dataDir, "service-usage.json");
let tally: Promise<Tally> | null = null;
let saving: Promise<void> = Promise.resolve();
/** the tally once read: a key's spend this month is asked on every call (keyFor), so it is read without waiting */
let loaded: Tally | null = null;
const load = () =>
  (tally ??= readFile(FILE(), "utf-8")
    .then((t) => JSON.parse(t) as Tally)
    .catch((): Tally => ({}))
    .then((t) => (loaded = t)));

/**
 * USD per unit, for a service whose answer does not say what it cost.
 * shortcut: list prices of 2026-11 (pay-as-you-go, the cheapest model each call uses); they drift and plans differ, so
 * update them when a provider changes its prices, or read the cost from the answer once the service gives it.
 */
export const PRICE: Partial<Record<`${ServiceId}:${string}`, number>> = {
  "DEEPGRAM_API_KEY:audio minutes": 0.0043, // nova-3, prerecorded
  "OPENAI_API_KEY:audio minutes": 0.006, // whisper-1
  "OPENAI_API_KEY:tokens": 0.02 / 1e6, // text-embedding-3-small
  "ELEVENLABS_API_KEY:characters": 0.3 / 1000, // over a plan's own characters
  "PERPLEXITY_API_KEY:tokens": 1 / 1e6, // sonar
  "APIFY_TOKEN:results": 2.3 / 1000, // the post and profile readers, per result
};

/** What `units` of `unit` cost on `service`: the service's own figure when it gave one, else the price list, else 0. */
export const costOf = (service: ServiceId, units: number, unit: string, given?: number): number =>
  given ?? units * (PRICE[`${service}:${unit}`] ?? 0);

const accounts = () => [...listUsers().map((u) => u.username), ...(env.appSecret ? [] : [LOCAL_USER.username])];

export interface ServiceCall {
  service: ServiceId;
  /** the key the call ran on: tells whose it was when `whose` is not given */
  key: string;
  /** the tool or process, in Home names ("Caption Studio: captions") */
  label: string;
  units: number;
  unit: string;
  /** what the service said it cost; else the price list (costOf) */
  costUsd?: number;
  /** the account that asked; else the account whose own key `key` is */
  actor?: string | null;
  /** given where the key's store is not Settings → API keys (Apify), or a team budget's call */
  whose?: Whose;
  /** null: in no workspace; undefined: the one the work runs in */
  workspace?: string | null;
}

/** One paid call (or a batch of `calls`), tallied by hour. Never throws: a tally is never worth a failed call. */
export async function recordService(c: ServiceCall, calls = 1): Promise<void> {
  if (!c.key && !c.whose) return;
  const name = c.service as MyKeyEnv;
  const user = c.actor || (c.whose ? undefined : accounts().find((u) => myKeys(u)[name] === c.key));
  const whose: Whose = c.whose ?? (user && myKeys(user)[name] === c.key ? "own" : "server");
  const workspace = c.workspace === undefined ? usageWorkspace() : c.workspace;
  const all = await load();
  const hour = new Date().toISOString().slice(0, 13);
  const id = JSON.stringify([c.service, c.label, whose, user ?? "", workspace ?? ""]);
  const cell = ((all[hour] ??= {})[id] ??= { calls: 0, units: 0, unit: c.unit, costUsd: 0 });
  cell.calls += calls;
  cell.units += c.units;
  cell.costUsd += costOf(c.service, c.units, c.unit, c.costUsd);
  spentCache.clear();
  for (const h of Object.keys(all).sort().slice(0, -24 * 90)) delete all[h]; // 90 days
  const json = JSON.stringify(all);
  saving = saving
    .then(async () => {
      const tmp = `${FILE()}.tmp-${process.pid}`;
      await writeFile(tmp, json);
      await rename(tmp, FILE());
    })
    .catch((e: unknown) => console.warn(`[service-usage] not saved: ${e instanceof Error ? e.message : e}`));
}

/** The lines since `since` (ms) that `username` may see: their own calls, and for an admin every call on the server's keys. */
export async function serviceLines(since: number, username: string, admin: boolean): Promise<ServiceUsageLine[]> {
  const from = new Date(since).toISOString().slice(0, 13);
  const out: ServiceUsageLine[] = [];
  for (const [hour, cells] of Object.entries(await load())) {
    if (hour < from) continue;
    for (const [id, x] of Object.entries(cells)) {
      const [service, label, whose, user, workspace] = JSON.parse(id) as [string, string, Whose, string, string];
      if (user !== username && !(admin && whose !== "own")) continue;
      out.push({ hour, service, label, whose, calls: x.calls, units: x.units, unit: x.unit, costUsd: x.costUsd, ...(workspace ? { workspace } : {}) });
    }
  }
  return out;
}

/* ---- a monthly budget per key ---- */

/** Whose key a budget is on: the server's, or one account's own ("own:<username>"). */
export type Holder = "server" | `own:${string}`;
type Budgets = Record<string, Partial<Record<ServiceId, number>>>;
const BUDGETS = () => path.join(env.dataDir, "key-budgets.json");
let budgets: Budgets | null = null;

const allBudgets = (): Budgets => {
  if (!budgets)
    try {
      budgets = JSON.parse(readFileSync(BUDGETS(), "utf-8")) as Budgets;
    } catch {
      budgets = {};
    }
  return budgets;
};

export const budgetOf = (service: ServiceId, holder: Holder): number | null => allBudgets()[holder]?.[service] ?? null;

export function setBudget(service: ServiceId, holder: Holder, usd: number | null): void {
  const mine = Object.fromEntries(Object.entries(allBudgets()[holder] ?? {}).filter(([s]) => s !== service));
  const next: Budgets = { ...allBudgets(), [holder]: usd === null ? mine : { ...mine, [service]: Math.round(usd * 100) / 100 } };
  mkdirSync(env.dataDir, { recursive: true });
  const tmp = `${BUDGETS()}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  renameSync(tmp, BUDGETS());
  budgets = next;
}

const spentCache = new Map<string, number>();

/** What `holder`'s key of `service` cost this calendar month (UTC): 0 until the tally is read (it is read on the first ask). */
export function spentThisMonth(service: ServiceId, holder: Holder, now = Date.now()): number {
  if (!loaded) {
    void load();
    return 0;
  }
  const month = new Date(now).toISOString().slice(0, 7);
  const id = `${month}\0${service}\0${holder}`;
  const hit = spentCache.get(id);
  if (hit !== undefined) return hit;
  const user = holder === "server" ? null : holder.slice(4);
  let usd = 0;
  for (const [hour, cells] of Object.entries(loaded)) {
    if (!hour.startsWith(month)) continue;
    for (const [key, x] of Object.entries(cells)) {
      const [s, , whose, u] = JSON.parse(key) as [string, string, Whose, string];
      if (s === service && (user === null ? whose === "server" : whose === "own" && u === user)) usd += x.costUsd;
    }
  }
  spentCache.set(id, usd);
  return usd;
}

const keyName = (service: ServiceId) => (service === "APIFY_TOKEN" ? "Apify" : (MY_KEYS.find((k) => k.env === service)?.name ?? service));

/** Why a call on this key may not run: it spent its monthly budget. null while it may. */
export function budgetRefusal(service: ServiceId, holder: Holder, now = Date.now()): string | null {
  const cap = budgetOf(service, holder);
  if (cap === null || spentThisMonth(service, holder, now) < cap) return null;
  return `${keyName(service)} key reached its monthly budget of $${cap}: raise it in Settings → API keys`;
}

/** The budgets `username` sees: one per key they have that can take one, and for an admin the server's keys too. */
async function budgetsFor(username: string, admin: boolean, now = Date.now()): Promise<KeyBudget[]> {
  await load();
  const mine = myKeys(username);
  const apify = await readApify(username).catch(() => null);
  const out: KeyBudget[] = [];
  for (const service of BUDGET_SERVICES) {
    const own = service === "APIFY_TOKEN" ? apify?.source === "file" && !!apify.token : !!mine[service];
    const server = service === "APIFY_TOKEN" ? apify?.source === "env" && !!apify.token : !!process.env[service];
    const keys: Array<[boolean, KeyBudget["whose"], Holder]> = [[own, "own", `own:${username}`], [admin && server, "server", "server"]];
    for (const [has, whose, holder] of keys) if (has) out.push({ service, whose, budget: budgetOf(service, holder), spent: spentThisMonth(service, holder, now) });
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const money = (n: number) => `$${n.toFixed(2).replace(/\.00$/, "")}`;

/** Activity rows for the keys `username` sees that are near their budget (BUDGET_NEAR) or at it, opening Settings → API keys. */
export async function budgetRows(username: string, admin: boolean, now = Date.now()): Promise<ActivityRow[]> {
  const reset = `1 ${MONTHS[(new Date(now).getUTCMonth() + 1) % 12]}`;
  return (await budgetsFor(username, admin, now))
    .filter((b) => b.budget !== null && b.budget > 0 && b.spent >= b.budget * BUDGET_NEAR)
    .map((b) => {
      const at = b.spent >= b.budget!;
      const name = `${keyName(b.service as ServiceId)}${b.whose === "server" ? " (server key)" : ""}`;
      return {
        id: `budget:${b.whose}:${b.service}`,
        title: at ? `${name}: monthly budget reached` : `${name}: ${Math.floor((b.spent / b.budget!) * 100)}% of monthly budget`,
        detail: `${money(b.spent)} of ${money(b.budget!)} this month${at ? ` · stopped until ${reset}` : ""}`,
        state: "ready",
        href: "/settings/keys",
      } satisfies ActivityRow;
    });
}

/* ---- each service's own limits or balance, where its API offers one ---- */

const LIMIT_TTL = 10 * 60_000;
const limitCache = new Map<string, { at: number; value: Promise<Omit<ServiceLimit, "whose">[]> }>();
const getJson = async (url: string, headers: Record<string, string>): Promise<Record<string, any>> => {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()) as Record<string, any>;
};

const READERS: Partial<Record<ServiceId, (key: string, at: number) => Promise<Omit<ServiceLimit, "whose">[]>>> = {
  APIFY_TOKEN: async (key, at) => {
    const d = (await getJson("https://api.apify.com/v2/users/me/limits", { Authorization: `Bearer ${key}` })).data ?? {};
    const end = Date.parse(d.monthlyUsageCycle?.endAt ?? "");
    return [{ service: "APIFY_TOKEN", label: "Monthly usage", used: d.current?.monthlyUsageUsd, limit: d.limits?.maxMonthlyUsageUsd, unit: "USD", ...(end ? { resetsAt: end } : {}), at }];
  },
  ELEVENLABS_API_KEY: async (key, at) => {
    const d = await getJson("https://api.elevenlabs.io/v1/user/subscription", { "xi-api-key": key });
    const reset = Number(d.next_character_count_reset_unix) * 1000;
    return [{ service: "ELEVENLABS_API_KEY", label: "Characters this month", used: d.character_count, limit: d.character_limit, unit: "characters", ...(reset ? { resetsAt: reset } : {}), at }];
  },
  DEEPGRAM_API_KEY: async (key, at) => {
    const h = { Authorization: `Token ${key}` };
    const project = (await getJson("https://api.deepgram.com/v1/projects", h)).projects?.[0]?.project_id;
    if (!project) return [];
    const b = (await getJson(`https://api.deepgram.com/v1/projects/${encodeURIComponent(project)}/balances`, h)).balances?.[0];
    return b ? [{ service: "DEEPGRAM_API_KEY", label: "Credit balance", limit: b.amount, unit: String(b.units ?? "usd").toUpperCase(), at }] : [];
  },
};

/** One key's limits, read at most every 10 minutes; a service that fails gives none. */
function limitsOf(service: ServiceId, key: string, now: number): Promise<Omit<ServiceLimit, "whose">[]> {
  const read = READERS[service];
  if (!read || !key) return Promise.resolve([]);
  const id = `${service}:${key}`;
  const hit = limitCache.get(id);
  if (hit && now - hit.at < LIMIT_TTL) return hit.value;
  const value = read(key, now).catch(() => []);
  limitCache.set(id, { at: now, value });
  return value;
}

/** The limits of the keys `username` has: their own, and for an admin the server's. */
async function serviceLimits(username: string, admin: boolean, now = Date.now()): Promise<ServiceLimit[]> {
  const mine = myKeys(username);
  const apify = await readApify(username).catch(() => null);
  const asks: Array<[ServiceId, string, ServiceLimit["whose"]]> = [];
  for (const s of Object.keys(READERS) as ServiceId[]) {
    if (s === "APIFY_TOKEN") {
      if (apify?.token && (apify.source !== "env" || admin)) asks.push([s, apify.token, apify.source === "env" ? "server" : "own"]);
      continue;
    }
    const own = mine[s as MyKeyEnv];
    if (own) asks.push([s, own, "own"]);
    const server = process.env[s];
    if (admin && server && server !== own) asks.push([s, server, "server"]);
  }
  const read = await Promise.all(asks.map(([s, key, whose]) => limitsOf(s, key, now).then((ls) => ls.map((l) => ({ ...l, whose })))));
  return read.flat();
}

/** GET /api/usage/services?since=<ms> → ServiceUsageView (contracts/service-usage.ts). Accounts only. */
export const serviceUsageApp = new Hono<{ Variables: AuthVars }>();

serviceUsageApp.get("/services", async (c) => {
  const u = c.get("user");
  if (u.role === "visitor") return c.json({ error: "Sign in with an account to see usage" }, 403);
  const now = Date.now();
  const asked = Number(c.req.query("since"));
  const since = Math.max(now - 90 * 864e5, Number.isFinite(asked) && asked > 0 ? asked : now - 30 * 864e5);
  const admin = u.role === "admin" || isAdminActor(u.username);
  const [lines, limits, budgets] = await Promise.all([serviceLines(since, u.username, admin), serviceLimits(u.username, admin, now).catch(() => []), budgetsFor(u.username, admin, now)]);
  return c.json({ lines, limits, budgets } satisfies ServiceUsageView);
});

/** PUT /api/usage/budgets/:service { whose, budget }: a key's monthly budget in dollars, null for no limit. The server's keys: admins only. */
serviceUsageApp.put("/budgets/:service", async (c) => {
  const u = c.get("user");
  if (u.role === "visitor") return c.json({ error: "Sign in with an account to set a budget" }, 403);
  const service = c.req.param("service") as ServiceId;
  if (!(BUDGET_SERVICES as readonly string[]).includes(service)) return c.json({ error: "Key not found" }, 404);
  const b = (await c.req.json().catch(() => null)) as { whose?: unknown; budget?: unknown } | null;
  const budget = b?.budget === null ? null : typeof b?.budget === "number" && Number.isFinite(b.budget) && b.budget >= 0 && b.budget <= 1_000_000 ? b.budget : undefined;
  if (budget === undefined || (b?.whose !== "own" && b?.whose !== "server")) return c.json({ error: "Needs an amount in dollars, or null for no limit" }, 400);
  if (b.whose === "server" && !(u.role === "admin" || isAdminActor(u.username))) return c.json({ error: "Only an admin sets the server's key budgets" }, 403);
  setBudget(service, b.whose === "server" ? "server" : `own:${u.username}`, budget);
  return c.json({ ok: true });
});
