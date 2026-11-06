import { useEffect, useState } from "react";
import type { CleanBatch } from "@contracts/clean-batch";
import type { EditOptions } from "@contracts/clean-edit";
import { FULL_CLEANUP } from "@contracts/clean-inspection";
import {
  activeCleanBatch,
  deleteCleanBatch,
  downloadCleanBatch,
  readCleanBatch,
  startCleanBatch,
} from "@/lib/clean-batch";
import { CleanCleanupControls } from "./CleanCleanupControls";
import { AuditTable } from "./CleanMetadataAudit";
import { fmtBytes } from "@/lib/exports";

export function CleanBatchPanel({
  videos,
  busy,
  clearAfterDownload,
  onBusyChange,
  onDownloaded,
}: {
  videos: { id: string; name: string; options: EditOptions }[];
  busy: boolean;
  clearAfterDownload: boolean;
  onBusyChange: (busy: boolean) => void;
  onDownloaded: (ids: string[]) => Promise<void>;
}) {
  const [excluded, setExcluded] = useState<string[]>([]);
  const [policy, setPolicy] = useState(FULL_CLEANUP);
  const [job, setJob] = useState<CleanBatch>();
  const [working, setWorking] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState("");
  const selected = videos.filter((v) => !excluded.includes(v.id));
  const active = job?.state === "processing" || job?.state === "packing";
  useEffect(() => {
    let mounted = true;
    void activeCleanBatch()
      .then((value) => {
        if (mounted && value) setJob(value);
      })
      .catch((e) => {
        if (mounted) setError(e.message);
      })
      .finally(() => {
        if (mounted) setRestoring(false);
      });
    return () => {
      mounted = false;
    };
  }, []);
  useEffect(() => {
    onBusyChange(working || active || restoring);
  }, [working, active, restoring, onBusyChange]);
  useEffect(() => {
    if (!active || !job) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void readCleanBatch(job.id, controller.signal)
        .then((value) => {
          setJob(value);
          setError("");
        })
        .catch((e) => {
          if (!controller.signal.aborted) {
            setError(e.message);
            setJob((value) =>
              [404, 410].includes(e.status)
                ? undefined
                : value
                  ? { ...value }
                  : value,
            );
          }
        });
    }, 1500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [job, active]);
  async function start() {
    setWorking(true);
    setError("");
    try {
      setJob(
        await startCleanBatch(
          selected.map((v) => ({
            sourceId: v.id,
            options: { ...v.options, cleanup: policy },
          })),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start batch.");
    } finally {
      setWorking(false);
    }
  }
  async function clear() {
    if (!job) return;
    setWorking(true);
    setError("");
    try {
      await deleteCleanBatch(job.id);
      setJob(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not clear batch.");
    } finally {
      setWorking(false);
    }
  }
  async function download() {
    if (!job) return;
    setWorking(true);
    setError("");
    try {
      await downloadCleanBatch(job.id);
      await deleteCleanBatch(job.id);
      setJob(undefined);
      if (clearAfterDownload)
        await onDownloaded(job.results.map((r) => r.sourceId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not download batch.");
    } finally {
      setWorking(false);
    }
  }
  return (
    <details
      className="mb-5 rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4"
      open={job ? true : undefined}
    >
      <summary className="cursor-pointer text-sm font-semibold">
        Batch cleanup & ZIP export{" "}
        {active
          ? `· ${job?.completed}/${job?.total}`
          : videos.length
            ? `· ${videos.length} uploaded`
            : ""}
      </summary>
      <div className="mt-4 grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <fieldset
          disabled={working || active || Boolean(job) || restoring}
          className="space-y-3"
        >
          <p className="text-xs text-zinc-400">
            Choose up to 20 uploads, totaling at most 10 GB. Each keeps its own
            visual edits, cuts, speed and unique-hash setting. This cleanup
            preset applies to the whole batch.
          </p>
          <div className="flex flex-wrap gap-2">
            {videos.map((v) => (
              <label
                key={v.id}
                className="flex max-w-full items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-xs"
              >
                <input
                  type="checkbox"
                  checked={!excluded.includes(v.id)}
                  onChange={(e) =>
                    setExcluded((ids) =>
                      e.target.checked
                        ? ids.filter((id) => id !== v.id)
                        : [...ids, v.id],
                    )
                  }
                  className="accent-violet-500"
                />
                <span className="break-all">{v.name}</span>
              </label>
            ))}
          </div>
          <CleanCleanupControls policy={policy} onChange={setPolicy} />
          <button
            disabled={busy || !selected.length || selected.length > 20}
            onClick={() => void start()}
            className="rounded-lg bg-violet-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
          >
            Export {selected.length} video{selected.length === 1 ? "" : "s"} as
            ZIP
          </button>
        </fieldset>
        <div className="text-xs text-zinc-400">
          <p className="leading-relaxed">
            The ZIP includes one MP4 per video and a before/after audit report.
            Removed private tag values are omitted from the report. Rendered
            copies are deleted after packaging; the ZIP is deleted after
            download or expires after one hour.
          </p>
          <p className="mt-2">
            {clearAfterDownload
              ? "Uploaded originals will also be deleted after download."
              : "Uploaded originals stay until you delete the session or it expires."}
          </p>
          {restoring && (
            <p className="mt-3" role="status">
              Checking for an existing batch…
            </p>
          )}
          {job && (
            <div className="mt-4 space-y-3">
              <p role="status" className="text-violet-200">
                {job.state === "ready"
                  ? `ZIP ready · ${fmtBytes(job.bytes ?? 0)}`
                  : job.state === "packing"
                    ? "Packaging ZIP…"
                    : active
                      ? `Cleaning ${job.completed + 1} of ${job.total} · ${job.currentName ?? "Starting…"}`
                      : job.error}
              </p>
              {active && (
                <progress
                  aria-label="Batch progress"
                  className="w-full accent-violet-500"
                  max={job.total}
                  value={job.completed}
                />
              )}
              <div className="flex gap-3">
                {job.state === "ready" && (
                  <button
                    disabled={working}
                    onClick={() => void download()}
                    className="rounded-lg bg-violet-600 px-3 py-2 text-white disabled:opacity-40"
                  >
                    {working ? "Downloading…" : "Download ZIP"}
                  </button>
                )}
                <button
                  disabled={working}
                  onClick={() => void clear()}
                  className="rounded-lg border border-zinc-700 px-3 py-2 disabled:opacity-40"
                >
                  {active ? "Cancel batch" : "Clear batch"}
                </button>
              </div>
              {job.results.map((r) => (
                <details key={r.sourceId}>
                  <summary className="cursor-pointer break-all text-zinc-300">
                    {r.filename} · cleanup audit
                  </summary>
                  <AuditTable audit={r.audit} />
                </details>
              ))}
            </div>
          )}
          {error && (
            <p role="alert" className="mt-3 text-amber-300">
              {error}
            </p>
          )}
        </div>
      </div>
    </details>
  );
}
