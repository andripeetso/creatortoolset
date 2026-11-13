import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import type { AssistantMessage } from "@contracts/assistant";
import { limitChat, snoozeChat } from "@/lib/assistant";

/** "17:30", "tomorrow at 17:30", "15 Nov 17:30": when a limit resets, as the banner says it. */
export function upcoming(at: number, now = Date.now()): string {
  const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = (t: number) => {
    const d = new Date(t);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
  };
  const days = day(at) - day(now);
  if (days === 0) return time;
  if (days === 1) return `tomorrow at ${time}`;
  return `${new Date(at).toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

/** The banner's line: "Resumes 17:30" when the chat carries on by itself (a snooze past the reset is when), else "Resets 17:30". */
export function limitLineOf(limit: NonNullable<AssistantMessage["limit"]>, snoozed: number | undefined, now = Date.now()): string {
  if (!limit.until) return "Reset time unavailable; retry manually";
  const at = limit.resume && snoozed && snoozed > limit.until ? snoozed : limit.until;
  return `${limit.resume ? "Resumes" : "Resets"} ${upcoming(at, now)}`;
}

/**
 * Over the message box while the chat's newest reply is one a usage limit stopped: when the limit resets, and whether the
 * chat carries on by itself then ("Resume at reset" / "Cancel auto-resume", api/assistant.ts) or is put away till then
 * ("Snooze until reset" / "Wake now"). The server says it again on every change (sync), so nothing here is kept.
 */
export function LimitBanner({ chat, limit, snoozed }: { chat: string; limit: NonNullable<AssistantMessage["limit"]>; snoozed?: number }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [, tick] = useState(0);
  const passed = !!limit.until && limit.until <= Date.now();
  // the reset comes while the banner is up: Snooze can't wait for a time gone by
  useEffect(() => {
    if (!limit.until || passed) return;
    const t = window.setTimeout(() => tick((n) => n + 1), Math.min(limit.until - Date.now() + 50, 2 ** 31 - 1));
    return () => window.clearTimeout(t);
  }, [limit.until, passed]);
  const act = async (call: () => Promise<{ ok: boolean; error?: string }>, what: string) => {
    setPending(true);
    setFailed(null);
    const r = await call();
    setPending(false);
    if (!r.ok) setFailed(`${what}: ${r.error ?? "it didn't save"}`);
  };
  const button = "shrink-0 rounded px-1 py-0.5 text-xs font-medium text-foreground hover:bg-foreground/5 disabled:pointer-events-none disabled:opacity-50";
  return (
    <div role="alert" className="-mb-4 rounded-t-2xl border border-b-0 border-amber-300/70 bg-amber-50 px-3 pt-1.5 pb-5 text-xs motion-safe:animate-in motion-safe:fade-in dark:border-amber-400/25 dark:bg-amber-400/10">
      <div className="flex min-h-6 items-center gap-2">
        <Gauge className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="shrink-0 font-medium">Usage limit reached</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{failed ?? limitLineOf(limit, snoozed)}</span>
        {limit.until && (
          <span className="flex shrink-0 flex-wrap items-center gap-x-3">
            <button type="button" className={button} disabled={pending} onClick={() => void act(() => limitChat(chat, !limit.resume), "Could not change auto-resume")}>
              {pending ? "Saving..." : limit.resume ? "Cancel auto-resume" : "Resume at reset"}
            </button>
            <button
              type="button"
              className={button}
              disabled={pending || (!snoozed && passed)}
              onClick={() => void act(() => snoozeChat(chat, snoozed ? null : limit.until!), "Could not snooze chat")}
            >
              {pending ? "Saving..." : snoozed ? "Wake now" : "Snooze until reset"}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
