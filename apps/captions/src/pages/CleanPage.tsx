import { CleanGuideDialog } from "./CleanGuideDialog";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import {
  Download,
  Fingerprint,
  Loader2,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import type {
  CleanSource,
  UploadedComparison,
} from "@contracts/clean-workspace";
import {
  DEFAULT_EDIT,
  cleanExportOptions,
  cropGeometry,
  sameEdit,
  type EditAudit,
  type EditMeasurement,
  type EditOptions,
} from "@contracts/clean-edit";
import { fmtBytes } from "@/lib/exports";
import { AppBar } from "@/components/AppBar";
import { DropZoneText, dropZoneClass } from "@/components/DropZone";
import {
  cleanMediaUrl,
  compareCleanSources,
  deleteCleanSource,
  loadCleanSource,
  uploadCleanSource,
} from "@/lib/clean-workspace";
import { auditEdit, downloadEdit, measureEdit } from "@/lib/clean-edit";
import { FingerprintResults } from "./FingerprintResults";
import { CleanEditorControls, Toggle } from "./CleanEditorControls";
import { CleanEditorPreview } from "./CleanEditorPreview";
import { MetadataList } from "./CleanMetadataList";
import { CleanQuickScore } from "./CleanQuickScore";
import { CleanDuplicateCheck } from "./CleanDuplicateCheck";
import { CleanClipEditorDialog } from "./CleanClipEditorDialog";
import {
  CleanComparisonTimeline,
  CleanEditMap,
} from "./CleanComparisonTimeline";
import type { CleanPreviewHandle } from "./CleanEditorPreview";
import { editTimeline, timelineDuration } from "@contracts/clean-timeline";
import { CleanUploadedComparison } from "./CleanUploadedComparison";

import { CleanMetadataAudit } from "./CleanMetadataAudit";
import { CleanBatchPanel } from "./CleanBatchPanel";

interface VideoRow {
  key: string;
  name: string;
  file?: File;
  preview?: string;
  previewDuration?: number;
  upload: "queued" | "uploading" | "ready" | "error";
  percent: number;
  source?: CleanSource;
  options: EditOptions;
  measurement?: EditMeasurement;
  audit?: EditAudit;
  uploadedComparison?: UploadedComparison;
  snapshots?: { name: string; options: EditOptions }[];
  operation?:
    | "auditing"
    | "measuring"
    | "comparing"
    | "exporting"
    | "removing"
    | "transferring";
  error?: string;
}
const buttonClass =
  "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Could not finish this operation.";

export default function CleanPage() {
  const [query, setQuery] = useSearchParams();
  const restoreId = useRef(query.get("session"));
  const restoreComparisonId = useRef(query.get("compare"));
  const [compareUploads, setCompareUploads] = useState(
    Boolean(restoreComparisonId.current),
  );
  const [comparisonKey, setComparisonKey] = useState<string>();
  const comparisonInput = useRef<HTMLInputElement>(null);
  const [restoring, setRestoring] = useState(
    Boolean(restoreId.current),
  );
  const [pageError, setPageError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [rows, setRows] = useState<VideoRow[]>([]);
  const [activeKey, setActiveKey] = useState<string>();
  const activeRef = useRef<string>(undefined);
  const latestRows = useRef(rows);
  useEffect(() => {
    latestRows.current = rows;
  }, [rows]);
  const [initialOptions, setInitialOptions] =
    useState<EditOptions>(DEFAULT_EDIT);
  const [batchBusy, setBatchBusy] = useState(false);
  const [autoMeasure, setAutoMeasure] = useState(false);
  const [clearAfterDownload, setClearAfterDownload] = useState(true);
  const [drag, setDrag] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const previewTransport = useRef<CleanPreviewHandle>(null);
  const uploadQueue = useRef(Promise.resolve());
  const controllers = useRef(new Map<string, AbortController>());
  const objectUrls = useRef(new Map<string, string>());
  const removed = useRef(new Set<string>());
  const autoAttempt = useRef("");
  const autoCompare = useRef("");
  const operations = useRef(new Set<string>());
  const measurements = useRef(new Map<string, AbortController>());
  const input = useRef<HTMLInputElement>(null);
  const row = rows.find((item) => item.key === activeKey);
  const source = row?.source;
  const comparison =
    rows.find((item) => item.key === comparisonKey && item.key !== activeKey) ??
    rows.find((item) => item.key !== activeKey);
  const comparisonSourceId = compareUploads
    ? comparison?.source?.id
    : undefined;
  useEffect(() => {
    if (restoring) return;
    const next = new URLSearchParams();
    if (source) next.set("session", source.id);
    if (source && comparisonSourceId) next.set("compare", comparisonSourceId);
    if (query.toString() !== next.toString()) setQuery(next, { replace: true });
  }, [source, comparisonSourceId, restoring, query, setQuery]);
  useEffect(() => {
    if (
      !compareUploads ||
      !row?.source ||
      !comparison?.source ||
      autoCompare.current !== row.key + comparison.key
    )
      return;
    autoCompare.current = "";
    void measureUploads();
    // measureUploads reads this render's row and comparison.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareUploads, row?.source, comparison?.source]);
  const options = cleanExportOptions(
    row?.options ?? initialOptions,
  );
  const measured = row?.measurement;
  const auditResult =
    row?.audit &&
    (!measured?.audit || row.audit.audit.checkedAt > measured.audit.checkedAt)
      ? row.audit
      : measured;
  const currentMeasurement = measured && sameEdit(measured.options, options);
  const duration = source?.duration ?? row?.previewDuration ?? 0;
  const geometry =
    source?.width && source.height
      ? cropGeometry(source.width, source.height, options.adjustments)
      : null;
  const outputDuration = duration
    ? timelineDuration(editTimeline(options.adjustments, duration))
    : 0;
  const patch = (key: string, value: Partial<VideoRow>) =>
    setRows((items) =>
      items.map((item) => (item.key === key ? { ...item, ...value } : item)),
    );

  useEffect(() => {
    const requests = controllers.current,
      urls = objectUrls.current,
      analyses = measurements.current;
    return () => {
      analyses.forEach((controller) => controller.abort());
      requests.forEach((controller) => controller.abort());
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);
  useEffect(() => {
    const id = restoreId.current;
    if (!id) return;
    const controller = new AbortController();
    const secondId = restoreComparisonId.current;
    void Promise.allSettled([
      loadCleanSource(id, controller.signal),
      ...(secondId && secondId !== id
        ? [loadCleanSource(secondId, controller.signal)]
        : []),
    ])
      .then((results) => {
        if (controller.signal.aborted) return;
        if (results[0].status === "rejected") throw results[0].reason;
        const saved = results[0].value;
        const second =
          results[1]?.status === "fulfilled" ? results[1].value : undefined;
        if (results[1]?.status === "rejected")
          setPageError(
            "The second upload is no longer available. Choose or upload another video.",
          );
        setRows(
          [saved, ...(second ? [second] : [])].map((item) => ({
            key: item.id,
            name: item.name,
            source: item,
            upload: "ready",
            percent: 100,
            options: DEFAULT_EDIT,
          })),
        );
        activeRef.current = saved.id;
        setActiveKey(saved.id);
        if (second) setComparisonKey(second.id);
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setPageError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setRestoring(false);
      });
    return () => controller.abort();
  }, []);

  // Changes remain live while a previous measurement runs. Results are tagged
  // with their settings, and a later settled edit gets its own measurement.
  const autoKey = source ? source.id + JSON.stringify(options) : "";
  useEffect(() => {
    if (
      batchBusy ||
      compareUploads ||
      editorOpen ||
      !autoMeasure ||
      !row?.source ||
      row.operation ||
      currentMeasurement ||
      autoAttempt.current === autoKey
    )
      return;
    const target = row;
    const timer = setTimeout(() => {
      autoAttempt.current = autoKey;
      void measure(target);
    }, 1800);
    return () => clearTimeout(timer);
    // The key contains the full immutable options snapshot; rows also carry measurement/operation state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    batchBusy,
    autoKey,
    autoMeasure,
    editorOpen,
    compareUploads,
    row?.operation,
    currentMeasurement,
  ]);

  function selectVideo(item: VideoRow) {
    activeRef.current = item.key;
    setActiveKey(item.key);
  }
  function startUpload(item: VideoRow) {
    uploadQueue.current = uploadQueue.current.then(async () => {
      if (removed.current.has(item.key) || !item.file) return;
      const controller = new AbortController();
      controllers.current.set(item.key, controller);
      patch(item.key, { upload: "uploading", percent: 0, error: undefined });
      try {
        const saved = await uploadCleanSource(
          item.file,
          (percent) => patch(item.key, { percent }),
          controller.signal,
        );
        if (removed.current.has(item.key)) {
          await deleteCleanSource(saved.id);
          return;
        }
        patch(item.key, { source: saved, upload: "ready", percent: 100 });
      } catch (error) {
        if (!removed.current.has(item.key))
          patch(item.key, { upload: "error", error: message(error) });
      } finally {
        controllers.current.delete(item.key);
      }
    });
  }
  function addVideos(files: File[], forComparison = false) {
    if (!files.length) return;
    setPageError(undefined);
    setNotice(undefined);
    const added = files.map((file): VideoRow => {
      const key = crypto.randomUUID(),
        preview = URL.createObjectURL(file);
      objectUrls.current.set(key, preview);
      return {
        key,
        name: file.name,
        file,
        preview,
        upload: "queued",
        percent: 0,
        options: {
          ...options,
          adjustments: {
            ...options.adjustments,
            start: 0,
            end: null,
            cuts: [],
          },
        },
      };
    });
    setRows((items) => [...items, ...added]);
    if (forComparison && row) {
      setComparisonKey(added[0].key);
      setCompareUploads(true);
    } else if (added.length === 2) {
      // Two videos at once: compare them as soon as both are up.
      selectVideo(added[0]);
      setComparisonKey(added[1].key);
      setCompareUploads(true);
      autoCompare.current = added[0].key + added[1].key;
    } else selectVideo(added[0]);
    added.forEach(startUpload);
  }
  async function checkCleanup(target: VideoRow) {
    if (batchBusy || !target.source || operations.current.has(target.key))
      return;
    const controller = new AbortController();
    measurements.current.set(target.key, controller);
    operations.current.add(target.key);
    patch(target.key, { operation: "auditing", error: undefined });
    try {
      const audit = await auditEdit(
        target.source.id,
        target.options,
        controller.signal,
      );
      if (!controller.signal.aborted) patch(target.key, { audit });
    } catch (error) {
      if (!controller.signal.aborted)
        patch(target.key, { error: message(error) });
    } finally {
      measurements.current.delete(target.key);
      operations.current.delete(target.key);
      patch(target.key, { operation: undefined });
    }
  }
  async function clearBatchOriginals(ids: string[]) {
    const deleted: VideoRow[] = [];
    try {
      for (const id of ids) {
        await deleteCleanSource(id);
        const row = latestRows.current.find((r) => r.source?.id === id);
        if (row) deleted.push(row);
      }
      setNotice(
        "ZIP downloaded. The selected originals and temporary server files were deleted.",
      );
    } finally {
      forgetMany(deleted);
    }
  }
  async function measure(target: VideoRow) {
    if (batchBusy || !target.source || operations.current.has(target.key))
      return;
    const controller = new AbortController();
    measurements.current.set(target.key, controller);
    operations.current.add(target.key);
    patch(target.key, { operation: "measuring", error: undefined });
    try {
      const measurement = await measureEdit(
        target.source.id,
        target.options,
        controller.signal,
      );
      if (!controller.signal.aborted) patch(target.key, { measurement });
    } catch (error) {
      if (!controller.signal.aborted)
        patch(target.key, { error: message(error) });
    } finally {
      measurements.current.delete(target.key);
      operations.current.delete(target.key);
      patch(target.key, { operation: undefined });
    }
  }
  async function sendToCaptions(target: VideoRow) {
    if (batchBusy || !target.source || operations.current.has(target.key))
      return;
    operations.current.add(target.key);
    patch(target.key, { operation: "transferring", error: undefined });
    try {
      const response = await fetch(
        `/api/clean/sources/${target.source.id}/to-captions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(target.options),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Could not send to Caption Studio.");
      // Navigation reloads the saved clip; the Cleaner session expires independently.
      window.location.assign(
        `/captions?project=${encodeURIComponent(result.projectId)}&cleanerClip=${encodeURIComponent(result.clipId)}`,
      );
    } catch (error) {
      patch(target.key, { error: message(error) });
    } finally {
      operations.current.delete(target.key);
      patch(target.key, { operation: undefined });
    }
  }
  async function measureUploads() {
    if (!row?.source || !comparison?.source) return;
    const targets = [row, comparison];
    if (batchBusy || targets.some((item) => operations.current.has(item.key)))
      return;
    targets.forEach((item) => {
      operations.current.add(item.key);
      patch(item.key, { operation: "comparing", error: undefined });
    });
    try {
      const result = await compareCleanSources(
        row.source.id,
        comparison.source.id,
      );
      patch(row.key, { uploadedComparison: result });
    } catch (error) {
      patch(row.key, { error: message(error) });
    } finally {
      targets.forEach((item) => {
        operations.current.delete(item.key);
        patch(item.key, { operation: undefined });
      });
    }
  }
  function forgetMany(targets: VideoRow[]) {
    const keys = new Set(targets.map((item) => item.key));
    for (const target of targets) {
      removed.current.add(target.key);
      controllers.current.get(target.key)?.abort();
      const url = objectUrls.current.get(target.key);
      if (url) {
        URL.revokeObjectURL(url);
        objectUrls.current.delete(target.key);
      }
    }
    setRows((items) => items.filter((item) => !keys.has(item.key)));
    if (activeRef.current && keys.has(activeRef.current)) {
      const next = latestRows.current.find((item) => !keys.has(item.key));
      if (next) selectVideo(next);
      else {
        activeRef.current = undefined;
        setActiveKey(undefined);
        setCompareUploads(false);
      }
    }
  }
  const forget = (target: VideoRow) => forgetMany([target]);
  async function deletePair() {
    if (!row || !comparison) return;
    const targets = [row, comparison],
      deleted: VideoRow[] = [];
    if (batchBusy || targets.some((item) => operations.current.has(item.key)))
      return;
    targets.forEach((item) => {
      operations.current.add(item.key);
      patch(item.key, { operation: "removing", error: undefined });
    });
    try {
      for (const target of targets) {
        if (target.source) await deleteCleanSource(target.source.id);
        deleted.push(target);
      }
      setNotice(
        "Both selected uploads and their temporary server files were deleted. Your local files are unchanged.",
      );
    } catch (error) {
      setPageError(message(error));
    } finally {
      forgetMany(deleted);
      targets.forEach((item) => {
        operations.current.delete(item.key);
        patch(item.key, { operation: undefined });
      });
    }
  }
  async function removeVideo(target: VideoRow) {
    if (batchBusy || operations.current.has(target.key)) return;
    operations.current.add(target.key);
    patch(target.key, { operation: "removing", error: undefined });
    try {
      if (target.source) await deleteCleanSource(target.source.id);
      forget(target);
    } catch (error) {
      patch(target.key, { error: message(error) });
    } finally {
      operations.current.delete(target.key);
      patch(target.key, { operation: undefined });
    }
  }
  async function download(target: VideoRow) {
    if (batchBusy || !target.source || operations.current.has(target.key))
      return;
    const clear = clearAfterDownload;
    operations.current.add(target.key);
    patch(target.key, { operation: "exporting", error: undefined });
    try {
      await downloadEdit(target.source.id, target.name, target.options);
      if (clear) {
        await deleteCleanSource(target.source.id);
        forget(target);
      }
      setNotice(
        clear
          ? "Download ready. The original and all temporary files were deleted from the server."
          : "Download ready. Your editing session is still open.",
      );
    } catch (error) {
      patch(target.key, { error: message(error) });
    } finally {
      operations.current.delete(target.key);
      patch(target.key, { operation: undefined });
    }
  }
  const updateOptions = (value: EditOptions) => {
    if (batchBusy) return;
    const next = cleanExportOptions(value);
    if (row) {
      if (!sameEdit(row.options, next)) {
        autoAttempt.current = "";
        measurements.current.get(row.key)?.abort();
      }
      patch(row.key, { options: next });
    } else setInitialOptions(next);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200">
      <AppBar tool="Video Cleaner">
          <button
            type="button"
            disabled={restoring}
            onClick={() => input.current?.click()}
            className={buttonClass + " border border-zinc-700 text-zinc-300"}
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">Add videos</span>
          </button>
          {!compareUploads && (
            <>
              <button
                type="button"
                disabled={batchBusy || !source || Boolean(row?.operation)}
                onClick={() => row && void measure(row)}
                className={
                  buttonClass +
                  " border border-violet-500/30 text-violet-200 hover:bg-violet-500/10"
                }
              >
                {row?.operation === "measuring" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Fingerprint className="h-4 w-4" />
                )}
                {row?.operation === "measuring"
                  ? "Measuring…"
                  : "Measure full scores"}
              </button>
              <button
                type="button"
                disabled={batchBusy || !source || Boolean(row?.operation)}
                onClick={() => row && void download(row)}
                className={
                  buttonClass + " bg-violet-600 text-white hover:bg-violet-500"
                }
              >
                {row?.operation === "exporting" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {row?.operation === "exporting" ? "Exporting…" : "Download"}
              </button>
            </>
          )}
          <CleanGuideDialog />
        <input
          ref={input}
          type="file"
          multiple
          accept="video/*,.mp4,.mov,.m4v,.mkv,.webm"
          className="hidden"
          aria-label="Upload videos"
          onChange={(event) => {
            addVideos([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <input
          ref={comparisonInput}
          type="file"
          accept="video/*,.mp4,.mov,.m4v,.mkv,.webm"
          className="hidden"
          aria-label="Upload second video"
          onChange={(event) => {
            addVideos([...(event.target.files ?? [])], true);
            event.target.value = "";
          }}
        />
      </AppBar>
      <div className="mx-auto max-w-[1600px] p-4 sm:p-7">
        {pageError && (
          <p
            role="alert"
            className="mb-4 rounded-lg border border-amber-700/30 p-3 text-sm text-amber-200"
          >
            {pageError}
          </p>
        )}
        {notice && (
          <p
            role="status"
            className="mb-4 rounded-lg border border-emerald-700/30 p-3 text-sm text-emerald-300"
          >
            {notice}
          </p>
        )}
        {!!rows.length && (
          <nav
            aria-label="Uploaded videos"
            className="mb-5 flex flex-wrap gap-2"
          >
            {rows.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => selectVideo(item)}
                aria-pressed={activeKey === item.key}
                className={`flex max-w-72 items-center gap-2 rounded-xl border px-3 py-2 text-xs ${activeKey === item.key ? "border-violet-500/50 bg-violet-500/10 text-violet-100" : "border-zinc-800 text-zinc-400"}`}
              >
                {(item.operation ||
                  ["queued", "uploading"].includes(item.upload)) && (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                )}
                <span className="truncate">{item.name}</span>
                {item.upload === "uploading" && <span>{item.percent}%</span>}
              </button>
            ))}
          </nav>
        )}
        <CleanBatchPanel
          videos={rows.flatMap((item) =>
            item.source
              ? [
                  {
                    id: item.source.id,
                    name: item.name,
                    options: item.options,
                  },
                ]
              : [],
          )}
          busy={rows.some((item) => Boolean(item.operation))}
          clearAfterDownload={clearAfterDownload}
          onBusyChange={setBatchBusy}
          onDownloaded={clearBatchOriginals}
        />
        {row && (
          <div
            role="group"
            aria-label="Comparison mode"
            className="mb-5 flex flex-wrap gap-2"
          >
            <button
              type="button"
              aria-pressed={!compareUploads}
              onClick={() => setCompareUploads(false)}
              className={
                buttonClass +
                (!compareUploads
                  ? " bg-violet-600 text-white"
                  : " border border-zinc-700 text-zinc-400")
              }
            >
              Live edit
            </button>
            <button
              type="button"
              aria-pressed={compareUploads}
              onClick={() => setCompareUploads(true)}
              className={
                buttonClass +
                (compareUploads
                  ? " bg-violet-600 text-white"
                  : " border border-zinc-700 text-zinc-400")
              }
            >
              Compare uploaded videos
            </button>
          </div>
        )}
        {compareUploads && row ? (
          <CleanUploadedComparison
            original={row}
            comparison={comparison}
            candidates={rows.filter((item) => item.key !== row.key)}
            result={row.uploadedComparison}
            onSelect={setComparisonKey}
            onUpload={() => comparisonInput.current?.click()}
            onMeasure={() => void measureUploads()}
            onDelete={() => void deletePair()}
            onRetry={(key) => {
              const item = rows.find((value) => value.key === key);
              if (item) startUpload(item);
            }}
          />
        ) : (
          <div className="grid items-start gap-5 lg:grid-cols-[290px_minmax(0,1fr)]">
            <fieldset
              disabled={
                batchBusy ||
                row?.operation === "exporting" ||
                row?.operation === "removing"
              }
              className="min-w-0"
            >
              <CleanEditorControls
                options={options}
                duration={duration}
                onChange={updateOptions}
              />
            </fieldset>
            <main className="min-w-0">
              {restoring ? (
                // the drop zone's own size, empty, while the saved upload is read back
                <div aria-busy="true" aria-label="Restoring your upload" className="h-80 rounded-xl bg-zinc-900/40" />
              ) : !row ? (
                <button
                  type="button"
                  onClick={() => input.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDrag(true);
                  }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDrag(false);
                    addVideos([...e.dataTransfer.files]);
                  }}
                  className={dropZoneClass(drag, "min-h-[390px] cursor-pointer")}
                >
                  <DropZoneText
                    title="Drop your videos here"
                    hint="or click to browse · MP4, MOV, M4V, MKV, WebM"
                  />
                  <span className="mt-5 max-w-md text-xs leading-relaxed text-zinc-500">
                    Choose adjustments before or during upload. Presets save
                    settings, never your video.
                  </span>
                </button>
              ) : (
                <>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-medium">
                        {row.name}
                      </h3>
                      <p className="mt-1 text-xs text-zinc-500">
                        {source
                          ? `${fmtBytes(source.bytes)} · ${duration.toFixed(2)}s · original uploaded`
                          : row.upload === "queued"
                            ? "Waiting to upload…"
                            : row.upload === "error"
                              ? "Upload failed"
                              : `Uploading in background · ${row.percent}%`}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={batchBusy || Boolean(row.operation)}
                      onClick={() => void removeVideo(row)}
                      aria-label="Delete server session"
                      className={
                        buttonClass + " text-zinc-400 hover:text-zinc-50"
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                      <span className="hidden sm:inline">Done & delete</span>
                    </button>
                  </div>
                  {row.upload === "uploading" && (
                    <div
                      role="progressbar"
                      aria-label="Video upload"
                      aria-valuenow={row.percent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className="mb-3 h-1 rounded bg-zinc-800"
                    >
                      <div
                        className="h-full rounded bg-violet-500"
                        style={{ width: row.percent + "%" }}
                      />
                    </div>
                  )}
                  {row.error && (
                    <p
                      role="alert"
                      className="mb-4 rounded-lg border border-red-500/20 p-3 text-sm text-red-300"
                    >
                      {row.error}
                      {row.upload === "error" && (
                        <button
                          type="button"
                          onClick={() => startUpload(row)}
                          className="ml-3 underline"
                        >
                          Retry upload
                        </button>
                      )}
                    </p>
                  )}
                  <CleanQuickScore
                    key={row.key + "-scores"}
                    sourceId={source?.id}
                    options={options}
                    duration={duration}
                    busy={editorOpen || batchBusy || Boolean(row.operation)}
                    measurement={measured}
                    measuring={row.operation === "measuring"}
                    onMeasure={() => void measure(row)}
                  />
                  <CleanDuplicateCheck sourceId={source?.id} />
                  {(row.preview || source) && (
                    <CleanEditorPreview
                      key={row.key}
                      url={row.preview || cleanMediaUrl(source!.id)}
                      sourceId={source?.id}
                      options={options}
                      sourceDuration={duration}
                      transportRef={previewTransport}
                      suspended={editorOpen}
                      editAction={
                        <CleanClipEditorDialog
                          url={row.preview || cleanMediaUrl(source!.id)}
                          name={row.name}
                          file={row.file}
                          sourceId={source?.id}
                          options={options}
                          duration={duration}
                          measurement={measured}
                          disabled={batchBusy || Boolean(row.operation)}
                          onOpenChange={setEditorOpen}
                          onApply={(next, measurement) => {
                            updateOptions(next);
                            if (measurement) patch(row.key, { measurement });
                          }}
                        />
                      }
                      busy={editorOpen || batchBusy || Boolean(row.operation)}
                      onDuration={(previewDuration) =>
                        patch(row.key, { previewDuration })
                      }
                    />
                  )}
                  {source && (
                    <CleanMetadataAudit
                      inspection={source.inspection}
                      audit={auditResult?.audit}
                      current={Boolean(
                        auditResult && sameEdit(auditResult.options, options),
                      )}
                      busy={batchBusy || Boolean(row.operation)}
                      checking={row.operation === "auditing"}
                      onCheck={() => void checkCleanup(row)}
                    />
                  )}
                  <CleanEditMap
                    adjustments={options.adjustments}
                    duration={duration}
                    onSeek={(at) => previewTransport.current?.seek(at)}
                  />
                  <CleanComparisonTimeline
                    measurement={measured?.fingerprints.comparison}
                    stale={Boolean(measured && !currentMeasurement)}
                    onSeek={(_original, at) =>
                      previewTransport.current?.seek(at)
                    }
                  />
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs text-zinc-400">
                      {geometry && (
                        <span>
                          {source?.width} × {source?.height} →{" "}
                          <strong className="font-medium text-zinc-200">
                            {geometry.outputWidth} × {geometry.outputHeight}
                          </strong>{" "}
                          ·{" "}
                        </span>
                      )}
                      {!!duration && (
                        <span>{outputDuration.toFixed(2)}s output · </span>
                      )}
                      MP4
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        patch(row.key, {
                          snapshots: [
                            ...(row.snapshots ?? []),
                            {
                              name: `Snapshot ${(row.snapshots?.length ?? 0) + 1}`,
                              options,
                            },
                          ],
                        })
                      }
                      disabled={(row.snapshots?.length ?? 0) >= 20}
                      className={
                        buttonClass +
                        " text-xs text-zinc-400 hover:bg-zinc-900"
                      }
                    >
                      <Save className="h-3.5 w-3.5" /> Save settings snapshot
                    </button>
                  </div>
                  {!!row.snapshots?.length && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-zinc-500">
                        This session · settings only
                      </span>
                      {row.snapshots.map((snapshot, index) => (
                        <button
                          key={index}
                          type="button"
                          onClick={() => updateOptions(snapshot.options)}
                          className="rounded border border-zinc-700 px-2 py-1.5 text-violet-200"
                        >
                          {snapshot.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <section className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-800 p-4">
                    <div>
                      <h2 className="text-sm font-semibold">
                        Continue in Caption Studio
                      </h2>
                      <p className="mt-1 max-w-lg text-xs text-zinc-400">
                        {source?.captionOrigin
                          ? "Add the edited clip to your project with words and overlays remapped to these cuts and speed. The previous clip stays available."
                          : "Save this edit as a Caption Studio project, then transcribe and add captions."}
                      </p>
                    </div>
                    <button
                      className={
                        buttonClass +
                        " bg-violet-600 text-white hover:bg-violet-500"
                      }
                      disabled={
                        batchBusy || !source || Boolean(row.operation)
                      }
                      onClick={() => void sendToCaptions(row)}
                    >
                      {row.operation === "transferring"
                        ? "Sending…"
                        : source?.captionOrigin
                          ? "Return to Caption Studio"
                          : "Send to Caption Studio"}
                    </button>
                  </section>
                  <section className="mt-5 rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">
                    <h2 className="mb-2 text-sm font-semibold">
                      Full-file verification
                    </h2>
                    <p className="mb-4 text-xs leading-relaxed text-zinc-500">
                      Measure the current settings directly. The temporary
                      encoded video is deleted after analysis. No saved version
                      is needed.
                    </p>
                    <Toggle
                      label="Automatically verify the full file after adjustments settle"
                      checked={autoMeasure}
                      onChange={(value) => {
                        autoAttempt.current = "";
                        setAutoMeasure(value);
                      }}
                    />
                    {row.operation === "measuring" && (
                      <p
                        role="status"
                        className="mt-3 flex items-center gap-2 text-xs text-violet-300"
                      >
                        <Loader2 className="h-4 w-4 animate-spin" /> Rendering
                        and comparing the full edit… New adjustments cancel this
                        run.
                      </p>
                    )}
                    {measured ? (
                      <>
                        <p
                          className={`mt-3 rounded-lg p-2 text-xs ${currentMeasurement ? "bg-emerald-500/5 text-emerald-300" : "bg-amber-500/5 text-amber-300"}`}
                        >
                          {currentMeasurement
                            ? "Measured with the current settings"
                            : "Settings changed. These measurements belong to the previous settings."}
                        </p>
                        <div className="mt-3 grid gap-3 sm:grid-cols-3">
                          <Metric
                            label="Metadata entries"
                            value={`${source?.metadata.length ?? 0} → ${measured.metadata.length}`}
                          />
                          <Metric
                            label="File size"
                            value={fmtBytes(measured.bytes)}
                          />
                          <Metric
                            label="Rendered output"
                            value={`${measured.width} × ${measured.height} · ${measured.duration.toFixed(2)}s`}
                          />
                        </div>
                        <FingerprintResults
                          report={measured.fingerprints}
                          stale={!currentMeasurement}
                          settings={measured.options}
                          name={row.name}
                          comparisonLabel={
                            currentMeasurement
                              ? "current edit"
                              : "previous settings"
                          }
                          md5={{
                            before: source?.md5 ?? "",
                            after: measured.md5,
                          }}
                        />
                      </>
                    ) : (
                      <p className="mt-3 text-xs text-zinc-400">
                        Use{" "}
                        <strong className="font-medium text-violet-200">
                          Measure full scores
                        </strong>{" "}
                        above to see MD5, PDQ and TMK+PDQF comparisons.
                      </p>
                    )}
                  </section>
                  {source && (
                    <section className="mt-5 rounded-2xl border border-zinc-800 p-4">
                      <details>
                        <summary className="cursor-pointer text-sm font-medium">
                          Metadata & file hashes · {source.metadata.length}{" "}
                          original entries
                        </summary>
                        <div className="mt-4 grid gap-4 md:grid-cols-2">
                          <div>
                            <h3 className="mb-2 text-xs font-medium">
                              Original · {source.metadata.length} entries
                            </h3>
                            <MetadataList items={source.metadata} />
                            <p className="mt-3 break-all font-mono text-[11px] text-zinc-500">
                              MD5 {source.md5}
                            </p>
                          </div>
                          <div>
                            <h3 className="mb-2 text-xs font-medium">
                              {currentMeasurement
                                ? "Current edit"
                                : measured
                                  ? "Last measured edit"
                                  : "Current edit"}
                            </h3>
                            {measured ? (
                              <>
                                <MetadataList items={measured.metadata} />
                                <p className="mt-3 break-all font-mono text-[11px] text-zinc-500">
                                  MD5 {measured.md5}
                                </p>
                              </>
                            ) : (
                              <p className="text-xs leading-relaxed text-zinc-500">
                                Measure this edit to inspect its actual metadata
                                and MD5.
                              </p>
                            )}
                          </div>
                        </div>
                      </details>
                    </section>
                  )}
                </>
              )}
              <div className="mt-5 rounded-xl border border-zinc-800/70 p-4">
                <Toggle
                  label="Delete server session after download"
                  disabled={
                    batchBusy ||
                    rows.some((item) => item.operation === "exporting")
                  }
                  checked={clearAfterDownload}
                  onChange={setClearAfterDownload}
                />
                <p className="text-[11px] leading-relaxed text-zinc-500">
                  Preview frames, measurement renders and export copies are
                  temporary. Downloading clears the uploaded original by
                  default. You can also use Done & delete; abandoned sessions
                  expire after one hour. Your local file stays unchanged.
                </p>
              </div>
            </main>
          </div>
        )}
      </div>
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 p-3">
      <p className="text-[11px] text-zinc-500">{label}</p>
      <p className="mt-1 text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}
