import { useCallback, useEffect, useRef, useState } from "react";
import { useCachedLoad } from "@/lib/local-cache";
import { onTopic, whenVisible } from "@/lib/sync";
import { Link } from "react-router";
import { Activity, Image as ImageIcon, Loader2, UserRound } from "lucide-react";
import {
  ACCOUNT_STEP_LABELS,
  PROCESS_STEPS,
  getQueue,
  retryPost,
  runAccountJobs,
  type AccountJobType,
  type QueueEntry,
  type QueueView,
} from "@/lib/instagram";

const JOB_WORDS: Record<string, string> = {
  info: "details",
  stats: "numbers",
  media: "video",
  transcript: "transcript",
  vision: "on-screen text",
  comments: "comments",
  tags: "tags",
  idea: "idea",
  profile: "profile",
  catalog: "list of posts",
};

const words = (jobs: string[] | undefined) => (jobs ?? []).map((j) => JOB_WORDS[j] ?? j).join(", ");

function stepLabel(item: QueueEntry): string {
  if (item.kind === "post") {
    return PROCESS_STEPS.find((s) => s.id === item.step)?.label ?? "Working";
  }
  return (item.step && ACCOUNT_STEP_LABELS[item.step]) || "Working";
}

/** What went wrong, in plain words: the error itself stays on the post's or the account's own page. */
function failedLabel(item: QueueEntry): string {
  if (item.kind === "account") return "Couldn’t update the account";
  return item.jobs?.includes("media") ? "Couldn’t download the video" : "Couldn’t read the post";
}

const ACCOUNT_JOBS = new Set<string>(["profile", "catalog", "stats", "tags"]);

/**
 * Header button next to the user menu, there only while something runs, waits or needs you: what is running, what
 * waits, and what failed with Try again. An amber dot says something failed. A cheap in-memory endpoint, read again
 * whenever a job saves ("instagram-jobs") or a post or account changes ("instagram"): no timer.
 */
export function QueueMenu({
  base,
  onChange,
}: {
  base: string;
  /** Called after a retry was queued so the page can refresh its lists. */
  onChange?: () => void;
}) {
  const { data: view, refresh: reload } = useCachedLoad<QueueView>("/api/instagram/queue", getQueue, { topic: "instagram-jobs" });
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
  const refresh = useCallback(() => void reload().catch(() => {}), [reload]);
  const now = items.map((i) => `${i.kind}:${i.id}:${i.state}`).sort().join(",");
  useEffect(() => {
    if (!view) return;
    if (seen.current !== null && seen.current !== now) changed.current?.();
    seen.current = now;
  }, [view, now]);
  // a post or account queued elsewhere shows here before its job's first save
  useEffect(() => onTopic("instagram", () => whenVisible("/api/instagram/queue", refresh)), [refresh]);

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
      setRetryError(e instanceof Error ? e.message : "Couldn’t try again");
    } finally {
      setBusy(null);
      refresh();
      onChange?.();
    }
  };

  // nothing runs and nothing needs you: no chip. The polling above keeps going, so it comes back by itself.
  if (!moving && !failed.length) return null;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-900 ${
          open ? "border-zinc-700 bg-zinc-900" : "border-zinc-800"
        }`}
      >
        {moving ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400" />
        ) : (
          <Activity className="h-3.5 w-3.5 text-zinc-500" />
        )}
        <span>Queue</span>
        {failed.length ? <span role="img" aria-label="Something failed" className="h-1.5 w-1.5 rounded-full bg-amber-500" /> : null}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[24rem] max-w-[92vw] rounded-xl border border-zinc-800 bg-zinc-925 shadow-2xl">
          {retryError && <p className="border-b border-zinc-800 px-3 py-2 text-[11px] text-zinc-400">{retryError}</p>}
          <div className="max-h-[70vh] overflow-y-auto px-3 py-1.5">
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
                      {item.state === "queued" ? "Waiting" : `${stepLabel(item)} · ${pct}%`}
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
            {failed.map((item) => {
              const key = `${item.kind}:${item.id}`;
              return (
                <div key={key} className="flex items-center gap-3 py-1.5">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                  <Link
                    to={item.kind === "post" ? `${base}/${item.id}` : `${base}/accounts/${item.id}`}
                    onClick={() => setOpen(false)}
                    className="min-w-0 flex-1 hover:text-violet-200"
                  >
                    <span className="block truncate text-[12px] text-zinc-200">{failedLabel(item)}</span>
                    <span className="block truncate text-[11px] text-zinc-500">
                      {item.label}
                      {item.detail ? ` · ${item.detail}` : ""}
                    </span>
                  </Link>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void retry([item])}
                    className="flex shrink-0 items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {busy === key ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    Try again
                  </button>
                </div>
              );
            })}
          </div>
          {failed.length > 1 && (
            <div className="flex justify-end border-t border-zinc-800 px-3 py-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void retry(failed)}
                className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
              >
                {busy === "all" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                Try all {failed.length} again
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
