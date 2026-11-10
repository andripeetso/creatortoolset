import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Activity, Image as ImageIcon, Loader2, RotateCcw, TriangleAlert, UserRound } from "lucide-react";
import {
  PROCESS_STEPS,
  getQueue,
  retryPost,
  runAccountJobs,
  type AccountJobType,
  type QueueEntry,
  type QueueView,
} from "@/lib/instagram";

const JOB_WORDS: Record<string, string> = {
  info: "info",
  stats: "stats",
  media: "media",
  transcript: "transcript",
  vision: "on-screen text",
  comments: "comments",
  tags: "tags",
  idea: "idea",
  profile: "profile",
  catalog: "catalog",
};

const words = (jobs: string[] | undefined) => (jobs ?? []).map((j) => JOB_WORDS[j] ?? j).join(", ");

function stepLabel(item: QueueEntry): string {
  if (item.kind === "post") {
    return PROCESS_STEPS.find((s) => s.id === item.step)?.label ?? "Working";
  }
  return item.step ? `${item.step[0]!.toUpperCase()}${item.step.slice(1)}` : "Working";
}

const ACCOUNT_JOBS = new Set<string>(["profile", "catalog", "stats", "tags"]);

/**
 * Header button next to the user menu: what the workers are doing, what
 * waits, and what failed — with a one-click retry. Polls a cheap
 * in-memory endpoint, faster while anything is moving.
 */
export function QueueMenu({
  base,
  busyHint,
  onChange,
}: {
  base: string;
  busyHint?: boolean;
  /** Called after a retry was queued so the page can refresh its lists. */
  onChange?: () => void;
}) {
  const [view, setView] = useState<QueueView | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const items = view?.items ?? [];
  const running = items.filter((i) => i.state === "running");
  const queued = items.filter((i) => i.state === "queued");
  const failed = items.filter((i) => i.state === "failed");
  const moving = running.length + queued.length > 0;

  // what is running, waiting and failed, as one string: when it changes by itself (a failed download tried again,
  // a run that ended), the page is told so its lists follow
  const seen = useRef<string | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  const refresh = useCallback(() => {
    getQueue()
      .then((next) => {
        const now = next.items.map((i) => `${i.kind}:${i.id}:${i.state}`).sort().join(",");
        if (seen.current !== null && seen.current !== now) changed.current?.();
        seen.current = now;
        setView(next);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, moving || busyHint || open ? 2000 : 10000);
    return () => window.clearInterval(t);
  }, [refresh, moving, busyHint, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const retry = async (list: QueueEntry[]) => {
    if (!list.length) return;
    setBusy(list.length === 1 ? `${list[0]!.kind}:${list[0]!.id}` : "all");
    setRetryError(null);
    try {
      for (const item of list) {
        if (item.kind === "post") {
          await retryPost(item.id);
        } else {
          const jobs = (item.jobs ?? []).filter((j): j is AccountJobType => ACCOUNT_JOBS.has(j));
          await runAccountJobs(item.id, jobs.length ? jobs : ["profile", "catalog"]);
        }
      }
    } catch (e) {
      setRetryError(e instanceof Error ? e.message : "Retry failed");
    } finally {
      setBusy(null);
      refresh();
      onChange?.();
    }
  };

  const summary = moving
    ? `${running.length} running${queued.length ? ` · ${queued.length} queued` : ""}`
    : failed.length
      ? `${failed.length} failed`
      : "Queue";

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Worker queue"
        className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors hover:bg-zinc-900 ${
          open ? "border-zinc-700 bg-zinc-900" : "border-zinc-800"
        } ${moving ? "text-zinc-100" : failed.length ? "text-red-200" : "text-zinc-500"}`}
      >
        {moving ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400" />
        ) : failed.length ? (
          <TriangleAlert className="h-3.5 w-3.5 text-red-400" />
        ) : (
          <Activity className="h-3.5 w-3.5" />
        )}
        <span className="max-w-40 truncate">{summary}</span>
        {moving && failed.length ? (
          <span className="rounded bg-red-500/20 px-1 text-[10px] text-red-200">{failed.length} failed</span>
        ) : null}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[24rem] max-w-[92vw] rounded-xl border border-zinc-800 bg-zinc-925 shadow-2xl">
          <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2 text-[11px] text-zinc-500">
            <span>
              {view ? `${view.running}/${view.max} workers busy` : "Loading…"}
            </span>
            {failed.length > 1 && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void retry(failed)}
                className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-0.5 text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
              >
                {busy === "all" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                Retry all {failed.length}
              </button>
            )}
          </div>
          {retryError && (
            <p className="border-b border-zinc-800 px-3 py-2 text-[11px] text-red-300">{retryError}</p>
          )}
          <div className="max-h-[70vh] overflow-y-auto px-3 py-1.5">
            {items.length === 0 && (
              <p className="py-4 text-center text-[11px] text-zinc-600">
                Nothing running. Jobs you start show up here.
              </p>
            )}
            {[...running, ...queued].map((item) => {
              const pct = Math.round(Math.max(0, Math.min(1, item.progress)) * 100);
              return (
                <div key={`${item.kind}:${item.id}`} className="py-1.5">
                  <Link
                    to={item.kind === "post" ? `${base}/${item.id}` : `${base}/accounts/${item.id}`}
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-2 text-[11px] hover:text-violet-200"
                  >
                    {item.kind === "account" ? (
                      <UserRound className="h-3 w-3 shrink-0 text-zinc-500" />
                    ) : (
                      <ImageIcon className="h-3 w-3 shrink-0 text-zinc-500" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-zinc-200">
                      {item.label}
                      {item.detail ? <span className="text-zinc-500"> · {item.detail}</span> : null}
                    </span>
                    <span className="shrink-0 tabular-nums text-zinc-500">
                      {item.state === "queued" ? "queued" : `${stepLabel(item)} · ${pct}%`}
                    </span>
                  </Link>
                  {item.state === "running" && (
                    <div className="mt-1 h-1 overflow-hidden rounded bg-zinc-800">
                      <div
                        className="h-full rounded bg-violet-500 transition-[width] duration-500"
                        style={{ width: `${Math.max(3, pct)}%` }}
                      />
                    </div>
                  )}
                  {item.next?.length ? (
                    <p className="mt-0.5 text-[10px] text-zinc-500">then: {words(item.next)}</p>
                  ) : null}
                </div>
              );
            })}
            {failed.length > 0 && (
              <p className="mt-1 border-t border-zinc-800 pt-2 text-[10px] font-medium uppercase tracking-wider text-red-300/80">
                Failed
              </p>
            )}
            {failed.map((item) => {
              const key = `${item.kind}:${item.id}`;
              return (
                <div key={key} className="flex items-start gap-2 py-1.5">
                  <Link
                    to={item.kind === "post" ? `${base}/${item.id}` : `${base}/accounts/${item.id}`}
                    onClick={() => setOpen(false)}
                    className="min-w-0 flex-1 text-[11px] hover:text-violet-200"
                  >
                    <span className="block truncate text-zinc-200">
                      {item.label}
                      {item.detail ? <span className="text-zinc-500"> · {item.detail}</span> : null}
                    </span>
                    <span className="line-clamp-2 text-[10px] leading-snug text-red-300/90">
                      {item.jobs?.length ? `${words(item.jobs)}: ` : ""}
                      {item.error}
                    </span>
                  </Link>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void retry([item])}
                    className="flex shrink-0 items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {busy === key ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                    Retry
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
