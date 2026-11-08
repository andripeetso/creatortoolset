import type { Driver, LimitWindow, LimitsIdentity } from "@contracts/providers";

/**
 * The plan-limit maths behind Settings → Usage → Limits. Pure: every figure comes from the latest readings and `now`,
 * so nothing here keeps history. A pool is one window (e.g. Session, Weekly · Opus) across the identities that have it.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const KIND_ORDER: Record<LimitWindow["kind"], number> = { session: 0, weekly: 1, monthly: 2, other: 3 };

export type Pace = "ahead" | "on" | "under";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Percent of the window left, to the nearest whole percent. */
export const leftOf = (used: number) => Math.round(100 - clamp(used, 0, 100));

/** How far through its window a limit is (0..1), or null when the window has no reset or no length. */
export function elapsedShare(w: LimitWindow, now: number): number | null {
  if (w.resetsAt === undefined || !w.windowMs || w.windowMs <= 0) return null;
  return clamp((w.windowMs - (w.resetsAt - now)) / w.windowMs, 0, 1);
}

/** The percent left if use were exactly even across the window: where the bar's tick sits. */
export function evenPaceLeft(w: LimitWindow, now: number): number | null {
  const elapsed = elapsedShare(w, now);
  return elapsed === null ? null : Math.round((1 - elapsed) * 100);
}

/** Ahead when use runs more than 5 points past the elapsed share, under when more than 5 short, else on pace. */
export function paceOfShares(used: number, elapsed: number): Pace {
  const gap = used - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

/** "2d 4h", "3h 5m", "41m". */
export function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** "resets in 2h 5m", "resets now", "Resets momentarily"; null when the window has no reset. */
export function resetsIn(w: LimitWindow, now: number): string | null {
  if (w.resetsAt === undefined) return null;
  if (w.resetsAt <= now) return "resets now";
  if (w.resetsAt - now < MINUTE) return "Resets momentarily";
  return `resets in ${formatDuration(w.resetsAt - now)}`;
}

/** The countdown as the bar shows it: "↻ 2h 5m". */
export const resetPill = (w: LimitWindow, now: number) => resetsIn(w, now)?.replace("resets in ", "↻ ") ?? null;

/** The pool a window belongs to: Codex's slots are named by kind, the others' windows are distinct allowances. */
const poolKeyOf = (driver: Driver, w: LimitWindow) => (driver === "codex" ? w.kind : `${w.kind}:${w.id}`);

export const identityKey = (i: LimitsIdentity) => `${i.device}\n${i.driver}\n${i.label}`;

/**
 * One identity's window as it counts in its pool. A signed-out-for-the-week login (weekly used up) can't spend its
 * session: its session reads as used until the weekly or the session comes back, whichever comes first.
 * `refill` is how much of the pool this login gives back when its window resets.
 */
function memberOf(identity: LimitsIdentity, reported: LimitWindow, now: number): { identity: LimitsIdentity; window: LimitWindow; refill: number } {
  const spent =
    reported.kind === "session"
      ? identity.windows.find(
          (w) =>
            w.usedPercent >= 100 &&
            (identity.driver === "claude" ? w.id === "seven_day" : identity.driver === "codex" && w.kind === "weekly"),
        )
      : undefined;
  if (!spent) return { identity, window: reported, refill: reported.usedPercent };

  const weeklyReset = spent.resetsAt ?? null;
  const sessionReset = reported.resetsAt ?? null;
  const cutoff = Math.max(now, identity.at);
  let resetsAt: number | undefined;
  let refill = 0;
  // A stale or missing clock cannot tell when the blocked quota becomes usable.
  if (weeklyReset !== null && sessionReset !== null && weeklyReset > cutoff && sessionReset > cutoff) {
    if (sessionReset <= weeklyReset) {
      resetsAt = spent.resetsAt;
      refill = 100;
    } else if (reported.usedPercent >= 100) {
      resetsAt = reported.resetsAt;
      refill = 100;
    } else {
      resetsAt = spent.resetsAt;
      refill = 100 - clamp(reported.usedPercent, 0, 100);
    }
  }
  const { windowMs: _length, resetsAt: _reset, ...rest } = reported;
  void _length;
  void _reset;
  return { identity, window: { ...rest, usedPercent: 100, ...(resetsAt !== undefined ? { resetsAt } : {}) }, refill };
}

export interface PoolMember {
  identity: LimitsIdentity;
  window: LimitWindow;
  refill: number;
}

export interface Pool {
  key: string;
  kind: LimitWindow["kind"];
  label: string;
  /** one column per identity of the driver, in display order; `window` null = that identity has no such window */
  columns: Array<{ identity: LimitsIdentity; member: PoolMember | null }>;
  /** the mean used percent across the identities that have the window */
  used: number;
  remaining: number;
  pace: Pace | null;
  /** each identity that resets, earliest first, with the percent of the pool that reset gives back */
  resets: Array<{ member: PoolMember; at: number; restores: number }>;
}

export interface Section {
  driver: Driver;
  identities: LimitsIdentity[];
  pools: Pool[];
}

function poolsOf(identities: LimitsIdentity[], now: number): Pool[] {
  const byKey = new Map<string, PoolMember[]>();
  for (const identity of identities) {
    for (const reported of identity.windows) {
      const m = memberOf(identity, reported, now);
      const pooled = poolKeyOf(identity.driver, m.window);
      const taken = byKey.get(pooled)?.some((x) => x.identity === identity);
      const key = taken ? `${m.window.kind}:${m.window.id}` : pooled;
      byKey.set(key, [...(byKey.get(key) ?? []), m]);
    }
  }
  const pools = [...byKey].map(([key, members]): Pool => {
    const used = members.reduce((sum, m) => sum + m.window.usedPercent, 0) / members.length;
    const timed = members.flatMap((m) => {
      const share = elapsedShare(m.window, now);
      return share === null ? [] : [{ used: m.window.usedPercent, elapsed: share }];
    });
    const pace =
      timed.length === 0
        ? null
        : paceOfShares(
            timed.reduce((sum, t) => sum + t.used, 0) / timed.length,
            timed.reduce((sum, t) => sum + t.elapsed, 0) / timed.length,
          );
    const resets = members
      .flatMap((member) => {
        const at = member.window.resetsAt;
        return at === undefined ? [] : [{ member, at, restores: Math.round(member.refill / members.length) }];
      })
      .sort((a, b) => a.at - b.at);
    const first = members[0]!.window;
    return {
      key,
      kind: first.kind,
      label: first.label,
      columns: identities.map((identity) => ({ identity, member: members.find((m) => m.identity === identity) ?? null })),
      used,
      remaining: Math.round(100 - used),
      pace,
      resets,
    };
  });
  return pools.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/** Settings → Usage → Limits: one section per driver, its identities ordered by their first reset, then by name. */
export function limitSections(identities: LimitsIdentity[], now: number): Section[] {
  const drivers: Driver[] = ["claude", "codex"];
  return drivers.flatMap((driver) => {
    const own = identities.filter((i) => i.driver === driver && i.state === "ok" && i.windows.length > 0);
    if (own.length === 0) return [];
    const first = own.flatMap((i) => i.windows).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])[0]!;
    const orderReset = (i: LimitsIdentity) => {
      const w = i.windows.find((w) => poolKeyOf(driver, w) === poolKeyOf(driver, first));
      const m = w ? memberOf(i, w, now).window.resetsAt : undefined;
      return m ?? Number.POSITIVE_INFINITY;
    };
    const sorted = [...own].sort((a, b) => orderReset(a) - orderReset(b) || a.label.localeCompare(b.label));
    return [{ driver, identities: sorted, pools: poolsOf(sorted, now) }];
  });
}

/** The notice for an identity with no usable windows, or null. */
export function noticeOf(i: LimitsIdentity): string | null {
  if (i.state === "no_login") return "no sign-in in this folder";
  if (i.state === "signed_out") return "signed out: sign in again in this folder";
  if (i.state === "error") return `could not read its limits${i.error ? ` (${i.error})` : ""}`;
  return i.windows.length === 0 ? "no limits reported" : null;
}
