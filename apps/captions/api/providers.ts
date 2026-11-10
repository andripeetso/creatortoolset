import { Hono } from "hono";
import type { ProviderCheck, ProviderInstance, ProviderSettings, ProvidersView, Scope } from "../contracts/providers";
import type { AuthVars } from "./auth";
import { streamMacClaude, macUsageSince } from "./lib/mac-claude";
import { forViewer, isOnline, listDevices } from "./lib/devices";
import { deviceIdOf, driverCatalog, dropOwnSettings, instanceIn, modelsFor, ownSettings, parseSettings, providerChecks, providerSettings, recordCheck, routeFor, runFields, saveSettings } from "./lib/providers";
import { limitsFor, type LimitRef } from "./lib/limits";
import { hostedMode } from "./lib/env";
import { budgetLeft, spentThisMonth } from "./lib/workspaces";
import { findUser, type SessionUser } from "./users";

/**
 * Admin → Your AI and the Settings page (boot.ts mounts it at /api/providers). Contract: contracts/providers.ts.
 *   GET  /api/providers                       → ProvidersView (any account; guests and the demo get 403)
 *   PUT  /api/providers/workspace             body ProviderSettings (admins) → ProviderSettings
 *   PUT  /api/providers/own                   body ProviderSettings | null (null = drop mine) → ProvidersView
 *   POST /api/providers/:scope/:id/check      admins any scope; others their own → ProviderCheck
 */
export const providersApp = new Hono<{ Variables: AuthVars }>();

const DAY = 86_400_000;
/** The usage page's window. */
const USAGE_DAYS = 90;
const signedIn = (u: SessionUser) => u.role !== "visitor";

providersApp.use("*", async (c, next) => {
  if (!signedIn(c.get("user"))) return c.json({ error: "Not for guests" }, 403);
  await next();
});

/** `${scope}:${instance}`; a key without a scope is the workspace's (entries from before scopes). */
const splitKey = (key: string): { scope: Scope; instance?: string } => {
  const at = key.indexOf(":");
  return at < 0 ? { scope: "workspace", instance: key } : { scope: key.slice(0, at), instance: key.slice(at + 1) };
};

/** The Macs an account sees: its own; an admin also the workspace's and the other admins' (what its providers may run on). Disks only for the owner (forViewer). */
const visibleDevices = (u: SessionUser) => listDevices((d) => d.owner === u.username || (u.role === "admin" && (d.owner === "workspace" || findAdmin(d.owner)))).map((d) => forViewer(u.username, d));

/** Settings for the page: a plug-in instance's endpoint (baseUrl) stays on the server and the Mac, never in the page. */
const forPage = (s: ProviderSettings): ProviderSettings => ({ ...s, instances: s.instances.map((i) => ({ ...i, baseUrl: undefined })) });

async function viewFor(u: SessionUser): Promise<ProvidersView> {
  const admin = u.role === "admin";
  const ws = providerSettings();
  const own = ownSettings(u.username);
  const workspace = admin ? { settings: forPage(ws), editable: true } : null;
  const route = routeFor(u.username, admin, "workshop");
  const using: ProvidersView["using"] = !route ? "none" : route.scope === "workspace" ? "workspace" : "own";

  const seesWorkspace = !!workspace;
  const visible = (scope: Scope) => scope === u.username || (seesWorkspace && scope === "workspace");

  const models: Record<string, string[]> = {};
  for (const i of own?.instances ?? []) models[`${u.username}:${i.id}`] = modelsFor(i);
  if (seesWorkspace) for (const i of ws.instances) models[`workspace:${i.id}`] = modelsFor(i);

  const checks: Record<string, ProviderCheck> = {};
  for (const [k, v] of Object.entries(providerChecks())) if (visible(splitKey(k).scope)) checks[k] = v;
  // the last result saved on each AI counts when this process has none (a restart or deploy keeps it)
  const sets: Array<[Scope, ProviderSettings | null]> = [
    [u.username, own],
    ["workspace", seesWorkspace ? ws : null],
  ];
  for (const [scope, set] of sets)
    for (const i of set?.instances ?? []) {
      const k = `${scope}:${i.id}`;
      if (!checks[k] && i.lastCheck) checks[k] = { ok: i.lastCheck.ok, at: i.lastCheck.at, ms: i.lastCheck.ms, ...(i.lastCheck.note ? { note: i.lastCheck.note } : {}) };
    }

  // admins also see the workspace's usage; everyone sees their own scope's
  const usage: ProvidersView["usage"] = [];
  for (const [hour, labels] of Object.entries(await macUsageSince(Date.now() - USAGE_DAYS * DAY))) {
    for (const [label, t] of Object.entries(labels)) {
      const by = Object.entries(t.by ?? {});
      for (const [key, x] of by) {
        const { scope, instance } = splitKey(key);
        if (scope === u.username || (admin && scope === "workspace")) usage.push({ hour, label, scope, instance, ...x });
      }
      // what the tally kept with no provider (the API path, a stopped run) belongs to the workspace
      const rest = { calls: t.calls - by.reduce((n, [, x]) => n + x.calls, 0), tokens: t.tokens - by.reduce((n, [, x]) => n + x.tokens, 0), costUsd: t.costUsd - by.reduce((n, [, x]) => n + x.costUsd, 0) };
      if (admin && rest.calls > 0) usage.push({ hour, label, scope: "workspace", ...rest });
    }
  }

  const devices = visibleDevices(u).map((d) => ({ ...d, online: isOnline(d.id) }));

  // plan limits: the identities behind this account's own providers; the workspace's for admins only
  const refs: LimitRef[] = [
    ...(own?.instances ?? []).map((i) => ({ scope: u.username, i })),
    ...(admin ? ws.instances.map((i) => ({ scope: "workspace", i })) : []),
  ]
    .map(({ scope, i }) => ({ key: `${scope}:${i.id}`, driver: i.driver, device: deviceIdOf(i), home: i.home }));
  const limits = limitsFor(refs, isOnline);

  // a member on the team's API budget (ai-complete.ts onBudget): only their own numbers, and whether the team's key is set
  const left = admin ? null : budgetLeft(u.username);
  const teamAi = left === null ? null : { budgetUsd: left + spentThisMonth(u.username), spentUsd: spentThisMonth(u.username), left, ready: hostedMode() && !!process.env.ANTHROPIC_API_KEY };

  return { workspace, own: own && forPage(own), using, devices, checks, models, usage, limits, teamAi };
}

const findAdmin = (owner: string) => findUser(owner)?.role === "admin";

providersApp.get("/", async (c) => c.json(await viewFor(c.get("user"))));

/** The Add provider wizard's catalog: each driver's featured and runs (with the reason when it can't run), and per Mac what it found. */
providersApp.get("/drivers", (c) => c.json(driverCatalog(visibleDevices(c.get("user")).map((d) => ({ ...d, online: isOnline(d.id) })))));

providersApp.put("/workspace", async (c) => {
  const u = c.get("user");
  if (u.role !== "admin") return c.json({ error: "Admins only" }, 403);
  try {
    const s = parseSettings(await c.req.json().catch(() => null), "workspace");
    await saveSettings(s);
    return c.json(s);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

/** `null` drops the account's own providers (its jobs go back to the workspace's); settings are kept only when checked. */
providersApp.put("/own", async (c) => {
  const u = c.get("user");
  if (u.username === "workspace") return c.json({ error: "This account can't keep providers" }, 400);
  const raw = await c.req.json().catch(() => undefined);
  if (raw === undefined) return c.json({ error: "Send the providers, or null to drop them" }, 400);
  try {
    if (raw === null) await dropOwnSettings(u.username);
    else await saveSettings(parseSettings(raw, u.username), u.username);
    return c.json(await viewFor(u));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

/**
 * One line through the instance's device, like the status check on the Mac: does it answer, with what model, how fast.
 * Kept on the instance as its `lastCheck`. Settings → Providers and setup's Connect both run this.
 */
export async function checkInstance(scope: Scope, inst: ProviderInstance, s: ProviderSettings | null): Promise<ProviderCheck> {
  const device = inst.device ?? "";
  const model = (s?.default.instance === inst.id ? s?.default.model : undefined) ?? modelsFor(inst)[0] ?? "";
  const started = Date.now();
  let check: ProviderCheck;
  try {
    const text = await streamMacClaude("Answer with one word.", "Reply with just: ready", undefined, () => {}, undefined, {
      label: "Provider check",
      provider: { instance: inst.id, driver: inst.driver, home: inst.home, model, effort: "low", device, scope, ...runFields(inst) },
    });
    check = { ok: true, ms: Date.now() - started, model, text: text.trim().slice(0, 80), at: Date.now() };
  } catch (e) {
    check = { ok: false, ms: Date.now() - started, model, error: (e instanceof Error ? e.message : String(e)).slice(0, 300), at: Date.now() };
  }
  await recordCheck(`${scope}:${inst.id}`, check);
  return check;
}

providersApp.post("/:scope/:id/check", async (c) => {
  const u = c.get("user");
  const scope = c.req.param("scope");
  if (scope !== u.username && u.role !== "admin") return c.json({ error: "Admins only, or your own providers" }, 403);
  const inst = instanceIn(scope, c.req.param("id"));
  if (!inst) return c.json({ error: "Not found" }, 404);
  const s = scope === "workspace" ? providerSettings() : ownSettings(scope);
  return c.json(await checkInstance(scope, inst, s));
});
