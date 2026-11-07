import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  FileVideo,
  Library,
  Loader2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  FORMAT_LABELS,
  cancelExport,
  dismissExport,
  downloadExport,
  downloadExportsZip,
  fmtBytes,
  saveExportToLibrary,
  useExports,
  watchExports,
  type ExportJob,
} from "@/lib/exports";
import { canUse, isGuest, useViewedMe } from "@/lib/auth";

function JobCard({ job, library }: { job: ExportJob; library: boolean }) {
  const active = job.status === "queued" || job.status === "running";
  const [saved, setSaved] = useState<"saving" | "saved" | "already" | string>();
  const save = () => {
    setSaved("saving");
    saveExportToLibrary(job.id).then(setSaved, (e: unknown) => setSaved(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="pointer-events-auto rounded-xl border border-zinc-700 bg-[#16161c] p-3 shadow-2xl">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-800">
          {job.status === "done" ? (
            <Check className="h-3.5 w-3.5 text-emerald-400" />
          ) : job.status === "error" ? (
            <TriangleAlert className="h-3.5 w-3.5 text-red-400" />
          ) : (
            <FileVideo className="h-3.5 w-3.5 text-violet-400" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-zinc-200" title={job.filename}>
            {job.filename}
          </p>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            {FORMAT_LABELS[job.format] ?? job.format}
            {job.status === "queued" && " — waiting to render…"}
            {job.status === "running" && ` — rendering ${Math.round(job.progress * 100)}%`}
            {job.status === "done" && (
              <> — ready{job.bytes ? ` · ${fmtBytes(job.bytes)}` : ""}</>
            )}
          </p>
          {job.status === "error" && (
            <p className="mt-1 break-words text-[11px] leading-4 text-red-400">
              {job.error || "Export failed"}
            </p>
          )}
          {active && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-violet-500 transition-[width] duration-500"
                style={{ width: `${Math.max(job.progress * 100, 3)}%` }}
              />
            </div>
          )}
          {job.status === "done" && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => downloadExport(job)}
                className="flex items-center gap-1.5 rounded-md bg-violet-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-violet-500"
              >
                <Download className="h-3 w-3" /> Download
              </button>
              {library && job.ext !== "zip" && (
                <button
                  onClick={save}
                  disabled={saved === "saving" || saved === "saved" || saved === "already"}
                  className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-200 hover:border-zinc-500 disabled:opacity-60"
                >
                  <Library className="h-3 w-3" />
                  {saved === "saved" ? "In the library" : saved === "already" ? "Already in the library" : saved === "saving" ? "Saving…" : "Save to library"}
                </button>
              )}
              {saved && !["saving", "saved", "already"].includes(saved) && <span className="text-[11px] text-red-400">{saved}</span>}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {job.status === "running" && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />
          )}
          <button
            onClick={() =>
              job.status === "done" ? dismissExport(job.id) : void cancelExport(job.id)
            }
            title={
              job.status === "done"
                ? "Hide (the file stays downloadable for 24 hours)"
                : active
                  ? "Cancel export"
                  : "Dismiss"
            }
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Bottom-right stack of export toasts. Exports render on the server, so
 * the tray re-attaches to in-flight or finished jobs after a reload.
 * Finished cards stay until closed (they carry Download
 * Download) or until the server drops the file after 24 hours. The stack
 * caps out with an overflow counter. It also collapses to
 * a small pill (choice remembered) so long renders don't block editing.
 */
const MAX_CARDS = 5;

export function ExportTray() {
  const jobs = useExports((s) => s.jobs);
  const dismissed = useExports((s) => s.dismissed);
  const me = useViewedMe();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("exportTrayCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggleCollapsed = () =>
    setCollapsed((v) => {
      try {
        localStorage.setItem("exportTrayCollapsed", v ? "0" : "1");
      } catch {
        /* storage unavailable */
      }
      return !v;
    });

  useEffect(() => {
    if (!isGuest(me)) watchExports(); // guests have no server-side jobs
  }, [me]);

  const visible = jobs.filter((j) => !dismissed.includes(j.id));
  if (isGuest(me)) return null;
  if (visible.length === 0) return null;

  const active = visible.filter((j) => j.status === "queued" || j.status === "running");
  const doneCount = visible.filter((j) => j.status === "done").length;
  const progress = active.length
    ? active.reduce((a, j) => a + j.progress, 0) / active.length
    : 0;
  const shown = visible.slice(0, MAX_CARDS);
  const overflow = visible.length - shown.length;

  if (collapsed) {
    return (
      <button
        onClick={toggleCollapsed}
        title="Show exports"
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full border border-zinc-700 bg-[#16161c] px-3 py-1.5 text-[11px] text-zinc-300 shadow-2xl transition-colors hover:border-zinc-500 hover:text-white"
      >
        {active.length ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin text-violet-400" />
            Rendering {Math.round(progress * 100)}%
            {active.length > 1 && ` · ${active.length}`}
          </>
        ) : (
          <>
            <Check className="h-3 w-3 text-emerald-400" />
            {doneCount || visible.length} export
            {(doneCount || visible.length) > 1 ? "s" : ""} ready
          </>
        )}
        <ChevronUp className="h-3 w-3 text-zinc-500" />
      </button>
    );
  }

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex max-h-[60vh] w-80 flex-col gap-2 overflow-y-auto">
      <div className="pointer-events-auto flex items-center justify-end gap-1.5">
        {doneCount > 1 && (
          <button
            onClick={() => downloadExportsZip(visible.filter((j) => j.status === "done"))}
            title="Every finished export here, as one ZIP"
            className="flex items-center gap-1.5 rounded-full border border-zinc-700 bg-[#16161c] px-2.5 py-1 text-[11px] text-zinc-300 shadow-xl transition-colors hover:border-zinc-500 hover:text-white"
          >
            <Download className="h-3 w-3" /> Download all {doneCount} as ZIP
          </button>
        )}
        <button
          onClick={toggleCollapsed}
          title="Minimize exports"
          className="rounded-full border border-zinc-700 bg-[#16161c] p-1 text-zinc-400 shadow-xl transition-colors hover:border-zinc-500 hover:text-white"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>
      {shown.map((j) => (
        <JobCard key={j.id} job={j} library={canUse(me, "media")} />
      ))}
      {overflow > 0 && (
        <p className="pointer-events-auto py-1 text-center text-[10px] text-zinc-500">
          + {overflow} more — close finished ones to see them
        </p>
      )}
    </div>
  );
}
