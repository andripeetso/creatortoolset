import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_WEIGHT, type Balance, type Machine } from "../../contracts/providers";
import { env } from "./env";

/** Load balancing (Settings → Devices): on/off and each of the account's computers' preference, in $DATA_DIR/balance/<user>.json. */
export const balanceFile = (user: string) => path.join(env.dataDir, "balance", `${user}.json`);

/**
 * The owner's computers set to Off in Load balancing (weight 0 while it is on): they take no step and no picture work (work/pictures.ts), so
 * none of them counts as the one that could, and the step goes to another computer (or, in phase 4, the server).
 */
export function offOf(owner: string): Set<string> {
  try {
    const b = JSON.parse(readFileSync(balanceFile(owner), "utf8")) as Partial<Balance>;
    return b.on === false ? new Set() : new Set(Object.entries(b.weights ?? {}).flatMap(([id, w]) => (w === 0 ? [id] : [])));
  } catch {
    return new Set();
  }
}
function parseBalance(text: string): Balance {
  const b = JSON.parse(text) as Partial<Balance>;
  return { on: b.on !== false, weights: b.weights && typeof b.weights === "object" ? b.weights : {} };
}
export async function readBalance(user: string): Promise<Balance> {
  try {
    return parseBalance(await readFile(balanceFile(user), "utf-8"));
  } catch {
    return { on: true, weights: {} };
  }
}
/** readBalance for a caller that cannot wait (a device job slot's claim, lib/plugin.ts DeviceJobSlot). */
export function balanceNow(user: string): Balance {
  try {
    return parseBalance(readFileSync(balanceFile(user), "utf-8"));
  } catch {
    return { on: true, weights: {} };
  }
}

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
 * free and willing; when none qualifies (no other computer, none reports its load) the one asking takes it, even one
 * set to Off (weight 0 is never the best, so Off only means "not while another can take it"). Balancing off: whoever asks first.
 */
export function mayClaim(kind: string, host: string, workers: WorkerSeen[], balance: Balance, now: number, onlineMs: number): boolean {
  if (!balance.on) return true;
  const weight = (h: string) => balance.weights[h] ?? DEFAULT_WEIGHT;
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
