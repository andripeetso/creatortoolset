import { useEffect, useReducer, useRef, useState } from "react";
import {
  Check,
  Loader2,
  Redo2,
  Undo2,
  X,
  AudioLines,
  Scissors,
} from "lucide-react";
import {
  sameEdit,
  type EditMeasurement,
  type EditOptions,
} from "@contracts/clean-edit";
import { editTimeline, timelineDuration } from "@contracts/clean-timeline";
import { ClipTimeline } from "@/components/ClipTimeline";
import {
  editHistory,
  splitClip,
  trimClip,
  withClipRanges,
  clipRanges,
} from "@/lib/clean-clip-editor";
import { useClipThumbnails } from "@/hooks/use-clip-thumbnails";
import { extractAudio } from "@/lib/audio";
import { draftFetch, measureEdit } from "@/lib/clean-edit";
import {
  CleanEditorPreview,
  type CleanPreviewHandle,
} from "./CleanEditorPreview";
import { CleanEditorControls } from "./CleanEditorControls";
import { CleanQuickScore } from "./CleanQuickScore";
import {
  CleanComparisonTimeline,
  CleanEditMap,
} from "./CleanComparisonTimeline";
const button =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs hover:bg-zinc-800 disabled:opacity-40";
export default function CleanClipEditor({
  url,
  name,
  sourceId,
  file,
  options: initial,
  duration,
  measurement: initialMeasurement,
  onApply,
  onCancel,
}: {
  url: string;
  name: string;
  sourceId?: string;
  file?: File;
  options: EditOptions;
  duration: number;
  measurement?: EditMeasurement;
  onApply: (options: EditOptions, measurement?: EditMeasurement) => void;
  onCancel: () => void;
}) {
  const thumbnails = useClipThumbnails(url, duration);
  const [history, dispatch] = useReducer(editHistory, {
    past: [],
    present: initial,
    future: [],
  });
  const options = history.present;
  const [time, setTime] = useState(0),
    [selected, setSelected] = useState(0);
  const [tab, setTab] = useState<"edit" | "compare">("edit");
  const [measurement, setMeasurement] = useState(initialMeasurement);
  const [operation, setOperation] = useState<"measuring" | "cuts">();
  const [error, setError] = useState("");
  const [peaks, setPeaks] = useState<Float32Array>();
  const [waveState, setWaveState] = useState("");
  const [threshold, setThreshold] = useState(0.3);
  const [detected, setDetected] = useState<{
    cuts: { start: number; end: number }[];
    truncated: boolean;
  }>();
  const request = useRef<AbortController | undefined>(undefined);
  const audioRequest = useRef<AbortController | undefined>(undefined);
  const player = useRef<CleanPreviewHandle>(null);
  const gesture = useRef<string | undefined>(undefined);
  const gestureId = useRef(0);
  const settingsRef = useRef(options);
  settingsRef.current = options;
  const spans = editTimeline(options.adjustments, duration);
  const total = timelineDuration(spans);
  const selection = Math.min(selected, spans.length - 1);
  const update = (next: EditOptions) => {
    if (sameEdit(next, settingsRef.current)) return;
    request.current?.abort();
    setOperation(undefined);
    dispatch({ type: "set", options: next, group: gesture.current });
  };
  useEffect(
    () => () => {
      request.current?.abort();
      audioRequest.current?.abort();
    },
    [],
  );
  async function measure() {
    if (!sourceId) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setOperation("measuring");
    setError("");
    try {
      const result = await measureEdit(sourceId, options, controller.signal);
      if (!controller.signal.aborted) setMeasurement(result);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "Measurement failed.");
    } finally {
      if (!controller.signal.aborted) setOperation(undefined);
    }
  }
  async function detect() {
    if (!sourceId) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setOperation("cuts");
    setError("");
    try {
      const result = await draftFetch<{
        cuts: { start: number; end: number }[];
        truncated: boolean;
      }>(sourceId, "cuts", { threshold }, controller.signal, (r) => r.json());
      if (!controller.signal.aborted) setDetected(result);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "Scene detection failed.");
    } finally {
      if (!controller.signal.aborted) setOperation(undefined);
    }
  }
  async function waveform() {
    audioRequest.current?.abort();
    const controller = new AbortController();
    audioRequest.current = controller;
    setWaveState("Loading audio…");
    try {
      let input = file;
      if (!input) {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error("Could not load source audio.");
        input = new File([await response.blob()], name);
      }
      const audio = await extractAudio(
        input,
        (p) => {
          if (!controller.signal.aborted)
            setWaveState(`Audio ${Math.round(p * 100)}%`);
        },
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setPeaks(audio.peaks);
        setWaveState("");
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setWaveState("");
        setError(e instanceof Error ? e.message : "Audio preview unavailable.");
      }
    }
  }
  function historyStep(type: "undo" | "redo") {
    request.current?.abort();
    setOperation(undefined);
    dispatch({ type });
  }
  function shortcut(e: React.KeyboardEvent) {
    const element = e.target as HTMLElement;
    if (element.closest("input, textarea, select, [contenteditable=true]"))
      return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      historyStep(e.shiftKey ? "redo" : "undo");
    } else if (!e.metaKey && !e.ctrlKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      update(splitClip(options, duration, time));
    } else if (e.key === " " && !element.closest("button")) {
      e.preventDefault();
      player.current?.toggle();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (element.closest("button, [role=slider]")) return;
      e.preventDefault();
      player.current?.seek(
        Math.max(
          0,
          Math.min(
            total,
            time + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 1 / 30),
          ),
        ),
      );
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (spans.length > 1) {
        e.preventDefault();
        update(
          withClipRanges(
            options,
            clipRanges(options, duration).filter((_, i) => i !== selection),
          ),
        );
        setSelected(Math.max(0, selection - 1));
      }
    }
  }
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={shortcut}
      onPointerDownCapture={(e) => {
        if ((e.target as HTMLElement).matches("input[type=range]"))
          gesture.current = String(++gestureId.current);
      }}
      onPointerUpCapture={() => {
        gesture.current = undefined;
      }}
      onPointerCancelCapture={() => {
        gesture.current = undefined;
      }}
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div className="min-w-0">
          <h2 className="max-w-md truncate text-sm font-semibold">{name}</h2>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            Clip editor · changes apply when you’re ready
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className={button}
            disabled={!history.past.length}
            onClick={() => historyStep("undo")}
            aria-label="Undo edit"
          >
            <Undo2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={button}
            disabled={!history.future.length}
            onClick={() => historyStep("redo")}
            aria-label="Redo edit"
          >
            <Redo2 className="h-4 w-4" />
          </button>
          <button type="button" className={button} onClick={onCancel}>
            <X className="h-3.5 w-3.5" />
            Cancel
          </button>
          <button
            type="button"
            className={
              button +
              " border-violet-500 bg-violet-600 text-white hover:bg-violet-500"
            }
            onClick={() =>
              onApply(
                options,
                measurement && sameEdit(measurement.options, options)
                  ? measurement
                  : undefined,
              )
            }
          >
            <Check className="h-3.5 w-3.5" />
            Apply changes
          </button>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[260px_minmax(0,1fr)] lg:overflow-hidden">
        <aside className="order-last border-r border-zinc-800 p-3 lg:order-first lg:overflow-y-auto">
          <CleanEditorControls
            options={options}
            duration={duration}
            onChange={update}
          />
        </aside>
        <div className="min-w-0 space-y-3 p-3 lg:overflow-y-auto">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-1" role="group" aria-label="Editor view">
              {(["edit", "compare"] as const).map((value) => (
                <button
                  type="button"
                  aria-pressed={tab === value}
                  key={value}
                  onClick={() => setTab(value)}
                  className={
                    button +
                    (tab === value
                      ? " border-violet-500 bg-violet-500/10 text-violet-200"
                      : " text-zinc-400")
                  }
                >
                  {value === "edit" ? "Edit" : "Compare & measure"}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!sourceId || Boolean(operation)}
                onClick={() => void detect()}
                className={button}
              >
                {operation === "cuts" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Scissors className="h-3 w-3" />
                )}
                Detect scenes
              </button>
              <label className="flex items-center gap-1 text-[11px] text-zinc-400">
                Sensitivity
                <input
                  aria-label="Scene detection threshold"
                  title="Lower thresholds find smaller visual changes"
                  type="number"
                  min={0.05}
                  max={0.8}
                  step={0.05}
                  value={threshold}
                  onChange={(e) => {
                    if (Number.isFinite(e.target.valueAsNumber))
                      setThreshold(
                        Math.max(0.05, Math.min(0.8, e.target.valueAsNumber)),
                      );
                  }}
                  className="w-16 rounded border border-zinc-700 bg-zinc-900 p-1"
                />
              </label>
              <button
                type="button"
                disabled={Boolean(waveState) || Boolean(peaks)}
                onClick={() => void waveform()}
                className={button}
              >
                <AudioLines className="h-3 w-3" />
                {waveState || (peaks ? "Waveform loaded" : "Load waveform")}
              </button>
            </div>
          </div>
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-amber-500/30 p-3 text-xs text-amber-300"
            >
              {error}
            </p>
          )}
          {detected && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-violet-500/10 p-3 text-xs text-violet-200">
              <span>
                {detected.cuts.length} scenes found
                {detected.truncated ? " · limited to 64" : ""}. Applying
                replaces the current scene order.
              </span>
              <button
                type="button"
                className={button}
                onClick={() => {
                  update(withClipRanges(options, detected.cuts));
                  setSelected(0);
                  setDetected(undefined);
                }}
              >
                Use detected scenes
              </button>
              <button
                type="button"
                className={button}
                onClick={() => setDetected(undefined)}
              >
                Dismiss
              </button>
            </div>
          )}
          <CleanQuickScore
            compact={tab === "edit"}
            sourceId={sourceId}
            options={options}
            duration={duration}
            busy={Boolean(operation)}
            measurement={measurement}
            measuring={operation === "measuring"}
            onMeasure={() => void measure()}
          />
          <CleanEditorPreview
            url={url}
            sourceId={sourceId}
            options={options}
            sourceDuration={duration}
            busy={Boolean(operation)}
            onDuration={() => undefined}
            transportRef={player}
            onTimeChange={setTime}
          />
          <ClipTimeline
            options={options}
            duration={duration}
            currentTime={time}
            selected={selection}
            onSelect={setSelected}
            onChange={update}
            onSeek={(t) => player.current?.seek(t)}
            peaks={peaks}
            thumbnails={thumbnails}
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              className={button}
              onClick={() => {
                const at = spans.find(
                  (s) => time >= s.outputStart && time < s.outputEnd,
                );
                if (at && at === spans[selection])
                  update(
                    withClipRanges(
                      options,
                      trimClip(
                        clipRanges(options, duration),
                        selection,
                        "start",
                        at.start +
                          (time - at.outputStart) * options.adjustments.speed,
                        duration,
                      ),
                    ),
                  );
              }}
            >
              Set scene in at playhead
            </button>
            <button
              type="button"
              className={button}
              onClick={() => {
                const at = spans.find(
                  (s) => time >= s.outputStart && time <= s.outputEnd,
                );
                if (at && at === spans[selection])
                  update(
                    withClipRanges(
                      options,
                      trimClip(
                        clipRanges(options, duration),
                        selection,
                        "end",
                        at.start +
                          (time - at.outputStart) * options.adjustments.speed,
                        duration,
                      ),
                    ),
                  );
              }}
            >
              Set scene out at playhead
            </button>
            <span className="text-[11px] text-zinc-500">
              Playback follows the edited order. No video copies are saved while
              editing.
            </span>
          </div>
          <CleanEditMap
            adjustments={options.adjustments}
            duration={duration}
            onSeek={(t) => player.current?.seek(t)}
          />
          {tab === "compare" && (
            <>
              <CleanComparisonTimeline
                measurement={measurement?.fingerprints.comparison}
                stale={Boolean(
                  measurement && !sameEdit(measurement.options, options),
                )}
                onSeek={(_source, at) => player.current?.seek(at)}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
