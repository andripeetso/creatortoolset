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

/** Writes the balance file whole (Settings → Computers; the studio's own Computers page writes it too). */
export async function writeBalance(user: string, cur: Balance): Promise<void> {
  await mkdir(path.dirname(balanceFile(user)), { recursive: true });
  const tmp = `${balanceFile(user)}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(cur, null, 2));
  await rename(tmp, balanceFile(user));
}

/** A computer paired again under a new id keeps its load-balancing settings: `from`'s weight, libraries and originals move to `to` (its own win). */
export async function moveBalance(user: string, from: string[], to: string): Promise<void> {
  const b = await readBalance(user);
  let moved = false;
  for (const m of [b.weights, b.libraries, b.originals ?? {}] as Record<string, unknown>[]) {
    for (const id of from) {
      if (id === to || !(id in m)) continue;
      if (!(to in m)) m[to] = m[id];
      delete m[id];
      moved = true;
    }
  }
  if (moved) await writeBalance(user, b);
}

/**
 * The owner's computers set to Off in Load balancing (weight 0 while it is on): they take no work at all, not even when
 * no other computer could (the owner, 17 Nov: Off is off), so none of them counts as the one that could.
 */
export function offOf(owner: string): Set<string> {
  const b = readBalanceSync(owner);
  return b.on ? new Set(Object.entries(b.weights).flatMap(([id, w]) => (w === 0 ? [id] : []))) : new Set();
}

/** Whether computer `id` takes Media Library work of library `library`: every library unless its list narrows it. */
export const allowsLibrary = (b: Balance, id: string, library: string): boolean => !b.libraries?.[id] || b.libraries[id]!.includes(library);

/**
 * Whether computer `d` may download an original (to make the proxy of a file only the server has): as set, else not on a
 * Linux or Windows computer (a box that takes library work beside the Mac, owner 17 Nov) and yes on a Mac.
 */
export const takesOriginals = (b: Balance, d: Pick<Device, "id" | "report">): boolean =>
  b.originals?.[d.id] ?? !["linux", "windows"].includes(d.report?.machine?.os ?? "");

/** How recent a computer's last work claim must be for it to count as one that takes work now (an idle worker asks every 25 s). */
export const CLAIM_FRESH_MS = 120_000;
export const claimsFresh = (d: Pick<Device, "work">, now = Date.now()): boolean => !!d.work?.at && now - d.work.at < CLAIM_FRESH_MS;

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
