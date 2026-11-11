import { DRIVERS, type LimitWindow, type LimitsIdentity, type ProvidersView } from "@contracts/providers";

/**
 * The plan-limit numbers behind Settings → Usage → Plan limits. Pure: every figure comes from the latest readings and `now`,
 * so nothing here keeps history.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A window at or under this share left is amber, in Settings → Usage and in the bar on top of every page. */
export const LOW = 20;

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
 * When a Claude login can run again after a usage limit, in Usage's words ("resets in 2h 9m"): the latest reset among its
 * windows that are used up, since every one of them has to come back. Null when no reading shows a used-up window, or one
 * of them has no reset time. ponytail: Claude logins only; Codex limits are not needed by a scheduled task.
 */
export function claudeLimitReset(limits: LimitsIdentity[], now: number): string | null {
  const used = limits.filter((i) => i.driver === "claude").flatMap((i) => i.windows).filter((w) => w.usedPercent >= 100);
  if (used.length === 0 || used.some((w) => w.resetsAt === undefined)) return null;
  const latest = used.reduce((a, b) => ((b.resetsAt ?? 0) > (a.resetsAt ?? 0) ? b : a));
  return resetsIn(latest, now);
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

/**
 * The one plan line the bar on top of every page shows (PlanLimitPill), or null while every plan has room. A used-up plan
 * first, then the window with the least left at or under LOW. A call that met the limit (the AI's check note, mac-claude.ts)
 * counts until a newer reading of that login says otherwise, so it shows even while Plan limits are off on the Mac.
 */
export function planAlert(view: ProvidersView, now: number): { text: string; full: string } | null {
  const name = (d: string) => DRIVERS.find((x) => x.id === d)?.label ?? d;
  let low: { text: string; full: string; left: number } | null = null;
  for (const i of view.limits) {
    if (i.state !== "ok") continue;
    for (const raw of i.windows) {
      const w = countedWindow(i, raw, now);
      const left = leftOf(w.usedPercent);
      if (left > LOW || (low && low.left <= left)) continue;
      const reset = resetsIn(w, now);
      const text = left === 0 ? `${name(i.driver)} · ${w.label} used up${reset ? ` · ${reset}` : ""}` : `${name(i.driver)} · ${w.label}: ${left}% left`;
      low = { text, full: `${text}${left && reset ? ` · ${reset}` : ""}`, left };
    }
  }
  if (low?.left === 0) return low;
  for (const [key, c] of Object.entries(view.checks ?? {})) {
    if (!c.note || view.limits.some((i) => i.instances.includes(key) && i.at > c.at)) continue;
    // "Your Claude plan's weekly limit is reached; it resets 5pm." → "Claude weekly limit reached · resets 5pm"
    const m = /^Your (.+?) plan's (.+?) is reached(?:; it resets (.+?))?\.$/.exec(c.note);
    return { text: m ? `${m[1]} ${m[2]} reached${m[3] ? ` · resets ${m[3]}` : ""}` : c.note, full: c.note };
  }
  return low;
}
