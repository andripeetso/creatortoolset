import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_WEIGHT, type Balance, type Device, type Machine } from "../../contracts/providers";
import { env } from "./env";

/** Load balancing (Settings → Devices): on/off and each of the account's computers' preference, in $DATA_DIR/balance/<user>.json. */
export const balanceFile = (user: string) => path.join(env.dataDir, "balance", `${user}.json`);

const parse = (b: Partial<Balance> | null): Balance => {
  const map = <T>(x: unknown, ok: (v: unknown) => v is T): Record<string, T> =>
    x && typeof x === "object" ? Object.fromEntries(Object.entries(x).filter(([, v]) => ok(v))) as Record<string, T> : {};
  return {
    on: b?.on !== false,
    weights: map(b?.weights, (v): v is number => typeof v === "number"),
    libraries: map(b?.libraries, (v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string")),
    originals: map(b?.originals, (v): v is boolean => typeof v === "boolean"),
  };
};

/** The balance file read at once (the server's loop asks per job, and a claim per poll). */
export function readBalanceSync(user: string): Balance {
  try {
    return parse(JSON.parse(readFileSync(balanceFile(user), "utf8")) as Partial<Balance>);
  } catch {
    return parse(null);
  }
}
export async function readBalance(user: string): Promise<Balance> {
  try {
    return parse(JSON.parse(await readFile(balanceFile(user), "utf-8")) as Partial<Balance>);
  } catch {
    return parse(null);
  }
}
/** readBalance for a caller that cannot wait (a device job slot's claim, lib/plugin.ts DeviceJobSlot). */
export const balanceNow = readBalanceSync;

/** A computer that runs AI Editor steps, as its last report and heartbeat left it (a device in lib/devices.ts). */
export interface WorkerSeen {
  host: string;
  at: number;
  machine?: Machine;
  /** running a heavy job now (it runs one at a time) */
  busy?: boolean;
  /** kinds it never takes (a helper: what needs the Mac; one short of memory: its heavy kinds too) */
  never: string[];
}

/** A computer's share of the work: its weight × free cores × free memory share. 0 = not a candidate. */
export function score(w: WorkerSeen, weight: number): number {
  const m = w.machine;
  if (!m || weight <= 0 || !m.cpus || !m.memGb || m.freeGb === undefined) return 0;
  const load = m.load ?? 0;
  const free = m.freeGb / m.memGb;
  if (load >= 0.95 || free <= 0.05) return 0;
  return weight * m.cpus * (1 - load) * free;
}

/**
 * May `host` take a heavy job of `kind` now? With balancing on, only the best computer for it among those online,
 * free and willing. A computer set to Off never takes one (the owner, 17 Nov). When no computer could be scored (none
 * reports its load yet, or all are full) the one asking takes it. Balancing off: whoever asks first.
 */
export function mayClaim(kind: string, host: string, workers: WorkerSeen[], balance: Balance, now: number, onlineMs: number): boolean {
  if (!balance.on) return true;
  const weight = (h: string) => balance.weights[h] ?? DEFAULT_WEIGHT;
  if (weight(host) <= 0) return false;
  let best: string | null = null;
  let top = 0;
  for (const w of workers) {
    const asking = w.host === host;   // the one asking has a free slot, whatever its last heartbeat said
    if (!asking && (now - w.at > onlineMs || w.busy)) continue;
    if (w.never.includes(kind)) continue;
    const s = score(w, weight(w.host));
    if (s > top) [best, top] = [w.host, s];
  }
  return best === null || best === host;
}
