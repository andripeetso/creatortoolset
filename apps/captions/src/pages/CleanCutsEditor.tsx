import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Scissors, Trash2 } from "lucide-react";
import type { EditOptions } from "@contracts/clean-edit";
import { draftFetch } from "@/lib/clean-edit";

type Cut = { start: number; end: number };
export function CleanCutsEditor({
  sourceId,
  options,
  duration,
  busy,
  onChange,
}: {
  sourceId?: string;
  options: EditOptions;
  duration: number;
  busy: boolean;
  onChange: (options: EditOptions) => void;
}) {
  const a = options.adjustments;
  const cuts = a.cuts.length
    ? a.cuts
    : [{ start: a.start, end: a.end ?? duration }];
  const [threshold, setThreshold] = useState(0.3);
  const [detection, setDetection] = useState<{
    cuts: Cut[];
    truncated: boolean;
  }>();
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), [sourceId]);
  const update = (next: Cut[]) =>
    onChange({
      ...options,
      adjustments: { ...a, start: 0, end: null, cuts: next },
    });
  async function detect() {
    if (!sourceId) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setDetecting(true);
    setError("");
    try {
      const result = await draftFetch<{ cuts: Cut[]; truncated: boolean }>(
        sourceId,
        "cuts",
        { threshold },
        request.signal,
        (r) => r.json(),
      );
      if (!request.signal.aborted) setDetection(result);
    } catch (e) {
      if (!request.signal.aborted)
        setError(e instanceof Error ? e.message : "Detection failed.");
    } finally {
      if (!request.signal.aborted) setDetecting(false);
    }
  }
  const button =
    "rounded border border-zinc-700 px-2 py-1.5 text-xs hover:bg-zinc-800 disabled:opacity-30";
  return (
    <details className="mt-4 rounded-2xl border border-zinc-800 p-4">
      <summary className="cursor-pointer text-sm font-semibold text-zinc-200">
        Editor
      </summary>
      <div className="pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Scissors className="h-4 w-4 text-violet-400" /> Cuts & scene order
          </h2>
          <button className={button} onClick={() => update([])}>
            Reset to full video
          </button>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-zinc-400">
          Trim source ranges, split scenes and move them into a new order.
          Playback, download and Caption Studio use this same timeline.
        </p>
        <div className="my-3 flex flex-wrap items-center gap-3">
          <button
            className={button}
            disabled={!sourceId || busy || detecting}
            onClick={() => void detect()}
          >
            {detecting ? "Detecting cuts…" : "Detect scene cuts"}
          </button>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            Scene threshold{" "}
            <input
              aria-label="Scene detection threshold"
              type="number"
              step="0.05"
              min="0.05"
              max="0.8"
              value={threshold}
              onChange={(e) =>
                setThreshold(
                  Math.max(0.05, Math.min(0.8, Number(e.target.value))),
                )
              }
              className="w-16 rounded border border-zinc-700 bg-zinc-950 p-1.5"
            />
          </label>
          <span className="text-[11px] text-zinc-500">
            Lower finds smaller changes
          </span>
        </div>
        {detection && (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-violet-200">
            <span>
              {detection.cuts.length} scenes found
              {detection.truncated ? " · limited to 64 scenes" : ""}
            </span>
            <button
              className={button}
              onClick={() => {
                update(detection.cuts);
                setDetection(undefined);
              }}
            >
              Use detected scenes
            </button>
            <button className={button} onClick={() => setDetection(undefined)}>
              Dismiss
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="mb-3 text-xs text-amber-300">
            {error}
          </p>
        )}
        <div className="space-y-2">
          {cuts.map((cut, index) => (
            <div
              key={index}
              className="flex flex-wrap items-center gap-2 rounded-lg bg-zinc-900/70 p-2"
            >
              <span className="w-14 text-xs text-zinc-400">
                Scene {index + 1}
              </span>
              {(["start", "end"] as const).map((edge) => (
                <label
                  key={edge}
                  className="flex items-center gap-1 text-[11px] text-zinc-500"
                >
                  {edge}
                  <input
                    aria-label={`Scene ${index + 1} ${edge}`}
                    type="number"
                    min={edge === "start" ? 0 : cut.start + 0.1}
                    max={edge === "end" ? duration : cut.end - 0.1}
                    step="0.05"
                    value={Number(cut[edge].toFixed(3))}
                    onChange={(e) => {
                      const next = [...cuts];
                      next[index] = {
                        ...cut,
                        [edge]:
                          edge === "start"
                            ? Math.max(
                                0,
                                Math.min(Number(e.target.value), cut.end - 0.1),
                              )
                            : Math.min(
                                duration,
                                Math.max(
                                  Number(e.target.value),
                                  cut.start + 0.1,
                                ),
                              ),
                      };
                      update(next);
                    }}
                    className="w-20 rounded border border-zinc-700 bg-zinc-950 p-1.5 text-zinc-200"
                  />
                </label>
              ))}
              <span className="mr-auto text-[11px] tabular-nums text-zinc-500">
                {((cut.end - cut.start) / a.speed).toFixed(2)}s
              </span>
              <button
                aria-label={`Move scene ${index + 1} earlier`}
                className={button}
                disabled={!index}
                onClick={() => {
                  const next = [...cuts];
                  [next[index - 1], next[index]] = [
                    next[index],
                    next[index - 1],
                  ];
                  update(next);
                }}
              >
                <ArrowUp className="h-3 w-3" />
              </button>
              <button
                aria-label={`Move scene ${index + 1} later`}
                className={button}
                disabled={index === cuts.length - 1}
                onClick={() => {
                  const next = [...cuts];
                  [next[index + 1], next[index]] = [
                    next[index],
                    next[index + 1],
                  ];
                  update(next);
                }}
              >
                <ArrowDown className="h-3 w-3" />
              </button>
              <button
                className={button}
                disabled={cut.end - cut.start < 0.2 || cuts.length >= 64}
                onClick={() => {
                  const mid = (cut.start + cut.end) / 2;
                  update(
                    cuts.flatMap((c, i) =>
                      i === index
                        ? [
                            { start: c.start, end: mid },
                            { start: mid, end: c.end },
                          ]
                        : [c],
                    ),
                  );
                }}
              >
                Split
              </button>
              <button
                aria-label={`Remove scene ${index + 1}`}
                className={button}
                disabled={cuts.length === 1}
                onClick={() => update(cuts.filter((_, i) => i !== index))}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}
