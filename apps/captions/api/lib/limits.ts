import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Driver, LimitWindow, LimitsIdentity } from "../../contracts/providers";
import { env } from "./env";

/**
 * The plan limits each Mac reported (the Mac app's Limits.swift, POST /api/devices/relay/limits every five minutes). The latest report
 * per device is kept in $DATA_DIR/limits.json, so a restart keeps the last reading. Tokens never reach here.
 */

/** One config folder as the Mac reported it. `home` stays on the server (matching an instance's folder), never sent out. */
export interface Reported {
  driver: Driver;
  home: string;
  isDefault: boolean;
  label: string;
  state: LimitsIdentity["state"];
  error?: string;
  windows: LimitWindow[];
}

/** A provider instance that runs on a device, for the view: its key, driver, device and folder. */
export interface LimitRef {
  key: string;
  driver: Driver;
  device: string;
  home?: string;
}

const DRIVERS: readonly Driver[] = ["claude", "codex"];
const STATES: readonly LimitsIdentity["state"][] = ["ok", "no_login", "signed_out", "error"];
const KINDS: readonly LimitWindow["kind"][] = ["session", "weekly", "monthly", "other"];
const MAX_IDENTITIES = 16;
const MAX_WINDOWS = 8;

type Stored = { at: number; identities: Reported[] };
let reported: Map<string, Stored> | null = null;
const file = () => path.join(env.dataDir, "limits.json");

/** The stored reports, read once from disk on first use. A missing or unreadable file is no reports. */
function store(): Map<string, Stored> {
  if (!reported) {
    try {
      const raw = JSON.parse(readFileSync(file(), "utf-8")) as Record<string, Stored>;
      reported = new Map(Object.entries(raw));
    } catch {
      reported = new Map();
    }
  }
  return reported;
}

/** Written whole to a temp file and renamed, so a crash mid-write keeps the last good file. */
function persist(): void {
  const json = JSON.stringify(Object.fromEntries(store()));
  mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.tmp-${process.pid}`;
  writeFileSync(tmp, json);
  renameSync(tmp, file());
}

const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const text = (x: unknown, max: number): string | undefined => (typeof x === "string" ? x.slice(0, max) : undefined);
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});

/** A limits body from an untrusted Mac: every identity and window it can read, else none. Malformed rows are dropped. */
export function parseLimits(body: unknown): Reported[] {
  const list = Array.isArray(obj(body).identities) ? (obj(body).identities as unknown[]) : [];
  return list.slice(0, MAX_IDENTITIES).flatMap((x): Reported[] => {
    const o = obj(x);
    const driver = DRIVERS.find((d) => d === o.driver);
    const state = STATES.find((s) => s === o.state);
    const home = text(o.home, 300);
    const label = text(o.label, 40)?.trim();
    if (!driver || !state || !home || !label) return [];
    const windows = (Array.isArray(o.windows) ? o.windows : []).slice(0, MAX_WINDOWS).flatMap((w): LimitWindow[] => {
      const r = obj(w);
      const used = num(r.usedPercent);
      const id = text(r.id, 30);
      const name = text(r.label, 40);
      const kind = KINDS.find((k) => k === r.kind) ?? "other";
      if (used === undefined || used < 0 || used > 100 || !id || !name) return [];
      const resetsAt = num(r.resetsAt);
      const windowMs = num(r.windowMs);
      return [{ id, label: name, kind, usedPercent: used, ...(resetsAt !== undefined ? { resetsAt } : {}), ...(windowMs !== undefined ? { windowMs } : {}) }];
    });
    const error = text(o.error, 200);
    return [{ driver, home, isDefault: o.isDefault === true, label, state, ...(error ? { error } : {}), windows }];
  });
}

/** A device's limits report arrived: it replaces what that device said before. */
export function saveLimits(device: string, body: unknown, now = Date.now()): void {
  store().set(device, { at: now, identities: parseLimits(body) });
  persist();
}

/**
 * The identities behind the given instances, one entry per identity (two instances on one folder share it). An
 * instance without a folder runs on the Mac's default one. Only what is passed in is looked at, so the caller's
 * visibility decides what shows.
 */
export function limitsFor(refs: LimitRef[], online: (device: string) => boolean): LimitsIdentity[] {
  const out = new Map<string, LimitsIdentity>();
  for (const r of refs) {
    const stored = store().get(r.device);
    const hit = stored?.identities.find((x) => x.driver === r.driver && (r.home ? x.home === r.home : x.isDefault));
    if (!stored || !hit) continue;
    const key = `${r.device}\n${hit.driver}\n${hit.home}`;
    const cur = out.get(key);
    if (cur) {
      cur.instances.push(r.key);
      continue;
    }
    out.set(key, {
      driver: hit.driver,
      label: hit.label,
      state: hit.state,
      ...(hit.error ? { error: hit.error } : {}),
      windows: hit.windows,
      at: stored.at,
      device: r.device,
      online: online(r.device),
      instances: [r.key],
    });
  }
  return [...out.values()];
}
