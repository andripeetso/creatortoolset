import { DEFAULT_WEIGHT, type Balance, type Machine } from "../../contracts/providers";

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
