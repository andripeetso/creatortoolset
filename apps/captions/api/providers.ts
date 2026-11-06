import { Hono } from "hono";
import type { ProviderCheck, ProvidersView, Scope } from "../contracts/providers";
import type { AuthVars } from "./auth";
import { streamMacClaude, macUsageSince } from "./lib/mac-claude";
import { isOnline, listDevices } from "./lib/devices";
import { dropOwnSettings, instanceIn, modelsFor, ownSettings, parseSettings, providerChecks, providerSettings, recordCheck, routeFor, saveSettings } from "./lib/providers";
import { findUser, type SessionUser } from "./users";

/**
 * Admin → AI providers and the Settings page (boot.ts mounts it at /api/providers). Contract: contracts/providers.ts.
 *   GET  /api/providers                       → ProvidersView (any account; guests and the demo get 403)
 *   PUT  /api/providers/workspace             body ProviderSettings (admins) → ProviderSettings
 *   PUT  /api/providers/own                   body ProviderSettings | null (null = drop mine) → ProvidersView
 *   POST /api/providers/:scope/:id/check      admins any scope; others their own → ProviderCheck
 */
export const providersApp = new Hono<{ Variables: AuthVars }>();

const DAY = 86_400_000;
/** The usage page's window. */
const USAGE_DAYS = 90;
const signedIn = (u: SessionUser) => u.role !== "guest" && !u.demo;

providersApp.use("*", async (c, next) => {
  if (!signedIn(c.get("user"))) return c.json({ error: "Not for guests" }, 403);
  await next();
});

/** `${scope}:${instance}`; a key without a scope is the workspace's (entries from before scopes). */
const splitKey = (key: string): { scope: Scope; instance?: string } => {
  const at = key.indexOf(":");
  return at < 0 ? { scope: "workspace", instance: key } : { scope: key.slice(0, at), instance: key.slice(at + 1) };
};

async function viewFor(u: SessionUser): Promise<ProvidersView> {
  const admin = u.role === "admin";
  const ws = providerSettings();
  const own = ownSettings(u.username);
  const workspace = admin ? { settings: ws, editable: true } : null;
  const route = routeFor(u.username, admin, "workshop");
  const using: ProvidersView["using"] = !route ? "none" : route.scope === "workspace" ? "workspace" : "own";

  const seesWorkspace = !!workspace;
  const visible = (scope: Scope) => scope === u.username || (seesWorkspace && scope === "workspace");

  const models: Record<string, string[]> = {};
  for (const i of own?.instances ?? []) models[`${u.username}:${i.id}`] = modelsFor(i);
  if (seesWorkspace) for (const i of ws.instances) models[`workspace:${i.id}`] = modelsFor(i);

  const checks: Record<string, ProviderCheck> = {};
  for (const [k, v] of Object.entries(providerChecks())) if (visible(splitKey(k).scope)) checks[k] = v;

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

  const keep = (d: { owner: string }) => d.owner === u.username || (admin && (d.owner === "workspace" || findAdmin(d.owner)));
  const devices = listDevices(keep).map((d) => ({ ...d, online: isOnline(d.id) }));

  return { workspace, own, using, devices, checks, models, usage };
}

const findAdmin = (owner: string) => findUser(owner)?.role === "admin";

providersApp.get("/", async (c) => c.json(await viewFor(c.get("user"))));

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

/** One line through the instance's device, like the status check on the Mac: does it answer, with what model, how fast. */
providersApp.post("/:scope/:id/check", async (c) => {
  const u = c.get("user");
  const scope = c.req.param("scope");
  if (scope !== u.username && u.role !== "admin") return c.json({ error: "Admins only, or your own providers" }, 403);
  const inst = instanceIn(scope, c.req.param("id"));
  if (!inst) return c.json({ error: "Not found" }, 404);
  const s = scope === "workspace" ? providerSettings() : ownSettings(scope);
  const device = inst.device ?? "";
  const model = (s?.default.instance === inst.id ? s?.default.model : undefined) ?? modelsFor(inst)[0] ?? "";
  const key = `${scope}:${inst.id}`;
  const started = Date.now();
  try {
    const text = await streamMacClaude("Answer with one word.", "Reply with just: ready", undefined, () => {}, undefined, {
      label: "Provider check",
      provider: { instance: inst.id, driver: inst.driver, home: inst.home, model, effort: "low", device, scope },
    });
    const check: ProviderCheck = { ok: true, ms: Date.now() - started, model, text: text.trim().slice(0, 80), at: Date.now() };
    recordCheck(key, check);
    return c.json(check);
  } catch (e) {
    const check: ProviderCheck = { ok: false, ms: Date.now() - started, model, error: (e instanceof Error ? e.message : String(e)).slice(0, 300), at: Date.now() };
    recordCheck(key, check);
    return c.json(check);
  }
});
