import { useEffect, useRef, useState } from "react";
import {
  Captions,
  Check,
  Clapperboard,
  CloudUpload,
  Download,
  FileVideo,
  History,
  Laptop,
  Loader2,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { useStudio, clipRenderData, getClipSnapshot, retainClipSourceFile } from "@/lib/store";
import { buildAss, buildSrt, buildVtt } from "@/lib/ass";
import { exportBase, exportName, renderSpecOf } from "@/lib/export-request";
import {
  FORMAT_LABELS,
  batchExports,
  cancelExport,
  downloadExport,
  fmtBytes,
  startExport,
  timeAgo,
  useExports,
  watchExports,
  type ExportJob,
} from "@/lib/exports";
import { retryClipUpload } from "@/lib/persist";
import {
  canExportCaptionedVideoLocal,
  exportCaptionedVideoLocal,
} from "@/lib/local-video-export";
import type { ExportFormat } from "@/lib/types";
import { FpsSelect } from "./FpsSelect";

type Tab = "video" | "captions" | "recent";

const FORMATS: {
  id: ExportFormat;
  tab: Tab;
  name: string;
  desc: string;
  alpha: boolean;
  server: boolean;
  burn?: boolean;
}[] = [
  {
    id: "mp4",
    tab: "video",
    name: "MP4 · H.264 captioned",
    desc: "Finished video with captions burned in — ready to post.",
    alpha: false,
    server: true,
    burn: true,
  },
  {
    id: "hevc",
    tab: "video",
    name: "MP4 · H.265 captioned",
    desc: "Same, ~35% smaller file, slower render.",
    alpha: false,
    server: true,
    burn: true,
  },
  {
    id: "srt",
    tab: "captions",
    name: "SRT subtitles",
    desc: "Closed-caption sidecar for YouTube, players, NLEs.",
    alpha: false,
    server: false,
  },
  {
    id: "vtt",
    tab: "captions",
    name: "WebVTT subtitles",
    desc: "Closed captions for the web.",
    alpha: false,
    server: false,
  },
  {
    id: "ass",
    tab: "captions",
    name: "ASS subtitle file",
    desc: "Full styling + karaoke, for advanced pipelines.",
    alpha: false,
    server: false,
  },
  {
    id: "mov",
    tab: "captions",
    name: "MOV · ProRes 4444",
    desc: "Transparent captions for Premiere / Resolve / FCP. Large file.",
    alpha: true,
    server: true,
  },
  {
    id: "webm",
    tab: "captions",
    name: "WebM · VP9",
    desc: "Transparent captions, small file. For web & Chrome.",
    alpha: true,
    server: true,
  },
  {
    id: "png",
    tab: "captions",
    name: "PNG sequence (ZIP)",
    desc: "One transparent PNG per frame. Universal fallback.",
    alpha: true,
    server: true,
  },
];

const TABS: { id: Tab; name: string; icon: typeof Captions }[] = [
  { id: "video", name: "Video with captions", icon: Clapperboard },
  { id: "captions", name: "Captions only", icon: Captions },
  { id: "recent", name: "Recent", icon: History },
];

/** Past exports (Canva-style downloads list): re-download or delete. */
function RecentExports({ jobs }: { jobs: ExportJob[] }) {
  if (jobs.length === 0) {
    return (
      <p className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-8 text-center text-xs text-zinc-500">
        No exports yet — rendered files show up here.
      </p>
    );
  }
  return (
    <>
      <div className="max-h-80 space-y-1.5 overflow-y-auto pr-0.5">
        {jobs.map((j) => {
          const active = j.status === "queued" || j.status === "running";
          return (
            <div
              key={j.id}
              className="flex items-center gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-800">
                {j.status === "done" ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : j.status === "error" ? (
                  <TriangleAlert className="h-3.5 w-3.5 text-red-400" />
                ) : (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className="block truncate text-xs font-medium text-zinc-200"
                  title={j.filename}
                >
                  {j.filename}
                </span>
                <span
                  className="block truncate text-[11px] text-zinc-500"
                  title={j.status === "error" ? j.error : undefined}
                >
                  {FORMAT_LABELS[j.format] ?? j.format}
                  {j.status === "queued" && " — waiting to render…"}
                  {j.status === "running" &&
                    ` — rendering ${Math.round(j.progress * 100)}%`}
                  {j.status === "done" && (
                    <>
                      {j.bytes ? ` · ${fmtBytes(j.bytes)}` : ""} ·{" "}
                      {timeAgo(j.finishedAt ?? j.createdAt)}
                    </>
                  )}
                  {j.status === "error" && ` — ${j.error || "failed"}`}
                </span>
              </span>
              {j.status === "done" && (
                <button
                  onClick={() => downloadExport(j)}
                  title="Download"
                  className="shrink-0 rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-50"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                onClick={() => void cancelExport(j.id)}
                title={active ? "Cancel export" : "Delete from server"}
                className="shrink-0 rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
              >
                {active ? (
                  <X className="h-3.5 w-3.5" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          );
        })}
      </div>
      <p className="mt-2.5 text-center text-[11px] leading-4 text-zinc-500">
        Exports stay downloadable for 24 hours, then are cleaned up automatically.
      </p>
    </>
  );
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const cues = useStudio((s) => s.cues);
  const texts = useStudio((s) => s.texts);
  const clips = useStudio((s) => s.clips);
  const activeClipId = useStudio((s) => s.activeClipId);
  const activeClip = clips.find((c) => c.id === activeClipId);
  const activeLocalFile = activeClipId
    ? (getClipSnapshot(activeClipId)?.file ?? null)
    : null;
  const projectId = useStudio((s) => s.projectId);
  const serverProjectReady = useStudio((s) => s.serverProjectReady);
  const [tab, setTab] = useState<Tab>("video");
  const [format, setFormat] = useState<ExportFormat>("mp4");
  const jobs = useExports((s) => s.jobs);

  // opening the Recent tab re-syncs with the server
  useEffect(() => {
    if (tab === "recent") watchExports();
  }, [tab]);
  const fps = useStudio((s) => s.fps);
  const [busy, setBusy] = useState(false);
  const [localProgress, setLocalProgress] = useState(0);
  const [localCodecSupported, setLocalCodecSupported] = useState<
    boolean | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const selectedClipIds = useStudio((s) => s.selectedClipIds);
  const selCount = clips.filter((c) => selectedClipIds.includes(c.id)).length;
  const [scope, setScope] = useState<"one" | "selected" | "all">(() =>
    selectedClipIds.length > 0 ? "selected" : "one",
  );
  const batch = scope !== "one";
  const batchClips =
    scope === "selected"
      ? clips.filter((c) => selectedClipIds.includes(c.id))
      : clips;
  const [engine, setEngine] = useState<"native" | "wysiwyg">("native");
  const [renderLocation, setRenderLocation] = useState<"local" | "cloud">(() =>
    activeClip?.hasOriginal ? "cloud" : activeLocalFile ? "local" : "cloud",
  );
  const renderLocationManual = useRef(false);
  const [attaching, setAttaching] = useState(false);
  const [renderWhenReady, setRenderWhenReady] = useState(false);

  useEffect(() => {
    if (!activeLocalFile && renderLocation === "local") {
      setRenderLocation("cloud");
    }
  }, [activeLocalFile, renderLocation]);

  // Once the source reaches cloud storage, hands-off cloud rendering becomes
  // the better default (nothing blocks the tab) — unless the user picked a
  // location themselves.
  const hasServerSource = activeClip?.hasOriginal;
  useEffect(() => {
    if (hasServerSource && !renderLocationManual.current) {
      setRenderLocation("cloud");
    }
  }, [hasServerSource]);

  // export filenames: {project}_{clip} — the server appends "-captioned"
  const fileName = useStudio((s) => s.fileName);
  const projBase = exportBase(fileName);
  const named = (clipName: string) => exportName(fileName, clipName);
  const base = named(activeClip?.name || "captions");
  const tabFormats = FORMATS.filter((f) => f.tab === tab);
  const selected = FORMATS.find((f) => f.id === format)!;
  const useLocalRender =
    !!selected.burn && !batch && renderLocation === "local";
  const cloudBurnReady = serverProjectReady && !!activeClip?.hasOriginal;
  const localBurnReady = !!activeLocalFile;
  const burnReady = useLocalRender ? localBurnReady : cloudBurnReady;
  const sourcePreparing =
    activeClip?.uploadState === "local" ||
    activeClip?.uploadState === "uploading" ||
    activeClip?.uploadState === "processing";
  const sourceRecoverable =
    sourcePreparing || activeClip?.uploadState === "error";
  const burnBlockerLabel = renderWhenReady
    ? "Waiting for video — export will start automatically…"
    : activeClip?.uploadState === "error"
      ? "Retry the video upload to enable export"
      : sourcePreparing
        ? "Render when the video is ready"
        : "Attach the source video to enable export";
  // the active clip's render dimensions (original resolution, not proxy)
  const activeDims = {
    width: useStudio((s) => s.sourceWidth || s.videoWidth),
    height: useStudio((s) => s.sourceHeight || s.videoHeight),
    duration: useStudio((s) => s.duration),
  };

  useEffect(() => {
    let current = true;
    if (!activeLocalFile || !selected.burn) {
      setLocalCodecSupported(null);
      return () => {
        current = false;
      };
    }
    setLocalCodecSupported(null);
    void canExportCaptionedVideoLocal(
      format === "hevc" ? "h265" : "h264",
      activeDims.width,
      activeDims.height,
    ).then((supported) => {
      if (!current) return;
      setLocalCodecSupported(supported);
      if (!supported) setRenderLocation("cloud");
    });
    return () => {
      current = false;
    };
  }, [
    activeDims.height,
    activeDims.width,
    activeLocalFile,
    format,
    selected.burn,
  ]);

  const switchTab = (t: Tab) => {
    setTab(t);
    setError(null);
    if (t !== "recent" && selected.tab !== t) {
      setFormat(FORMATS.find((f) => f.tab === t)!.id);
    }
  };

  const attachOriginal = (f: File) => {
    if (!activeClipId) return;
    setAttaching(true);
    setError(null);
    try {
      if (!retainClipSourceFile(activeClipId, f)) {
        throw new Error("Could not attach the source to this clip.");
      }
      retryClipUpload(activeClipId);
      setRenderLocation("local");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAttaching(false);
    }
  };

  const removeOriginal = async () => {
    if (!projectId || !activeClipId) return;
    await fetch(`/api/projects/${projectId}/clips/${activeClipId}/original`, {
      method: "DELETE",
    }).catch(() => {});
    useStudio.setState((s) => ({
      clips: s.clips.map((c) =>
        c.id === activeClipId
          ? { ...c, hasOriginal: false, originalBytes: 0 }
          : c,
      ),
    }));
  };

  // SRT/VTT carry captions only — text overlays need ASS or a video render
  const needsCues = format === "srt" || format === "vtt";
  const hasContent = (d: { cues: unknown[]; texts: unknown[] }) =>
    d.cues.length > 0 || (!needsCues && d.texts.length > 0);
  const clipExportable = (clipId: string) => {
    const d = clipRenderData(clipId);
    return !!d && hasContent(d);
  };

  /**
   * Starts one clip's export; a server render answers its job id. A
   * subtitle file downloads, or joins `files` (a batch's ZIP).
   */
  const exportOne = async (
    clipId: string,
    name: string,
    files?: { name: string; data: Uint8Array<ArrayBuffer> }[],
  ): Promise<string | void> => {
    const d = clipRenderData(clipId);
    if (!d || !hasContent(d)) throw new Error("nothing to export");
    if (!selected.server) {
      const content =
        format === "srt"
          ? buildSrt(d.cues, d.style)
          : format === "vtt"
            ? buildVtt(d.cues, d.style)
            : buildAss(
                d.cues,
                d.style,
                d.width,
                d.height,
                d.posSegments,
                d.texts,
              );
      if (files) {
        files.push({ name: `${name}.${format}`, data: new TextEncoder().encode(content) });
      } else {
        downloadBlob(new Blob([content], { type: "text/plain" }), `${name}.${format}`);
      }
      return;
    }
    if (useLocalRender) {
      const file = getClipSnapshot(clipId)?.file;
      if (!file) {
        throw new Error(
          "The original video is no longer available on this device. Choose Cloud background render or attach the source again.",
        );
      }
      setLocalProgress(0);
      await exportCaptionedVideoLocal({
        file,
        filename: `${name}-captioned.mp4`,
        codec: format === "hevc" ? "h265" : "h264",
        fps,
        spec: renderSpecOf(d),
        onProgress: setLocalProgress,
      });
      return;
    }
    const render =
      engine === "native"
        ? {
            engine: "native" as const,
            ass: buildAss(
              d.cues,
              d.style,
              d.width,
              d.height,
              d.posSegments,
              d.texts,
            ),
          }
        : {
            engine: "wysiwyg" as const,
            renderSpec: renderSpecOf(d),
          };
    if (selected.burn) {
      const job = await startExport({
        kind: "burn",
        format: format === "hevc" ? "h265" : "h264",
        name,
        duration: d.duration,
        projectId: projectId!,
        clipId,
        width: d.width,
        height: d.height,
        fps,
        ...render,
      });
      return job.id;
    } else {
      const job = await startExport({
        kind: "overlay",
        format,
        name,
        duration: d.duration,
        width: d.width,
        height: d.height,
        fps,
        projectId: projectId ?? undefined,
        ...render,
      });
      return job.id;
    }
  };

  const doExport = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!batch || !activeClipId) {
        await exportOne(activeClipId!, base);
        onClose();
        return;
      }
      // batch: one export per in-scope clip that has captions
      const skipped: string[] = [];
      const ids: string[] = [];
      const files: { name: string; data: Uint8Array<ArrayBuffer> }[] = [];
      let started = 0;
      for (const clip of batchClips) {
        const d = clipRenderData(clip.id);
        if (!d || !hasContent(d) || d.duration <= 0) {
          skipped.push(clip.name);
          continue;
        }
        if (selected.burn && !clip.hasOriginal) {
          skipped.push(`${clip.name} (no source in cloud storage)`);
          continue;
        }
        const id = await exportOne(clip.id, named(clip.name), files);
        if (id) ids.push(id);
        started++;
      }
      // several files = one ZIP: renders when the last
      // is done, subtitle files now
      batchExports(ids, projBase || "exports");
      if (files.length === 1) {
        downloadBlob(new Blob([files[0].data], { type: "text/plain" }), files[0].name);
      } else if (files.length > 1) {
        const { zipStored } = await import("@/lib/story-split");
        downloadBlob(zipStored(files), `${projBase || "captions"}.zip`);
      }
      if (skipped.length > 0) {
        setError(
          `Started ${started} export${started === 1 ? "" : "s"} — skipped: ${skipped.join(", ")}`,
        );
        if (started === 0) return;
      }
      if (started > 0) onClose();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const prepareAndExport = () => {
    setError(null);
    if (
      activeClip &&
      (activeClip.uploadState === "local" || activeClip.uploadState === "error")
    ) {
      retryClipUpload(activeClip.id);
    }
    setRenderWhenReady(true);
  };

  const doExportRef = useRef(doExport);
  doExportRef.current = doExport;

  // A user can queue the render while the source is still uploading or the
  // server is building its editing proxy. As soon as that shared prerequisite
  // is ready, start the requested H.264/H.265 render with the chosen engine.
  useEffect(() => {
    if (!renderWhenReady) return;
    if (activeClip?.uploadState === "error") {
      setRenderWhenReady(false);
      setError(activeClip.uploadError || "Video upload failed");
      return;
    }
    if (!cloudBurnReady) return;
    setRenderWhenReady(false);
    void doExportRef.current();
  }, [
    renderWhenReady,
    cloudBurnReady,
    activeClip?.uploadState,
    activeClip?.uploadError,
  ]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[520px] max-w-[92vw] rounded-2xl border border-zinc-700 bg-zinc-900 p-5 text-zinc-200 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Download className="h-4 w-4 text-violet-400" /> Export
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4 grid grid-cols-3 gap-1 rounded-lg bg-zinc-900 p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => switchTab(t.id)}
              className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors ${
                tab === t.id
                  ? "bg-zinc-700/70 text-zinc-50"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <t.icon className="h-3.5 w-3.5" /> {t.name}
              {t.id === "recent" &&
                jobs.some(
                  (j) => j.status === "queued" || j.status === "running",
                ) && (
                  <Loader2 className="h-3 w-3 animate-spin text-violet-400" />
                )}
            </button>
          ))}
        </div>

        {tab === "recent" && <RecentExports jobs={jobs} />}

        <div className={tab === "recent" ? "hidden" : undefined}>
          {(() => {
            const card = (f: (typeof FORMATS)[number]) => {
              return (
                <button
                  key={f.id}
                  onClick={() => setFormat(f.id)}
                  className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    format === f.id
                      ? "border-violet-500 bg-violet-500/15"
                      : "border-zinc-700 hover:border-zinc-500"
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <FileVideo className="h-3.5 w-3.5 text-zinc-500" />
                    {f.name}
                    {f.alpha && (
                      <span className="rounded bg-emerald-500/15 px-1 py-px text-[9px] font-semibold uppercase text-emerald-400">
                        alpha
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-zinc-500">
                    {f.desc}
                  </span>
                </button>
              );
            };
            // captions tab: transparent renders vs subtitle files, side by side
            if (tab === "captions") {
              const alpha = tabFormats.filter((f) => f.alpha);
              const files = tabFormats.filter((f) => !f.alpha);
              return (
                <div className="mb-4 grid grid-cols-2 items-stretch gap-3">
                  <div className="flex flex-col">
                    <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                      Transparent video
                    </p>
                    <div className="flex flex-1 flex-col gap-2 [&>*]:flex-1">
                      {alpha.map(card)}
                    </div>
                  </div>
                  <div className="flex flex-col">
                    <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                      Subtitle files
                    </p>
                    <div className="flex flex-1 flex-col gap-2 [&>*]:flex-1">
                      {files.map(card)}
                    </div>
                  </div>
                </div>
              );
            }
            return (
              <div className="mb-4 grid grid-cols-2 gap-2">
                {tabFormats.map(card)}
              </div>
            );
          })()}

          {selected.burn && !batch && (
            <div className="mb-3">
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                Render using
              </p>
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-900 p-1">
                <button
                  type="button"
                  disabled={!activeLocalFile || localCodecSupported === false}
                  onClick={() => {
                    renderLocationManual.current = true;
                    setRenderLocation("local");
                    setRenderWhenReady(false);
                    setError(null);
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium transition-colors ${
                    renderLocation === "local"
                      ? "bg-violet-600/20 text-violet-200"
                      : "text-zinc-400 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-35"
                  }`}
                >
                  <Laptop className="h-3.5 w-3.5" />
                  {localCodecSupported === false
                    ? "Unavailable for this codec"
                    : "This device · no upload"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    renderLocationManual.current = true;
                    setRenderLocation("cloud");
                    setError(null);
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium transition-colors ${
                    renderLocation === "cloud"
                      ? "bg-zinc-700/70 text-zinc-50"
                      : "text-zinc-400 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-35"
                  }`}
                >
                  <CloudUpload className="h-3.5 w-3.5" /> Cloud background
                </button>
              </div>
              {renderLocation === "local" && (
                <p className="mt-1.5 text-pretty text-center text-[11px] leading-4 text-emerald-400/80">
                  Uses the original file already on this device. The source
                  upload is not required.
                </p>
              )}
            </div>
          )}

          {selected.burn && !batch && renderLocation === "cloud" && (
            <div className="mb-4 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 text-xs">
              {burnReady ? (
                <span className="flex items-center justify-between gap-2">
                  <span
                    className="min-w-0 truncate whitespace-nowrap text-zinc-400"
                    title="Source video is in cloud storage and renders at full quality"
                  >
                    Cloud source ·{" "}
                    {((activeClip?.originalBytes ?? 0) / 1e6).toFixed(
                      (activeClip?.originalBytes ?? 0) < 10e6 ? 1 : 0,
                    )}{" "}
                    MB · Full-quality renders
                  </span>
                  <button
                    onClick={removeOriginal}
                    title="Delete the source from cloud storage (captions stay editable; re-attach anytime)"
                    className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                  >
                    <Trash2 className="h-3 w-3" /> Free up space
                  </button>
                </span>
              ) : activeClip?.uploadState === "error" ? (
                <span className="flex items-center justify-between gap-3">
                  <span className="min-w-0 text-amber-300">
                    <span className="block">
                      Video upload failed — cloud export needs the source in
                      cloud storage.
                    </span>
                    {activeClip.uploadError && (
                      <span
                        className="mt-0.5 block truncate text-[11px] text-amber-400/70"
                        title={activeClip.uploadError}
                      >
                        {activeClip.uploadError}
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => retryClipUpload(activeClip.id)}
                    className="flex shrink-0 items-center gap-1 rounded border border-amber-500/40 px-2 py-1 text-amber-200 hover:bg-amber-500/10"
                  >
                    <CloudUpload className="h-3 w-3" /> Retry upload
                  </button>
                </span>
              ) : sourcePreparing ? (
                <span className="block">
                  <span className="flex items-center justify-between gap-3 text-zinc-400">
                    <span className="flex items-center gap-1.5">
                      {activeClip?.uploadState === "processing" ? (
                        <Loader2 className="h-3 w-3 animate-spin text-violet-400" />
                      ) : (
                        <CloudUpload className="h-3 w-3 animate-pulse text-violet-400" />
                      )}
                      {activeClip?.uploadState === "processing"
                        ? "Upload complete — preparing the video for export…"
                        : activeClip?.uploadState === "uploading"
                          ? "Uploading source video directly to cloud storage…"
                          : "Waiting to save the source video…"}
                    </span>
                    {activeClip?.uploadState === "uploading" && (
                      <span className="shrink-0 text-zinc-500">
                        {activeClip.uploadPct}%
                      </span>
                    )}
                  </span>
                  <span className="mt-2 block h-1 overflow-hidden rounded-full bg-zinc-800">
                    <span
                      className={`block h-full rounded-full bg-violet-500 transition-[width] duration-300 ${
                        activeClip?.uploadState === "processing"
                          ? "animate-pulse"
                          : ""
                      }`}
                      style={{
                        width: `${
                          activeClip?.uploadState === "processing"
                            ? 100
                            : Math.max(activeClip?.uploadPct ?? 0, 4)
                        }%`,
                      }}
                    />
                  </span>
                  <span className="mt-1.5 block text-[11px] text-zinc-500">
                    You can queue the render now; it will start automatically
                    when the video is ready.
                  </span>
                </span>
              ) : !serverProjectReady ? (
                <span className="text-zinc-500">
                  The cloud project record is still being created. Your edits
                  and source remain saved on this device.
                </span>
              ) : (
                <span className="flex items-center justify-between gap-2">
                  <span className="text-zinc-400">
                    Source video is not in cloud storage — attach it to render.
                  </span>
                  <label className="flex shrink-0 cursor-pointer items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800">
                    {attaching ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin" /> Uploading…
                      </>
                    ) : (
                      <>
                        <Upload className="h-3 w-3" /> Attach video
                      </>
                    )}
                    <input
                      type="file"
                      accept="video/*,.mkv,.mov,.mp4,.webm,.m4v"
                      className="hidden"
                      disabled={attaching}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) attachOriginal(f);
                      }}
                    />
                  </label>
                </span>
              )}
            </div>
          )}

          {selected.burn && batch && (
            <p className="mb-4 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 text-xs text-zinc-400">
              Each clip renders from its own source in cloud storage — clips
              without one are skipped.
            </p>
          )}

          {selected.server && !useLocalRender && (
            <div className="mb-4">
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-900 p-1">
                {(
                  [
                    {
                      id: "native",
                      name: "Fast",
                      hint: "Fast server render. Best for built-in styles; minor visual differences are possible.",
                    },
                    {
                      id: "wysiwyg",
                      name: "Pixel-perfect",
                      hint: "Exactly what you saw in the editor, every pixel. Slower — use it when it has to be dead-on.",
                    },
                  ] as const
                ).map((e) => (
                  <button
                    key={e.id}
                    onClick={() => setEngine(e.id)}
                    title={e.hint}
                    className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                      engine === e.id
                        ? "bg-zinc-700/70 text-zinc-50"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {e.name}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-pretty text-center text-[11px] leading-4 text-zinc-500">
                {engine === "native"
                  ? "Fast server render. Best for built-in styles; minor visual differences are possible."
                  : "Exactly what you saw in the editor, every pixel. Slower — use it when it has to be dead-on."}
              </p>
            </div>
          )}

          {selected.server && !selected.burn && !batch && (
            <div className="mb-4 flex items-center gap-4 text-sm">
              <span className="text-zinc-400">
                Resolution{" "}
                <span className="font-mono text-zinc-200">
                  {activeDims.width}×{activeDims.height}
                </span>
              </span>
              <label className="flex items-center gap-2 text-zinc-400">
                FPS
                <FpsSelect className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-200 outline-none" />
              </label>
              <span className="text-zinc-500">
                {activeDims.duration.toFixed(1)}s
              </span>
            </div>
          )}

          {format === "mov" && !batch && activeDims.duration > 60 && (
            <p className="mb-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              ProRes 4444 is a mezzanine codec (~2 MB/s). A{" "}
              {Math.round(activeDims.duration)}s export will be roughly{" "}
              {Math.round(activeDims.duration * 2)} MB. Use WebM if you want a
              small alpha file.
            </p>
          )}

          {error && (
            <p className="mb-3 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}

          {clips.length > 1 && (
            <div
              className={`mb-3 grid ${
                selCount > 0 ? "grid-cols-3" : "grid-cols-2"
              } gap-1 rounded-lg bg-zinc-900 p-1`}
            >
              {(
                [
                  ["one", "This clip"],
                  ...(selCount > 0
                    ? [["selected", `${selCount} selected`] as const]
                    : []),
                  ["all", `All ${clips.length}`],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => setScope(v)}
                  className={`rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors ${
                    scope === v
                      ? "bg-violet-600/20 text-violet-200"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          <button
            onClick={
              selected.burn &&
              !useLocalRender &&
              !batch &&
              !burnReady &&
              sourceRecoverable
                ? prepareAndExport
                : doExport
            }
            disabled={
              busy ||
              (batch
                ? !batchClips.some((c) => clipExportable(c.id))
                : !hasContent({ cues, texts })) ||
              (selected.burn &&
                !useLocalRender &&
                !batch &&
                !burnReady &&
                !sourceRecoverable) ||
              renderWhenReady
            }
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {useLocalRender
                  ? `Rendering on this device · ${Math.round(localProgress * 100)}%`
                  : "Starting export…"}
              </>
            ) : batch ? (
              <>
                Export {batchClips.filter((c) => clipExportable(c.id)).length}{" "}
                clips · {selected.name}
              </>
            ) : selected.burn && !burnReady ? (
              <>{burnBlockerLabel}</>
            ) : useLocalRender ? (
              <>Export {format === "hevc" ? "H.265" : "H.264"} on this device</>
            ) : (
              <>Export {selected.name}</>
            )}
          </button>

          {selected.server && !useLocalRender && (
            <p className="mt-2.5 text-center text-[11px] leading-4 text-zinc-500">
              Renders in the background — keep editing while progress shows in
              the corner. The file downloads automatically and stays available
              for 24 hours, even if you close this tab.
            </p>
          )}
          {useLocalRender && (
            <p className="mt-2.5 text-pretty text-center text-[11px] leading-4 text-zinc-500">
              Renders directly from the original file on this device. Keep this
              tab open until the MP4 is finished; cloud upload progress does not
              affect it.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
