/** When a message was said, beside it: its time today, "yesterday at 18:15", else its day too ("3 Nov 18:15"). */
export function whenSaid(at: number, now = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // whole days between the two dates (a day of 23 or 25 hours rounds to one)
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `yesterday at ${time}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short", ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) })} ${time}`;
}
