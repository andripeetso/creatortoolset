import { useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Scissors,
  Trash2,
  ZoomIn,
  ZoomOut,
  UnfoldHorizontal,
} from "lucide-react";
import type { EditOptions } from "@contracts/clean-edit";
import {
  editTimeline,
  sourceMoment,
  timelineDuration,
} from "@contracts/clean-timeline";
import {
  clipRanges,
  moveClip,
  splitClip,
  trimClip,
  withClipRanges,
  type ClipRange,
} from "@/lib/clean-clip-editor";
import { fmtSrtTime } from "@/lib/ass";
const button =
  "inline-flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1.5 text-xs hover:bg-zinc-800 disabled:opacity-30";
export function ClipTimeline({
  options,
  duration,
  currentTime,
  selected,
  onSelect,
  onChange,
  onSeek,
  peaks,
  thumbnails,
}: {
  options: EditOptions;
  duration: number;
  currentTime: number;
  selected: number;
  onSelect: (index: number) => void;
  onChange: (options: EditOptions) => void;
  onSeek: (time: number) => void;
  peaks?: Float32Array;
  thumbnails?: string[];
}) {
  const [zoom, setZoom] = useState(1);
  const [draft, setDraft] = useState<ClipRange[]>();
  const [dropTarget, setDropTarget] = useState<number>();
  const track = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const drag = useRef<
    | {
        from: number;
        edge?: "start" | "end";
        x: number;
        width: number;
        cuts: ClipRange[];
        changed: boolean;
        target?: number;
        next?: ClipRange[];
      }
    | undefined
  >(undefined);
  const baseCuts = clipRanges(options, duration);
  const cuts = draft ?? baseCuts;
  const spans = editTimeline(
    withClipRanges(options, cuts).adjustments,
    duration,
  );
  const total = timelineDuration(spans);
  const active = cuts[Math.min(selected, cuts.length - 1)];
  const update = (next: ClipRange[]) => onChange(withClipRanges(options, next));
  const seek = (x: number) => {
    const rect = track.current!.getBoundingClientRect();
    onSeek(
      Math.max(0, Math.min(total, ((x - rect.left) / rect.width) * total)),
    );
  };
  const wave = peaks?.length
    ? Array.from({ length: 350 }, (_, i) => {
        const at = sourceMoment(
          spans,
          (i / 350) * total,
          options.adjustments.speed,
        );
        return Math.min(
          1,
          (peaks[
            Math.min(
              peaks.length - 1,
              Math.floor((at / duration) * peaks.length),
            )
          ] ?? 0) * options.adjustments.volume,
        );
      })
    : undefined;
  return (
    <section
      aria-label="Clip editing timeline"
      className="rounded-xl border border-zinc-700 bg-zinc-950"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 p-3">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={button}
            disabled={
              cuts.length >= 64 ||
              splitClip(options, duration, currentTime) === options
            }
            onClick={() => {
              const index = spans.findIndex(
                (s) =>
                  currentTime >= s.outputStart && currentTime < s.outputEnd,
              );
              onChange(splitClip(options, duration, currentTime));
              if (index >= 0) onSelect(index + 1);
            }}
          >
            <Scissors className="h-3.5 w-3.5" />
            Split at playhead
          </button>
          <button
            type="button"
            className={button}
            disabled={selected <= 0}
            onClick={() => {
              update(moveClip(cuts, selected, selected - 1));
              onSelect(selected - 1);
            }}
            aria-label="Move selected scene earlier"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={button}
            disabled={selected >= cuts.length - 1}
            onClick={() => {
              update(moveClip(cuts, selected, selected + 1));
              onSelect(selected + 1);
            }}
            aria-label="Move selected scene later"
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={button}
            disabled={cuts.length >= 64}
            onClick={() => {
              update(
                cuts.flatMap((c, i) => (i === selected ? [c, { ...c }] : [c])),
              );
              onSelect(selected + 1);
            }}
            aria-label="Duplicate selected scene"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={button}
            disabled={cuts.length <= 1}
            onClick={() => {
              update(cuts.filter((_, i) => i !== selected));
              onSelect(Math.max(0, selected - 1));
            }}
            aria-label="Delete selected scene"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs tabular-nums text-zinc-400">
            {fmtSrtTime(currentTime, ".").slice(3)} /{" "}
            {fmtSrtTime(total, ".").slice(3)}
          </span>
          <button
            type="button"
            className={button}
            onClick={() => setZoom(Math.max(1, zoom / 2))}
            disabled={zoom <= 1}
            aria-label="Zoom timeline out"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={button}
            onClick={() => setZoom(Math.min(16, zoom * 2))}
            disabled={zoom >= 16}
            aria-label="Zoom timeline in"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={button}
            onClick={() => setZoom(1)}
            aria-label="Fit timeline"
          >
            <UnfoldHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="overflow-x-auto overscroll-x-contain p-3">
        <div
          ref={track}
          className="relative min-w-full select-none touch-none"
          style={{ width: `${zoom * 100}%` }}
          onPointerMove={(e) => {
            if (scrubbing.current) {
              seek(e.clientX);
              return;
            }
            const d = drag.current;
            if (!d) return;
            if (Math.abs(e.clientX - d.x) > 3) d.changed = true;
            if (!d.changed) return;
            if (d.edge) {
              const next = trimClip(
                d.cuts,
                d.from,
                d.edge,
                d.cuts[d.from][d.edge] +
                  ((e.clientX - d.x) / d.width) *
                    timelineDuration(
                      editTimeline(options.adjustments, duration),
                    ) *
                    options.adjustments.speed,
                duration,
              );
              d.next = next;
              setDraft(next);
            } else {
              const rect = track.current!.getBoundingClientRect();
              const at = Math.max(
                0,
                ((e.clientX - rect.left) / rect.width) * total,
              );
              const target = Math.max(
                0,
                spans.findIndex((s) => at < s.outputEnd),
              );
              d.target = at >= total ? spans.length - 1 : target;
              setDropTarget(d.target);
            }
          }}
          onPointerUp={() => {
            scrubbing.current = false;
            const d = drag.current;
            if (d?.changed) {
              if (d.edge && d.next) update(d.next);
              else if (d.target !== undefined) {
                update(moveClip(d.cuts, d.from, d.target));
                onSelect(d.target);
              }
            }
            if (d && !d.changed && !d.edge) onSeek(spans[d.from].outputStart);
            drag.current = undefined;
            setDraft(undefined);
            setDropTarget(undefined);
          }}
          onPointerCancel={() => {
            scrubbing.current = false;
            drag.current = undefined;
            setDraft(undefined);
            setDropTarget(undefined);
          }}
        >
          <div
            role="slider"
            aria-label="Editor playhead"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={Math.min(total, currentTime)}
            tabIndex={0}
            className="relative h-7 cursor-crosshair border-b border-zinc-700"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              scrubbing.current = true;
              track.current!.setPointerCapture(e.pointerId);
              seek(e.clientX);
            }}
            onKeyDown={(e) => {
              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
                e.preventDefault();
                onSeek(
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? total
                      : Math.max(
                          0,
                          Math.min(
                            total,
                            currentTime +
                              (e.key === "ArrowLeft" ? -1 : 1) *
                                (e.shiftKey ? 1 : 1 / 30),
                          ),
                        ),
                );
              }
            }}
          >
            {Array.from({ length: Math.max(2, zoom * 8) }, (_, i) => {
              const t = (total * i) / (zoom * 8);
              return (
                <span
                  key={i}
                  className="absolute bottom-0 border-l border-zinc-600 pb-1 pl-1 font-mono text-[10px] text-zinc-500"
                  style={{ left: `${(i / (zoom * 8)) * 100}%` }}
                >
                  {fmtSrtTime(t, ".").slice(3)}
                </span>
              );
            })}
          </div>
          <div className="relative my-2 h-20">
            {spans.map((s, i) => (
              <div
                key={i}
                className={`absolute inset-y-0 overflow-hidden rounded-md border-2 ${selected === i ? "border-violet-300 bg-violet-900" : "border-violet-900 bg-violet-950"} ${dropTarget === i ? "ring-2 ring-amber-300" : ""}`}
                style={{
                  left: `${(s.outputStart / total) * 100}%`,
                  width: `${((s.outputEnd - s.outputStart) / total) * 100}%`,
                }}
              >
                <button
                  type="button"
                  aria-label={`Select scene ${i + 1}`}
                  aria-pressed={selected === i}
                  className="absolute inset-0 cursor-grab px-3 text-left active:cursor-grabbing"
                  onClick={() => {
                    onSelect(i);
                    onSeek(s.outputStart);
                  }}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    onSelect(i);
                    track.current!.setPointerCapture(e.pointerId);
                    drag.current = {
                      from: i,
                      x: e.clientX,
                      width: track.current!.getBoundingClientRect().width,
                      cuts: baseCuts,
                      changed: false,
                    };
                  }}
                >
                  {!!thumbnails?.length && (
                    <img
                      draggable={false}
                      alt=""
                      src={
                        thumbnails[
                          Math.min(
                            thumbnails.length - 1,
                            Math.floor(
                              (s.start / duration) * thumbnails.length,
                            ),
                          )
                        ]
                      }
                      className="absolute inset-0 h-full w-full object-cover opacity-25"
                    />
                  )}
                  <span className="relative block truncate text-xs font-medium">
                    Scene {i + 1}
                  </span>
                  <span className="relative block truncate text-[10px] text-violet-300">
                    {s.start.toFixed(2)}–{s.end.toFixed(2)}s
                  </span>
                </button>
                {(["start", "end"] as const).map((edge) => (
                  <button
                    type="button"
                    key={edge}
                    aria-label={`Trim scene ${i + 1} ${edge}`}
                    title={`Drag ${edge} edge · arrow keys trim 1/30 second`}
                    className={`absolute inset-y-0 z-10 w-2 cursor-ew-resize bg-white/20 hover:bg-white/60 ${edge === "start" ? "left-0" : "right-0"}`}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                        e.preventDefault();
                        update(
                          trimClip(
                            cuts,
                            i,
                            edge,
                            cuts[i][edge] +
                              (e.key === "ArrowLeft" ? -1 : 1) *
                                (e.shiftKey ? 1 : 1 / 30),
                            duration,
                          ),
                        );
                      }
                    }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      onSelect(i);
                      track.current!.setPointerCapture(e.pointerId);
                      drag.current = {
                        from: i,
                        edge,
                        x: e.clientX,
                        width: track.current!.getBoundingClientRect().width,
                        cuts: baseCuts,
                        changed: false,
                      };
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
          <div
            className={`relative h-9 rounded bg-teal-950/40 ${options.adjustments.mute ? "opacity-25" : ""}`}
          >
            {wave ? (
              <svg
                viewBox="0 0 350 36"
                preserveAspectRatio="none"
                className="h-full w-full"
                aria-label="Audio waveform"
              >
                {wave.map((v, i) => (
                  <line
                    key={i}
                    x1={i}
                    x2={i}
                    y1={18 - v * 17}
                    y2={18 + v * 17}
                    stroke="#5eead4"
                    strokeWidth="0.6"
                  />
                ))}
              </svg>
            ) : (
              <span className="absolute left-3 top-2 text-[10px] text-teal-300/60">
                Audio follows scene cuts
                {options.adjustments.mute ? " · muted" : ""}
              </span>
            )}
          </div>
          <div
            className="pointer-events-none absolute inset-y-0 z-20 w-px bg-white"
            style={{ left: `${Math.min(1, currentTime / total) * 100}%` }}
          >
            <span className="absolute -left-1 -top-1 h-2 w-2 rotate-45 bg-white" />
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 p-3 text-xs">
        <span className="text-violet-300">
          Scene {Math.min(selected + 1, cuts.length)}
        </span>
        {(["start", "end"] as const).map((edge) => (
          <label key={edge} className="flex items-center gap-2 text-zinc-400">
            Source {edge}
            <input
              type="number"
              aria-label={`Selected scene ${edge}`}
              min={edge === "start" ? 0 : active.start + 0.1}
              max={edge === "end" ? duration : active.end - 0.1}
              step={0.01}
              value={Number(active[edge].toFixed(3))}
              onChange={(e) =>
                update(
                  trimClip(
                    cuts,
                    Math.min(selected, cuts.length - 1),
                    edge,
                    e.target.valueAsNumber,
                    duration,
                  ),
                )
              }
              className="w-24 rounded border border-zinc-700 bg-zinc-900 p-1.5"
            />
          </label>
        ))}
        <span className="text-[11px] text-zinc-500">
          Drag clips to reorder · drag edges to trim · S splits · ⌘/Ctrl Z
          undoes
        </span>
      </div>
    </section>
  );
}
