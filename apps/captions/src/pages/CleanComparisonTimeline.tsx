import { comparisonText } from "@/lib/clean-comparison-report";
import { useState } from "react";
import { Download, Info } from "lucide-react";
import type {
  ComparisonSample,
  ComparisonTimeline,
  MatchState,
} from "@contracts/clean-comparison";
import type { Measurement } from "@contracts/clean-fingerprints";
import type { VideoAdjustments } from "@contracts/clean-edit";
import { editTimeline } from "@contracts/clean-timeline";
import { saveCleanBlob } from "@/lib/clean-edit";

const colors: Record<MatchState, string> = {
  matched: "bg-violet-500",
  ambiguous: "bg-amber-500",
  unmatched: "bg-sky-600",
  "low-detail": "bg-zinc-600",
};
const labels: Record<MatchState, string> = {
  matched: "Shared sample",
  ambiguous: "Multiple possible locations",
  unmatched: "No sampled match",
  "low-detail": "Insufficient detail",
};
const time = (n: number) => `${n.toFixed(2)}s`;
export function CleanComparisonTimeline({
  measurement,
  stale = false,
  onSeek,
}: {
  measurement?: Measurement<ComparisonTimeline>;
  stale?: boolean;
  onSeek?: (original: number, comparison: number) => void;
}) {
  const [selection, setSelection] = useState<{ side: number; index: number }>();
  const data = measurement?.status === "ok" ? measurement : undefined;
  const selected =
    selection &&
    (selection.side ? data?.samples : data?.originalSamples)?.[selection.index];
  function select(sample: ComparisonSample, side: number, index: number) {
    setSelection({ side, index });
    if (!stale && sample.sourceStart !== null)
      onSeek?.(
        side ? sample.sourceStart : sample.start,
        side ? sample.start : sample.sourceStart,
      );
  }
  return (
    <section
      aria-label="Content comparison timeline"
      className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-950/50 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Comparison timeline</h3>
        {data && (
          <button
            type="button"
            onClick={() =>
              saveCleanBlob(
                new Blob(
                  [
                    comparisonText(data) +
                      (stale
                        ? "\n\nWARNING: measured previous edit settings."
                        : ""),
                  ],
                  { type: "text/markdown" },
                ),
                "video-comparison.md",
              )
            }
            className="flex items-center gap-1 text-xs text-violet-300"
          >
            <Download className="h-3 w-3" /> Change report
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-zinc-400">
        Find shared footage across different timestamps, trims and scene order.
      </p>
      {stale && (
        <p role="status" className="mt-2 text-xs text-amber-300">
          Previous settings · measure again to update this map.
        </p>
      )}
      {!data ? (
        <p className="mt-3 text-xs text-zinc-500">
          {measurement && measurement.status !== "ok"
            ? measurement.message
            : "Measure full scores to map the shared samples. No extra video version is saved."}
        </p>
      ) : (
        <>
          <div className="mt-4 space-y-4">
            {[
              {
                name: "Original",
                samples: data.originalSamples,
                duration: data.beforeDuration,
              },
              {
                name: "Comparison",
                samples: data.samples,
                duration: data.afterDuration,
              },
            ].map((track, side) => (
              <div key={track.name}>
                <div className="mb-1 flex justify-between text-[11px] text-zinc-400">
                  <span>{track.name}</span>
                  <span>0 – {time(track.duration)}</span>
                </div>
                <div
                  className="relative h-10 rounded-lg bg-zinc-900"
                  aria-label={`${track.name} shared footage`}
                >
                  {track.samples.map((s, index) => (
                    <button
                      type="button"
                      key={index}
                      aria-label={`${track.name} ${time(s.start)}: ${labels[s.state]}`}
                      aria-pressed={
                        selection?.side === side && selection.index === index
                      }
                      title={`${time(s.start)}–${time(s.end)} · ${labels[s.state]}${s.sourceStart !== null ? ` · counterpart ${time(s.sourceStart)}` : ""}`}
                      onClick={() => select(s, side, index)}
                      className={`absolute inset-y-0 border-r border-zinc-950/70 ${colors[s.state]} hover:brightness-125 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white ${selection?.side === side && selection.index === index ? "z-10 outline outline-2 outline-white" : ""}`}
                      style={{
                        left: `${(s.start / track.duration) * 100}%`,
                        width: `${((s.end - s.start) / track.duration) * 100}%`,
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-[10px] text-zinc-400">
            {Object.entries(labels).map(([state, label]) => (
              <span key={state} className="flex items-center gap-1">
                <i
                  className={`h-2 w-2 rounded ${colors[state as MatchState]}`}
                />
                {label}
              </span>
            ))}
          </div>
          <div className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
            <div>
              <span className="text-zinc-500">
                Comparison samples with a match
              </span>
              <p className="mt-1 tabular-nums">
                {data.samples.filter((s) => s.sourceStart !== null).length} /{" "}
                {data.samples.length}{" "}
                <span className="text-zinc-500">including ambiguous</span>
              </p>
            </div>
            <div>
              <span className="text-zinc-500">Longest sampled sequence</span>
              <p className="mt-1">
                {data.longestRun
                  ? `≈ ${time(data.longestRun.seconds)}`
                  : "Not established"}
              </p>
            </div>
            <div>
              <span className="text-zinc-500">
                Sampling interval · original / comparison
              </span>
              <p className="mt-1">
                {time(data.beforeInterval)} / {time(data.afterInterval)}
              </p>
            </div>
          </div>
          {selected && (
            <p
              role="status"
              className="mt-3 rounded-lg bg-zinc-900 p-3 text-xs text-zinc-300"
            >
              {labels[selected.state]} · {time(selected.start)}–
              {time(selected.end)}
              {selected.sourceStart !== null
                ? ` → counterpart near ${time(selected.sourceStart)}`
                : ""}
              {selected.distance !== null
                ? ` · PDQ distance ${selected.distance}`
                : ""}
              {selected.state === "ambiguous"
                ? ". Repeated or static imagery prevents a unique location."
                : ""}
            </p>
          )}
          <p className="mt-3 flex gap-1.5 text-[11px] leading-relaxed text-zinc-500">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            Sampling can miss short shots or speed-shifted frames. No sampled
            match does not prove new footage. Audio is not fingerprinted. This
            is not a platform pass prediction.
          </p>
        </>
      )}
    </section>
  );
}

/** Exact edit provenance is distinct from inferred visual similarity. */
export function CleanEditMap({
  adjustments,
  duration,
  onSeek,
}: {
  adjustments: VideoAdjustments;
  duration: number;
  onSeek?: (time: number) => void;
}) {
  if (duration < 0.1) return null;
  const spans = editTimeline(adjustments, duration);
  const total = spans.at(-1)!.outputEnd;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let used = 0,
    end = 0;
  for (const span of sorted) {
    used += Math.max(0, span.end - Math.max(end, span.start));
    end = Math.max(end, span.end);
  }
  return (
    <section
      aria-label="Edit source map"
      className="mt-3 rounded-xl border border-zinc-800 p-3"
    >
      <div className="flex flex-wrap justify-between gap-2 text-xs">
        <h3 className="font-medium">Edit source map</h3>
        <span className="text-zinc-400">
          {spans.length} scenes · {time(duration - used)} removed ·{" "}
          {Math.round(adjustments.speed * 100)}% speed
        </span>
      </div>
      <div className="mt-3 flex h-11 gap-px overflow-hidden rounded-md bg-zinc-950">
        {spans.map((s, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onSeek?.(s.outputStart)}
            title={`Scene ${i + 1}: source ${time(s.start)}–${time(s.end)} → edit ${time(s.outputStart)}–${time(s.outputEnd)}`}
            aria-label={`Seek to scene ${i + 1}, source ${time(s.start)} to ${time(s.end)}`}
            className={`min-w-0 overflow-hidden px-1 text-[10px] text-white hover:brightness-125 ${i % 2 ? "bg-indigo-800" : "bg-violet-800"}`}
            style={{
              width: `${((s.outputEnd - s.outputStart) / total) * 100}%`,
            }}
          >
            <span className="block truncate">Scene {i + 1}</span>
            <span className="block truncate opacity-60">
              {time(s.start)} → {time(s.end)}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-zinc-500">
        Known source ranges from your edit, even after reordering or speed
        changes. This map describes reuse, not visual similarity. Audio follows
        these cuts{adjustments.mute ? " and is muted" : ""}.
      </p>
    </section>
  );
}
