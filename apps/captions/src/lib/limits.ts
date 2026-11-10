import type { LimitWindow, LimitsIdentity } from "@contracts/providers";

/**
 * The plan-limit numbers behind Settings → Usage → Plan limits. Pure: every figure comes from the latest readings and `now`,
 * so nothing here keeps history.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Percent of the window left, to the nearest whole percent. */
export const leftOf = (used: number) => Math.round(100 - clamp(used, 0, 100));

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

export const identityKey = (i: LimitsIdentity) => `${i.device}\n${i.driver}\n${i.label}`;

/**
 * One window as it counts for its login now. A Claude login whose weekly is used up can't spend its session, so its
 * session reads used until the weekly comes back, or the session if it is still running past the weekly.
 */
export function countedWindow(identity: LimitsIdentity, reported: LimitWindow, now: number): LimitWindow {
  const spent =
    reported.kind === "session"
      ? identity.windows.find(
          (w) =>
            w.usedPercent >= 100 &&
            (identity.driver === "claude" ? w.id === "seven_day" : identity.driver === "codex" && w.kind === "weekly"),
        )
      : undefined;
  if (!spent) return reported;

  const weeklyReset = spent.resetsAt ?? null;
  const sessionReset = reported.resetsAt ?? null;
  const cutoff = Math.max(now, identity.at);
  // A stale or missing clock cannot tell when the blocked quota becomes usable, so the session shows used with no reset.
  const clockOk = weeklyReset !== null && sessionReset !== null && weeklyReset > cutoff && sessionReset > cutoff;
  const resetsAt = clockOk ? (sessionReset > weeklyReset && reported.usedPercent >= 100 ? sessionReset : weeklyReset) : undefined;
  const { windowMs: _length, resetsAt: _reset, ...rest } = reported;
  void _length;
  void _reset;
  return { ...rest, usedPercent: 100, ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

/**
 * The sentence for a login with no usable reading, or null. `customEndpoint`: the Mac reports that this Claude folder sends
 * its requests to a custom endpoint (ANTHROPIC_BASE_URL), which has no claude.ai plan to read.
 */
export function noticeOf(i: LimitsIdentity, customEndpoint = false): string | null {
  if (i.state === "no_login") {
    if (i.driver !== "claude") return "This folder has no ChatGPT sign-in, so there is no plan to read.";
    return customEndpoint
      ? "This folder sends its requests through a custom endpoint, so there is no plan to read."
      : "This folder has no Claude sign-in, so there is no plan to read.";
  }
  if (i.state === "signed_out") return "Signed out in this folder. Sign in again there, and the reading comes back within five minutes.";
  if (i.state === "error") return `Its limits could not be read${i.error ? ` (${i.error})` : ""}.`;
  return i.windows.length === 0 ? "No limits reported." : null;
}
