import { Check, Loader2, TriangleAlert } from "lucide-react";
import {
  JOB_GROUPS,
  groupError,
  groupStatus,
  type InstagramPost,
} from "@/lib/instagram";

/**
 * Progress for a post whose jobs are running, floating at the bottom of
 * the viewport so the page never reflows while it works. Jobs keep
 * running on the server whether or not this is on screen.
 */
export function JobsDock({ post }: { post: InstagramPost }) {
  if (post.status !== "processing") return null;
  const pct = Math.round(Math.max(0, Math.min(1, post.progress)) * 100);
  const rows = JOB_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    status: groupStatus(post.jobs, g.types),
    error: groupError(post.jobs, g.types),
  })).filter((r) => r.status !== "idle");
  const running = rows.find((r) => r.status === "running");
  const downloaded = post.slides.filter((s) => s.bytes > 0).length;
  const detail =
    running?.id === "media" && post.slides.length
      ? `Media ${downloaded}/${post.slides.length}`
      : running?.label ?? (post.step === "queued" ? "Waiting in the queue" : "Working");

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
      <div className="pointer-events-auto w-full max-w-md rounded-xl border border-zinc-800 bg-[#12121a]/95 px-4 py-3 shadow-xl backdrop-blur">
        <div className="flex items-center gap-2 text-xs">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-400" />
          <span className="min-w-0 flex-1 truncate text-zinc-100">{detail}</span>
          <span className="tabular-nums text-zinc-500">{pct}%</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-violet-500 transition-[width] duration-500"
            style={{ width: `${Math.max(3, pct)}%` }}
          />
        </div>
        {rows.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {rows.map((r) => (
              <li
                key={r.id}
                title={r.error}
                className={`flex items-center gap-1 text-[11px] ${
                  r.status === "done" || r.status === "skipped"
                    ? "text-zinc-500"
                    : r.status === "error"
                      ? "text-red-300"
                      : r.status === "running"
                        ? "text-zinc-100"
                        : "text-zinc-600"
                }`}
              >
                {r.status === "done" || r.status === "skipped" ? (
                  <Check className="h-3 w-3 text-emerald-400" />
                ) : r.status === "error" ? (
                  <TriangleAlert className="h-3 w-3" />
                ) : r.status === "running" ? (
                  <Loader2 className="h-3 w-3 animate-spin text-violet-400" />
                ) : (
                  <span className="h-3 w-3 rounded-full border border-zinc-700" />
                )}
                {r.label}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
