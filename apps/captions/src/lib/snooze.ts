/** A time a chat can be put away until: what it is called, the clock time said beside it, and the time itself (ms). */
export interface SnoozeChoice {
  label: string;
  when: string;
  until: number;
}

const HOUR = 3600_000;
const clock = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** `days` from `from` at `hour` o'clock, by the calendar (a day with a clock change is still one day). */
const dayAt = (from: Date, days: number, hour: number) => new Date(from.getFullYear(), from.getMonth(), from.getDate() + days, hour, 0, 0, 0);

/**
 * The times offered for putting a chat away, soonest first: in an hour, in three, this evening at six (while that is
 * still to come), tomorrow at nine, and next week (Monday at nine). Two that come to the same minute are one. The
 * clock time beside each has the weekday before it when it is on another day and the name does not say which.
 */
export function snoozeChoices(now = Date.now()): SnoozeChoice[] {
  const at = new Date(now);
  const part = (h: number) => (h < 12 ? "morning" : h < 17 ? "afternoon" : "evening");
  const monday = (8 - at.getDay()) % 7 || 7;
  const all: Array<{ label: string; t: Date; named?: true }> = [
    { label: "In 1 hour", t: new Date(now + HOUR) },
    { label: "In 3 hours", t: new Date(now + 3 * HOUR) },
    { label: `This ${part(18)}`, t: dayAt(at, 0, 18), named: true },
    { label: "Tomorrow", t: dayAt(at, 1, 9), named: true },
    { label: "Next week", t: dayAt(at, monday, 9) },
  ];
  const seen = new Set<number>();
  return all
    .filter((c) => c.t.getTime() > now)
    .sort((a, b) => a.t.getTime() - b.t.getTime())
    .filter((c) => {
      const minute = Math.floor(c.t.getTime() / 60_000);
      return !seen.has(minute) && !!seen.add(minute);
    })
    .map((c) => ({ label: c.label, when: c.named || sameDay(c.t, at) ? clock(c.t) : `${c.t.toLocaleDateString([], { weekday: "short" })} ${clock(c.t)}`, until: c.t.getTime() }));
}

/** How long until a chat put away comes back, short: 12m, 3h, 2d. */
export function snoozeLeft(until: number, now = Date.now()): string {
  const mins = Math.max(1, Math.round((until - now) / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

/** A date and time as an <input type="datetime-local"> holds it (local, to the minute). */
export const localInput = (ms: number): string => {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
};
