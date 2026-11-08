import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SETTINGS,
  DRIVER_MODELS,
  DRIVERS,
  EFFORTS,
  JOBS,
  type Driver,
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
  return saved.get(scope) ?? null;
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
  const prev = savedFor(scope)?.instances ?? [];
  const next: ProviderSettings = {
    ...s,
    instances: s.instances.map((i) => {
      if (i.lastCheck) return i;
      const was = prev.find((p) => p.id === i.id && p.driver === i.driver && p.device === i.device && p.home === i.home);
      return was?.lastCheck ? { ...i, lastCheck: was.lastCheck } : i;
    }),
  };
  await writeAtomic(FILE(scope), next);
  saved.set(scope, next);
}

/** Setup's "Connected": an enabled instance of this account's own whose last check passed. Survives a restart. */
export const connectedOwn = (username: string): boolean => (ownSettings(username)?.instances ?? []).some((i) => i.enabled && i.lastCheck?.ok);

export async function dropOwnSettings(username: string): Promise<void> {
  if (!validScope(username) || username === "workspace") throw new Error("Not a provider scope");
  await rm(FILE(username), { force: true });
  saved.set(username, null);
}

export const providerChecks = () => checks;
/** Keeps a check (Settings shows it) and, on the instance it was for, its `lastCheck` (kept across restarts). */
export async function recordCheck(key: string, c: ProviderCheck): Promise<void> {
  checks[key] = c;
  const at = key.indexOf(":");
  const scope: Scope = at < 0 ? "workspace" : key.slice(0, at);
  const id = at < 0 ? key : key.slice(at + 1);
  const s = scope === "workspace" ? providerSettings() : ownSettings(scope);
  if (!s?.instances.some((i) => i.id === id)) return;
  const instances = s.instances.map((i) => (i.id === id ? { ...i, lastCheck: { ok: c.ok, at: c.at, ms: c.ms } } : i));
  await saveSettings({ ...s, instances }, scope);
}

const DRIVER_IDS = new Set(DRIVERS.map((d) => d.id));
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

/** The models an instance offers: its driver's list. */
export function modelsFor(inst: ProviderInstance): string[] {
  return DRIVER_MODELS[inst.driver] ?? [];
}

function parseSelection(raw: unknown, instances: ProviderInstance[], what: string): Selection {
  const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const inst = instances.find((i) => i.id === s.instance);
  if (!inst) throw new Error(`${what}: pick one of the providers`);
  if (typeof s.model !== "string" || !MODEL_RE.test(s.model)) throw new Error(`${what}: pick a model`);
  if (!isEffort(s.effort)) throw new Error(`${what}: pick an effort`);
  return { instance: inst.id, model: s.model, effort: s.effort };
}

/**
 * A settings body from the page, checked for `scope`. Throws a sentence the page shows. Every instance's device must
 * exist and belong to the scope (the workspace: an admin's Mac; an account: its own Macs).
 */
export function parseSettings(raw: unknown, scope: Scope = "workspace"): ProviderSettings {
  if (!validScope(scope)) throw new Error("Not a provider scope");
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(b.instances) ? b.instances : [];
  const instances: ProviderInstance[] = [];
  for (const x of list) {
    const i = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
    if (typeof i.id !== "string" || !ID_RE.test(i.id) || instances.some((y) => y.id === i.id)) throw new Error("Each provider needs its own id");
    if (!DRIVER_IDS.has(i.driver as Driver)) throw new Error(`Unknown provider: ${String(i.driver)}`);
    const name = typeof i.name === "string" && i.name.trim() ? i.name.trim().slice(0, 60) : i.id;
    const device = typeof i.device === "string" && i.device.trim() ? i.device.trim() : "";
    if (!device || !ID_RE.test(device)) throw new Error(`${name}: pick one of your Macs`);
    if (!deviceExists(device)) throw new Error(`${name}: its Mac is gone: pick another`);
    if (!belongsTo(scope, device)) throw new Error(scope === "workspace" ? `${name}: the workspace's providers run on an admin's Mac` : `${name}: your providers run on your own Macs`);
    const home = typeof i.home === "string" ? i.home.trim() : "";
    if (home && !/^\/Users\/[^/]+\/[^\0]{1,200}$/.test(home)) throw new Error("A provider's folder must be in the Mac user's home folder");
    instances.push({
      id: i.id,
      driver: i.driver as Driver,
      name,
      enabled: i.enabled !== false,
      ...(home ? { home } : {}),
      device,
    });
  }
  if (!instances.some((i) => i.enabled && runs(i.driver))) throw new Error("Keep at least one provider on that the Mac can run");
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

/** An instance can run for a scope: on, a CLI that runs, and a Mac that exists and belongs to that scope. */
const usable = (scope: Scope, i: ProviderInstance): boolean => i.enabled && runs(i.driver) && !!deviceIdOf(i) && belongsTo(scope, deviceIdOf(i));

function pick(scope: Scope, s: ProviderSettings, job: JobId, own?: Selection): Route | null {
  const runnable = s.instances.filter((i) => usable(scope, i));
  if (!runnable.length) return null;
  for (const sel of [own, s.jobs[job], s.default]) {
    const instance = sel && runnable.find((i) => i.id === sel.instance);
    if (sel && instance) return { scope, selection: sel, instance, device: deviceIdOf(instance) };
  }
  const instance = runnable[0]!;
  const device = deviceIdOf(instance);
  const model = s.default.instance === instance.id ? s.default.model : (modelsFor(instance)[0] ?? s.default.model);
  return { scope, selection: { instance: instance.id, model, effort: s.default.effort }, instance, device };
}

/**
 * Who answers an account's job (aiFor): its own providers when it has a runnable one on its own Macs; else the
 * workspace's when it is an admin (aiFor never asks for nobody). Never another person's: the workspace's
 * are the owner's own Claude / ChatGPT logins, which serve only them (Anthropic's terms). Anyone else without their own runs on their own API key (aiFor) or not at all.
 * Null = no provider for this account.
 */
export function routeFor(name: string | undefined, admin: boolean, job: JobId, own?: Selection): Route | null {
  if (name) {
    const mine = ownSettings(name);
    const r = mine && pick(name, mine, job, own);
    if (r) return r;
  }
  if (name && !admin) return null;
  return pick("workspace", providerSettings(), job, own);
}

/** The other instances in the same scope a job may move to when its own hits a usage limit (only an exhausted usage window falls back). */
export function limitFallbacks(scope: Scope, after: ProviderInstance, model: string): Array<{ instance: ProviderInstance; model: string; device: string }> {
  const s = scope === "workspace" ? providerSettings() : ownSettings(scope);
  if (!s) return [];
  const picked = (id: string) => [s.default, ...Object.values(s.jobs)].find((x) => x?.instance === id)?.model;
  return s.instances
    .filter((i) => i.id !== after.id && usable(scope, i))
    .map((i) => {
      const device = deviceIdOf(i);
      return { instance: i, device, model: i.driver === after.driver ? model : (picked(i.id) ?? modelsFor(i)[0] ?? "") };
    })
    .filter((x) => x.model);
}

/** The instance of a scope's settings a check runs on (admins: any scope; others: their own). */
export const instanceIn = (scope: Scope, id: string): ProviderInstance | undefined => (scope === "workspace" ? providerSettings() : ownSettings(scope))?.instances.find((i) => i.id === id);
