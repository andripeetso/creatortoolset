import { useState } from "react";
import {
  Check,
  CloudUpload,
  Download,
  FileVideo,
  Loader2,
  Share2,
  TriangleAlert,
} from "lucide-react";
import { useStudio } from "@/lib/store";
import { buildAss } from "@/lib/ass";
import {
  downloadExport,
  fmtBytes,
  startExport,
  useExports,
  type ExportJob,
} from "@/lib/exports";

/**
 * Step 4: one-tap export. Always the same path — native engine (ASS →
 * server-side ffmpeg/libass burn-in), H.264 MP4 of the active clip.
 * The video upload finishes in the background while editing, so this
 * screen usually starts ready; if not, it waits on the upload bar.
 */
export function MobileExport() {
  const clips = useStudio((s) => s.clips);
  const activeClipId = useStudio((s) => s.activeClipId);
  const activeClip = clips.find((c) => c.id === activeClipId);
  const projectId = useStudio((s) => s.projectId);
  const fps = useStudio((s) => s.fps);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useExports((s) => s.jobs.find((j) => j.id === jobId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uploadDone =
    !!projectId && !!activeClip?.hasOriginal && activeClip.uploadState === "done";

  const start = async () => {
    const s = useStudio.getState();
    const width = s.sourceWidth || s.videoWidth;
    const height = s.sourceHeight || s.videoHeight;
    if (!s.cues.length) {
      setError("No captions to export");
      return;
    }
    if (!projectId || !activeClipId) return;
    setBusy(true);
    setError(null);
    try {
      const name = (activeClip?.name || "captions").replace(/\.[^.]+$/, "");
      const j = await startExport({
        kind: "burn",
        engine: "native",
        ass: buildAss(s.cues, s.style, width, height, s.posSegments, s.texts),
        format: "h264",
        name,
        duration: s.duration,
        projectId,
        clipId: activeClipId,
        width,
        height,
        fps,
      });
      setJobId(j.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const share = async (j: ExportJob) => {
    try {
      const res = await fetch(`/api/exports/${j.id}/file`);
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const file = new File([blob], j.filename, { type: "video/mp4" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
    }
    downloadExport(j);
  };

  return (
    <div className="pb-safe flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-8">
      {!job && (
        <>
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-violet-600">
            <FileVideo className="h-8 w-8 text-white" />
          </div>
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight">
              Export video
            </h1>
            <p className="mt-2 max-w-xs text-sm leading-6 text-zinc-400">
              MP4 · H.264 with captions burned in — ready to post.
            </p>
          </div>

          {!uploadDone && activeClip && (
            <div className="w-full max-w-xs">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs text-zinc-500">
                <CloudUpload className="h-3.5 w-3.5" />
                {activeClip.uploadState === "processing"
                  ? "Server is preparing the video…"
                  : activeClip.uploadState === "error"
                    ? "Upload failed — export needs the video on the server"
                    : `Uploading video… ${activeClip.uploadPct}%`}
              </p>
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-violet-500 transition-[width] duration-300"
                  style={{
                    width: `${
                      activeClip.uploadState === "processing"
                        ? 100
                        : Math.max(activeClip.uploadPct, 4)
                    }%`,
                  }}
                />
              </div>
            </div>
          )}

          {error && (
            <p className="flex max-w-xs items-start gap-1.5 text-sm text-red-400">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}
            </p>
          )}

          <button
            onClick={() => void start()}
            disabled={busy || !uploadDone}
            className="w-full max-w-xs rounded-2xl bg-violet-600 py-4 text-base font-semibold text-white active:bg-violet-500 disabled:opacity-40"
          >
            {busy ? "Starting…" : "Render video"}
          </button>
        </>
      )}

      {job && (job.status === "queued" || job.status === "running") && (
        <>
          <Loader2 className="h-10 w-10 animate-spin text-violet-400" />
          <div className="text-center">
            <p className="text-base font-medium text-zinc-100">
              {job.status === "queued" ? "Waiting to render…" : job.note ?? "Rendering…"}
            </p>
            <p className="mt-1.5 text-sm text-zinc-500">
              {Math.round(job.progress * 100)}% — keep the app open
            </p>
          </div>
          <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-violet-500 transition-[width] duration-500"
              style={{ width: `${Math.max(job.progress * 100, 4)}%` }}
            />
          </div>
        </>
      )}

      {job && job.status === "done" && (
        <>
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/15">
            <Check className="h-8 w-8 text-emerald-400" />
          </div>
          <div className="text-center">
            <p className="text-base font-medium text-zinc-100">Video ready</p>
            <p className="mt-1 text-sm text-zinc-500">
              {job.bytes ? fmtBytes(job.bytes) : ""} · MP4 · H.264
            </p>
          </div>
          <div className="flex w-full max-w-xs flex-col gap-2.5">
            <button
              onClick={() => void share(job)}
              className="flex items-center justify-center gap-2 rounded-2xl bg-violet-600 py-4 text-base font-semibold text-white active:bg-violet-500"
            >
              <Share2 className="h-5 w-5" /> Share / save video
            </button>
            <button
              onClick={() => downloadExport(job)}
              className="flex items-center justify-center gap-2 rounded-2xl border border-zinc-700 py-3.5 text-sm font-medium text-zinc-300 active:bg-zinc-800"
            >
              <Download className="h-4 w-4" /> Download file
            </button>
          </div>
        </>
      )}

      {job && job.status === "error" && (
        <>
          <TriangleAlert className="h-10 w-10 text-red-400" />
          <div className="text-center">
            <p className="text-base font-medium text-zinc-100">Render failed</p>
            <p className="mt-1.5 max-w-xs text-sm leading-6 text-zinc-500">
              {job.error || "Something went wrong"}
            </p>
          </div>
          <button
            onClick={() => setJobId(null)}
            className="rounded-xl bg-violet-600 px-8 py-3 text-base font-semibold text-white active:bg-violet-500"
          >
            Try again
          </button>
        </>
      )}
    </div>
  );
}
