import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SETTINGS,
  DRIVER_MODELS,
  DRIVERS,
  EFFORTS,
  JOBS,
  isAcpDriver,
  driverFields,
  runsOn,
  type Device,
  type Driver,
  type DriverCatalog,
  type DriverDevice,
  type DriverEntry,
  type Effort,
  type JobId,
  type ProviderCheck,
  type ProviderInstance,
  type ProviderSettings,
  type Scope,
  type Selection,
} from "../../contracts/providers";
import { env } from "./env";
import { deviceExists, deviceOf } from "./devices";
import { USERNAME_RE, findUser } from "../users";
import { driverKinds, providerPresets } from "./plugin";
import { announce } from "./sync";

/**
 * The AI providers (contracts/providers.ts): which coding-agent CLI on a Mac answers each job, signed in as which
 * identity, with which model and effort. Two scopes of settings: the workspace's ($DATA_DIR/ai-providers.json, the
 * admins') and each account's own ($DATA_DIR/ai-providers/<username>.json). An instance runs on a device
 * (devices.ts); one with no device runs nowhere until a Mac is picked.
 */

const FILE = (scope: Scope) => (scope === "workspace" ? path.join(env.dataDir, "ai-providers.json") : path.join(env.dataDir, "ai-providers", `${scope}.json`));

const saved = new Map<Scope, ProviderSettings | null>();
const checks: Record<string, ProviderCheck> = {};

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
};

// one write at a time: two saves from two requests can't interleave the tmp file (as users.ts does)
let writes: Promise<void> = Promise.resolve();
function writeAtomic(file: string, data: unknown): Promise<void> {
  const run = writes.then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, file);
  });
  writes = run.catch(() => {});
  return run;
}

/** "workspace", or a username (its own). Anything else (a path, a reserved word) has no settings. */
const validScope = (scope: Scope) => scope === "workspace" || USERNAME_RE.test(scope);

/** What is saved for a scope, read once; null = nothing saved (the workspace then uses DEFAULT_SETTINGS). */
function savedFor(scope: Scope): ProviderSettings | null {
  if (!validScope(scope)) return null;
  if (!saved.has(scope)) saved.set(scope, readJson<ProviderSettings>(FILE(scope)));
  const s = saved.get(scope) ?? null;
  return s && withPresetEndpoints(s);
}

/** Each instance added from a plug-in preset gets that preset's endpoint now (a preset's endpoint is never saved). */
function withPresetEndpoints(s: ProviderSettings): ProviderSettings {
  return {
    ...s,
    instances: s.instances.map((i) => {
      const endpoint = i.preset ? providerPresets().find((p) => p.id === i.preset)?.baseUrl : undefined;
      return endpoint ? { ...i, baseUrl: endpoint } : i;
    }),
  };
}

/** The workspace's settings (what the admins set, and what the accounts they share them with use). */
export function providerSettings(): ProviderSettings {
  return savedFor("workspace") ?? structuredClone(DEFAULT_SETTINGS);
}

/** An account's own settings, or null when it has none. */
export const ownSettings = (username: string): ProviderSettings | null => savedFor(username);

/**
 * Saves a scope's settings. An instance keeps its last check across saves while it is the same CLI on the same Mac in
 * the same folder (parseSettings drops lastCheck from the page, so a Settings save would lose it otherwise).
 */
export async function saveSettings(s: ProviderSettings, scope: Scope = "workspace"): Promise<void> {
  if (!validScope(scope)) throw new Error("Not a provider scope");
  // an instance keeps its last check across saves while it is the same CLI on the same Mac in the same folder
  // (parseSettings drops lastCheck from the page, so a Settings save would lose it otherwise)
  const prev = savedFor(scope)?.instances ?? [];
  // a preset's endpoint lives in the plug-in: strip it from the instances before they reach the file
  const stored: ProviderSettings = {
    ...s,
    instances: s.instances.map((i) => {
      const was = i.lastCheck ? undefined : prev.find((p) => p.id === i.id && p.driver === i.driver && p.device === i.device && p.home === i.home);
      const kept = was?.lastCheck ? { ...i, lastCheck: was.lastCheck } : i;
      return kept.preset ? { ...kept, baseUrl: undefined } : kept;
    }),
  };
  await writeAtomic(FILE(scope), stored);
  saved.set(scope, stored);
}

/** Setup's "Connected": an enabled instance of this account's own whose last check passed. Survives a restart. */
export const connectedOwn = (username: string): boolean => (ownSettings(username)?.instances ?? []).some((i) => i.enabled && i.lastCheck?.ok);

export async function dropOwnSettings(username: string): Promise<void> {
  if (!validScope(username) || username === "workspace") throw new Error("Not a provider scope");
  await rm(FILE(username), { force: true });
  saved.set(username, null);
}

export const providerChecks = () => checks;

/** A recorded call outcome stands this long before a call with the same result rewrites the saved file. */
const NOTE_MS = 10 * 60_000;

/**
 * A real AI call's outcome is the instance's check: "Answered" or the plain failure. Written only when it changed, or the
 * saved one is older than NOTE_MS, so a busy AI does not rewrite the settings file on every call.
 */
export async function noteCallOutcome(scope: Scope, instance: string, ok: boolean, error?: string): Promise<void> {
  const key = `${scope}:${instance}`;
  const saved = (scope === "workspace" ? providerSettings() : ownSettings(scope))?.instances.find((i) => i.id === instance)?.lastCheck;
  const prev = checks[key] ?? saved;
  const sameResult = prev?.ok === ok && (ok || (checks[key]?.error ?? "") === (error ?? "").slice(0, 300));
  if (prev && sameResult && Date.now() - prev.at < NOTE_MS) return;
  await recordCheck(key, { ok, ms: 0, at: Date.now(), ...(error ? { error: error.slice(0, 300) } : {}) });
}
/** Keeps a check (Settings shows it) and, on the instance it was for, its `lastCheck` (kept across restarts). */
export async function recordCheck(key: string, c: ProviderCheck): Promise<void> {
  checks[key] = c;
  const at = key.indexOf(":");
  const scope: Scope = at < 0 ? "workspace" : key.slice(0, at);
  const id = at < 0 ? key : key.slice(at + 1);
  const s = scope === "workspace" ? providerSettings() : ownSettings(scope);
  if (!s?.instances.some((i) => i.id === id)) return;
  const was = s.instances.find((i) => i.id === id)?.lastCheck?.ok;
  const instances = s.instances.map((i) => (i.id === id ? { ...i, lastCheck: { ok: c.ok, at: c.at, ms: c.ms } } : i));
  await saveSettings({ ...s, instances }, scope);
  // an own AI that starts or stops answering is what setup and Home show; a same result again is not news
  // ponytail: the workspace's AI tells no one (per-account notices); fan out to its accounts if they need it live
  if (was !== c.ok && scope !== "workspace") announce(scope, "providers");
}

/** A driver id the server knows: a built-in, or a kind a plug-in adds. */
const knownDriver = (id: unknown): boolean => DRIVERS.some((d) => d.id === id) || driverKinds().some((k) => k.id === id);
const runs = (driver: Driver) => DRIVERS.find((d) => d.id === driver)?.runs ?? false;
const isEffort = (e: unknown): e is Effort => EFFORTS.includes(e as Effort);
const ID_RE = /^[A-Za-z0-9_-]{1,60}$/;
const MODEL_RE = /^[A-Za-z0-9._/:-]{1,80}$/;

/** The device an instance runs on ("" when none is picked: it runs nowhere). */
export const deviceIdOf = (i: ProviderInstance): string => i.device ?? "";

/**
 * Whether a device may run a scope's providers: the workspace's are an admin's Macs; an account's own are its own Macs.
 */
export function belongsTo(scope: Scope, deviceId: string): boolean {
  const d = deviceOf(deviceId);
  if (!d) return false;
  if (scope === "workspace") return d.owner === "workspace" || findUser(d.owner)?.role === "admin";
  return d.owner === scope;
}

/**
 * The models Codex's own login lists on this Mac: the `list`-visible slugs of its models_cache.json, by priority. Read
 * only by the server on the Mac (CT_LOCAL=1); a Codex update changes the list here, so a model the login refuses is
 * never offered or saved as the default. Empty when the file can't be read.
 */
export function codexLoginModels(home?: string): string[] {
  try {
    const dir = home || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const cache = JSON.parse(readFileSync(path.join(dir, "models_cache.json"), "utf8")) as { models?: { slug?: unknown; visibility?: unknown; priority?: unknown }[] };
    return (cache.models ?? [])
      .filter((m) => m.visibility === "list" && typeof m.slug === "string")
      .sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0))
      .map((m) => m.slug as string);
  } catch {
    return [];
  }
}

/** The models an instance offers: its driver's list (Codex: the login's own list on the Mac's server). */
export function modelsFor(inst: ProviderInstance): string[] {
  if (inst.driver === "codex" && process.env.CT_LOCAL === "1") {
    const own = codexLoginModels(inst.home);
    if (own.length) return own;
  }
  return DRIVER_MODELS[inst.driver] ?? [];
}

function parseSelection(raw: unknown, instances: ProviderInstance[], what: string): Selection {
  const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const inst = instances.find((i) => i.id === s.instance);
  if (!inst) throw new Error(`${what}: choose one of the AIs`);
  // "" = the tool's own default model (a tool with no list of models here)
  if (typeof s.model !== "string" || (s.model !== "" && !MODEL_RE.test(s.model))) throw new Error(`${what}: that model name is not valid`);
  if (!isEffort(s.effort)) throw new Error(`${what}: choose a thinking level`);
  return { instance: inst.id, model: s.model, effort: s.effort };
}

const HOME_RE = /^\/Users\/[^/]+\/[^\0]{1,200}$/;
const ABS_PATH_RE = /^\/[^\0]{1,300}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * The optional fields of a provider instance, checked, and only the ones the driver's settings page shows (driverFields):
 * a field with no reader is dropped, so an old file still loads. Absent or blank fields are left out.
 */
function parseExtras(i: Record<string, unknown>, driver: Driver, name: string): Partial<ProviderInstance> {
  const out: Partial<ProviderInstance> = {};
  const f = driverFields(driver);
  const binaryPath = f.program && typeof i.binaryPath === "string" ? i.binaryPath.trim() : "";
  if (binaryPath) {
    if (!ABS_PATH_RE.test(binaryPath)) throw new Error(`${name}: the program's path starts with /, like /opt/homebrew/bin/codex`);
    out.binaryPath = binaryPath;
  }
  // launch arguments only for a local ACP command; other kinds drop them (like baseUrl) so an old file still loads
  if (i.launchArgs !== undefined && f.args) {
    const args = i.launchArgs as unknown;
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string" || a.length > 500) || args.length > 32) throw new Error(`${name}: each argument is one line of text, up to 32 lines`);
    out.launchArgs = [...(args as string[])];
  }
  if (f.env && i.envNames !== undefined) {
    const names = i.envNames as unknown;
    if (!Array.isArray(names) || names.some((n) => typeof n !== "string" || !ENV_NAME_RE.test(n)) || names.length > 32) throw new Error(`${name}: variable names are letters, digits and _, up to 32`);
    out.envNames = [...(names as string[])];
  }
  if (driver === "acp") {
    const acp = i.acp && typeof i.acp === "object" ? (i.acp as Record<string, unknown>) : null;
    const args = acp?.args ?? [];
    if (!acp || typeof acp.command !== "string" || !acp.command.trim() || acp.command.length > 300 || !Array.isArray(args) || args.some((a) => typeof a !== "string"))
      throw new Error(`${name}: a local command needs the program to start and its arguments as text`);
    out.acp = { command: acp.command.trim(), args: [...(args as string[])] };
  } else if (i.acp !== undefined && i.acp !== null) throw new Error(`${name}: only a local command has a program to start`);
  return out;
}

/**
 * A settings body from the page, checked for `scope`. Throws a sentence the page shows. Every instance's device must
 * exist and belong to the scope (the workspace: an admin's Mac; an account: its own Macs).
 */
export function parseSettings(raw: unknown, scope: Scope = "workspace", opts: { trustedFolder?: boolean } = {}): ProviderSettings {
  if (!validScope(scope)) throw new Error("Not a provider scope");
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(b.instances) ? b.instances : [];
  const instances: ProviderInstance[] = [];
  for (const x of list) {
    const i = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
    if (typeof i.id !== "string" || !ID_RE.test(i.id) || instances.some((y) => y.id === i.id)) throw new Error("Each AI needs its own id");
    if (!knownDriver(i.driver)) throw new Error(`"${String(i.driver)}" is not an AI tool this app knows`);
    const name = typeof i.name === "string" && i.name.trim() ? i.name.trim().slice(0, 60) : i.id;
    // a plug-in preset (an unknown one is dropped: the provider stays an ordinary one, with no endpoint)
    const preset = typeof i.preset === "string" ? providerPresets().find((p) => p.id === i.preset) : undefined;
    if (preset && preset.driver !== i.driver) throw new Error(`${name} comes from a preset for ${preset.driver}`);
    // a computer that was removed (or never picked) leaves the AI unassigned: it stays listed, runs nowhere, and the
    // page asks for another computer. It does not stop the rest of the settings from saving.
    const picked = typeof i.device === "string" && ID_RE.test(i.device.trim()) ? i.device.trim() : "";
    const device = picked && deviceExists(picked) ? picked : "";
    if (device && !belongsTo(scope, device)) throw new Error(scope === "workspace" ? `${name} runs on a computer that is not an admin's` : `${name} runs on a computer that is not yours`);
    const home = typeof i.home === "string" ? i.home.trim() : "";
    // a folder the server found on its own Mac (setup's Connect) is trusted; one from the page must sit in the user's home
    if (home && !opts.trustedFolder && !HOME_RE.test(home)) throw new Error("The account folder must be a full path inside the Mac user's folder, like /Users/you/.claude-work");
    const model = typeof i.model === "string" && (i.model === "" || MODEL_RE.test(i.model)) ? i.model : undefined;
    const effort = isEffort(i.effort) ? i.effort : undefined;
    instances.push({
      id: i.id,
      driver: i.driver as Driver,
      name,
      enabled: i.enabled !== false,
      ...(home ? { home } : {}),
      device,
      ...(preset ? { preset: preset.id } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...parseExtras(i, i.driver as Driver, name),
    });
  }
  if (!instances.some((i) => i.enabled && runs(i.driver))) throw new Error("Turn on at least one AI that a computer can run");
  const def = parseSelection(b.default, instances, "Default");
  const jobsRaw = b.jobs && typeof b.jobs === "object" ? (b.jobs as Record<string, unknown>) : {};
  const jobs: ProviderSettings["jobs"] = {};
  for (const j of JOBS) if (jobsRaw[j.id]) jobs[j.id] = parseSelection(jobsRaw[j.id], instances, j.label);
  return {
    instances,
    default: def,
    jobs,
  };
}

/* ---- routing ---- */

/** The instance a job runs on, in one scope: what the caller picked, then the job's, then the default; else the first one that can run. */
export interface Route {
  scope: Scope;
  selection: Selection;
  instance: ProviderInstance;
  device: string;
}

/**
 * An instance can run for a scope: on, a CLI that runs, and a Mac that exists and belongs to that scope. With `owner`,
 * only a Mac that account paired or the workspace's own Mac (an admin's workspace providers, never another admin's).
 */
const usable = (scope: Scope, i: ProviderInstance, owner?: string): boolean =>
  i.enabled && runs(i.driver) && !!deviceIdOf(i) && belongsTo(scope, deviceIdOf(i)) && (owner === undefined || [owner, "workspace"].includes(deviceOf(deviceIdOf(i))?.owner ?? ""));

function pick(scope: Scope, s: ProviderSettings, job: JobId, own?: Selection, owner?: string): Route | null {
  const runnable = s.instances.filter((i) => usable(scope, i, owner));
  if (!runnable.length) return null;
  for (const sel of [own, s.jobs[job], s.default]) {
    const instance = sel && runnable.find((i) => i.id === sel.instance);
    if (sel && instance) return { scope, selection: sel, instance, device: deviceIdOf(instance) };
  }
  // nothing picked for it: the AI's own model and thinking level (the Default's when it is the Default)
  const instance = runnable[0]!;
  const device = deviceIdOf(instance);
  const isDefault = s.default.instance === instance.id;
  const model = isDefault ? s.default.model : (instance.model ?? modelsFor(instance)[0] ?? "");
  const effort = isDefault ? s.default.effort : (instance.effort ?? s.default.effort);
  return { scope, selection: { instance: instance.id, model, effort }, instance, device };
}

/**
 * Who answers an account's job (aiFor): its own providers when it has a runnable one on its own Macs; else, for an
 * admin only, the workspace's providers that run on the admin's own Macs. Nobody named = null: background work always
 * names whose work it is. Never another person's logins: a member gets null here and runs on its own key or not at all
 * (aiFor), since a subscription login serves only the person who signed in to it (Anthropic's terms).
 * Null = no provider for this account.
 */
export function routeFor(name: string | undefined, admin: boolean, job: JobId, own?: Selection): Route | null {
  if (!name) return null;
  const mine = ownSettings(name);
  const r = mine && pick(name, mine, job, own);
  if (r) return r;
  if (!admin) return null;
  return pick("workspace", providerSettings(), job, own, name);
}

/**
 * The other instances a job may move to when its own hits a usage limit (only an exhausted usage window falls back).
 * They stay on the same Mac owner's logins as the instance that hit the limit, so a workspace call never moves to
 * another admin's subscription.
 */
export function limitFallbacks(scope: Scope, after: ProviderInstance, model: string): Array<{ instance: ProviderInstance; model: string; device: string }> {
  const s = scope === "workspace" ? providerSettings() : ownSettings(scope);
  if (!s) return [];
  const owner = deviceOf(deviceIdOf(after))?.owner;
  if (!owner) return [];
  const picked = (id: string) => [s.default, ...Object.values(s.jobs)].find((x) => x?.instance === id)?.model;
  return s.instances
    .filter((i) => i.id !== after.id && usable(scope, i, owner))
    .map((i) => {
      const device = deviceIdOf(i);
      return { instance: i, device, model: i.driver === after.driver ? model : (picked(i.id) ?? modelsFor(i)[0] ?? "") };
    })
    .filter((x) => x.model);
}

/** The instance of a scope's settings a check runs on (admins: any scope; others: their own). */
export const instanceIn = (scope: Scope, id: string): ProviderInstance | undefined => (scope === "workspace" ? providerSettings() : ownSettings(scope))?.instances.find((i) => i.id === id);

/** Why a driver the Mac app can't run yet is shown disabled; the rest share the general line. */
const NOT_RUN_REASON: Partial<Record<Driver, string>> = {
  musecode: "Not in the Mac app yet.",
};

/**
 * The instance fields a job carries to its Mac, each only when set: the plug-in endpoint, the environment names, the
 * launch arguments, and the ACP command (or the program a manual setup gave, for an ACP kind).
 */
export const runFields = (i: ProviderInstance) => ({
  ...(i.baseUrl ? { baseUrl: i.baseUrl } : {}),
  ...(i.envNames?.length ? { envNames: i.envNames } : {}),
  ...(i.launchArgs?.length ? { launchArgs: i.launchArgs } : {}),
  ...(i.acp ? { acp: i.acp } : {}),
  ...(i.binaryPath && isAcpDriver(i.driver) ? { binaryPath: i.binaryPath } : {}),
});

/**
 * The driver catalog (GET /api/providers/drivers): every driver in DRIVERS order, whether it is featured and runs, why
 * not when it doesn't, and what each given Mac's report found of it. A Mac with no report yet is left out.
 */
export function driverCatalog(devices: Array<Device & { online: boolean }>): DriverCatalog {
  const reported = devices.filter((d) => d.report);
  const perDevice = (driver: Driver): DriverDevice[] =>
    reported.map((dev) => {
      const row = dev.report?.drivers.find((r) => r.driver === driver);
      return {
        device: dev.id,
        name: dev.name,
        online: dev.online,
        installed: !!row?.installed,
        ...(row?.signedIn !== undefined ? { signedIn: row.signedIn } : {}),
        ...(row?.version ? { version: row.version } : {}),
      };
    });
  const builtin = DRIVERS.map((d): DriverEntry => {
    const runs = runsOn(d.id);
    return {
      id: d.id,
      label: d.label,
      featured: d.featured,
      runs,
      ...(runs ? {} : { reason: NOT_RUN_REASON[d.id] ?? "The Creator Toolset Mac app can't run this CLI yet." }),
      devices: perDevice(d.id),
    };
  });
  // a plug-in's driver kind: listed, but no Mac runs it yet
  const kinds = driverKinds().map((k): DriverEntry => ({
    id: k.id,
    label: k.label,
    featured: k.featured,
    runs: false,
    reason: "The Creator Toolset Mac app can't run this CLI yet.",
    devices: perDevice(k.id),
  }));
  // a preset's view leaves out its endpoint
  const presets = providerPresets().map((p) => ({ id: p.id, name: p.name, driver: p.driver, badge: p.badge, ...(p.home ? { home: p.home } : {}) }));
  return { drivers: [...builtin, ...kinds], presets };
}
