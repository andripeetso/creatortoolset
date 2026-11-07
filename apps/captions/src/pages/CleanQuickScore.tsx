import { CleanReferenceAssessment } from "./CleanReferenceAssessment";
import { Fingerprint, Info, Loader2 } from "lucide-react";
import {
  sameEdit,
  type EditMeasurement,
  type EditOptions,
} from "@contracts/clean-edit";
import { editTimeline, timelineDuration } from "@contracts/clean-timeline";
import { ScoreCard, ScoreHelp } from "./CleanScoreCard";
import { CleanExtendedScoreCards } from "./CleanExtendedScoreCards";
import { useCleanScore } from "@/hooks/use-clean-score";

export function CleanQuickScore({
  sourceId,
  options,
  duration,
  busy,
  measurement,
  measuring,
  onMeasure,
  compact = false,
}: {
  sourceId?: string;
  options: EditOptions;
  duration: number;
  busy: boolean;
  measurement?: EditMeasurement;
  measuring: boolean;
  onMeasure: () => void;
  compact?: boolean;
}) {
  const normalized = {
    ...options,
    stripMetadata: false,
    cleanup: undefined,
    unique: false,
    adjustments: { ...options.adjustments, mute: false, volume: 1 },
  };
  const key = JSON.stringify([sourceId, normalized]);
  const result = useCleanScore(sourceId, key, busy, "score");
  const semantic = useCleanScore(sourceId, key, busy, "sscd");
  const current = result?.key === key;
  const pdq = result?.score?.pdq;
  const tmk = measurement?.fingerprints.tmk;
  const verifiedPdq = measurement?.fingerprints.pdq;
  const currentMeasurement =
    measurement && sameEdit(measurement.options, options);
  let output = 0,
    scenes = 0;
  try {
    const spans = editTimeline(options.adjustments, duration);
    output = timelineDuration(spans);
    scenes = spans.length;
  } catch {
    /* duration is still loading */
  }
  const fullStatus = measuring
    ? measurement && !currentMeasurement
      ? "Previous settings · updating…"
      : "Measuring…"
    : measurement
      ? currentMeasurement
        ? "Current settings · full file"
        : "Previous settings · update needed"
      : "Not measured yet";
  const pdqStatus = !sourceId
    ? "Ready after upload"
    : !current
      ? result?.score
        ? "Previous settings · updating…"
        : "Calculating…"
      : result?.error || pdq?.status === "error"
        ? "Measurement failed"
        : pdq?.status === "unavailable"
          ? "Unavailable"
          : "Current settings · fast estimate";
  const tmkStatus =
    tmk && tmk.status !== "ok"
      ? tmk.status === "unavailable"
        ? "Unavailable"
        : "Measurement failed"
      : fullStatus;
  if (compact) {
    const sscd = semantic?.score?.sscd;
    return (
      <section
        aria-label="Live editor scores"
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-violet-500/25 bg-violet-500/5 p-3"
      >
        <ScoreHelp
          description="Fast PDQ distance: higher means more visual difference, not more originality. Only reliable sampled source-frame pairs contribute."
          className="text-left text-xs"
        >
          <span className="text-zinc-400">PDQ distance</span>
          <strong className="ml-2 tabular-nums text-violet-200">
            {pdq?.status === "ok" && pdq.meanDistance !== null
              ? pdq.meanDistance.toFixed(1)
              : "—"}
          </strong>
          <span className="mt-1 block text-[10px] text-zinc-500">
            {pdqStatus}
          </span>
        </ScoreHelp>
        <ScoreHelp
          description="SSCD visual similarity: higher means more similar. This sample-based result does not evaluate the story or platform originality."
          className="text-left text-xs"
        >
          <span className="text-zinc-400">SSCD similarity</span>
          <strong className="ml-2 tabular-nums text-violet-200">
            {sscd?.status === "ok" ? sscd.meanSimilarity.toFixed(4) : "—"}
          </strong>
          <span className="mt-1 block text-[10px] text-zinc-500">
            {semantic?.key !== key
              ? "Updating…"
              : semantic?.error || sscd?.status !== "ok"
                ? "Unavailable"
                : "Current settings · estimate"}
          </span>
        </ScoreHelp>
        <ScoreHelp
          description="Full-file TMK scores include visual content and timing. Higher means more similar. Measure again after changing your settings."
          className="text-left text-xs"
        >
          <span className="text-zinc-400">TMK L1 / L2</span>
          <strong className="ml-2 tabular-nums text-violet-200">
            {tmk?.status === "ok"
              ? `${tmk.level1.toFixed(4)} / ${tmk.level2.toFixed(4)}`
              : "—"}
          </strong>
          <span
            className={`mt-1 block text-[10px] ${measurement && !currentMeasurement ? "text-amber-300" : "text-zinc-500"}`}
          >
            {tmkStatus}
          </span>
        </ScoreHelp>
        <button
          type="button"
          onClick={onMeasure}
          disabled={!sourceId || busy}
          className="flex items-center gap-1 rounded-lg border border-violet-500/30 px-3 py-2 text-xs text-violet-200 disabled:opacity-40"
        >
          {measuring && <Loader2 className="h-3 w-3 animate-spin" />}
          {measuring ? "Measuring…" : "Measure full scores"}
        </button>
      </section>
    );
  }
  return (
    <section
      aria-label="Fingerprint scores"
      className="mb-4 rounded-2xl border border-violet-500/30 bg-violet-500/5 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Fingerprint className="h-4 w-4 text-violet-400" /> Comparison scores
        </h2>
        <button
          type="button"
          disabled={!sourceId || busy}
          onClick={onMeasure}
          className="flex items-center gap-2 rounded-lg border border-violet-500/30 px-3 py-2 text-xs font-medium text-violet-200 hover:bg-violet-500/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {measuring && <Loader2 className="h-3 w-3 animate-spin" />}
          {measuring ? "Measuring full scores…" : "Measure full scores"}
        </button>
      </div>
      <CleanReferenceAssessment
        scores={{
          ...measurement?.fingerprints,
          pdq: currentMeasurement ? verifiedPdq : pdq,
        }}
        mode={currentMeasurement ? "encoded" : "live"}
        pdqStale={!currentMeasurement && Boolean(result?.score && !current)}
        fullStale={Boolean(measurement && !currentMeasurement)}
      />
      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ScoreCard
          label="PDQ distance"
          value={
            pdq?.status === "ok" && pdq.meanDistance !== null
              ? pdq.meanDistance.toFixed(1)
              : "—"
          }
          scale="0–256 · higher = more different"
          status={pdqStatus}
          stale={Boolean(result?.score && !current)}
          description="Average differing bits between 256-bit fingerprints of matching source frames. 0 means identical hashes; higher means more visual difference. The fast estimate uses up to 4 reduced-size frames before encoding. Maximum is the largest distance among reliable pairs. Full-file PDQ checks sampled frames from the encoded output and can differ from this estimate."
        >
          {pdq?.status === "ok" && pdq.maxDistance !== null && (
            <span className="block">Maximum: {pdq.maxDistance} / 256</span>
          )}
          {verifiedPdq?.status === "ok" && (
            <span className="mt-1 block">
              Encoded:{" "}
              {verifiedPdq.meanDistance === null
                ? "low detail"
                : `${verifiedPdq.meanDistance.toFixed(1)} / 256 · max ${verifiedPdq.maxDistance}`}
              <span
                className={`block ${!currentMeasurement ? "text-amber-300" : ""}`}
              >
                {fullStatus}
              </span>
            </span>
          )}
        </ScoreCard>
        <ScoreCard
          label="TMK temporal · L2"
          value={tmk?.status === "ok" ? tmk.level2.toFixed(6) : "—"}
          scale="0–1 · higher = more similar"
          status={tmkStatus}
          stale={Boolean(measurement && !currentMeasurement)}
          description="TMK+PDQF temporal similarity compares the full videos, including visual content and its timing. 1 is the highest similarity; values closer to 0 mean less similarity. Scene order, trims, speed and visual edits can affect it. Use Measure full scores to calculate it for the current settings."
        />
        <ScoreCard
          label="TMK average · L1"
          value={tmk?.status === "ok" ? tmk.level1.toFixed(6) : "—"}
          scale="−1–1 · higher = more similar"
          status={tmkStatus}
          stale={Boolean(measurement && !currentMeasurement)}
          description="TMK+PDQF average-frame similarity compares the average visual features across each full video, without describing scene timing. Its cosine-similarity scale is −1 to 1, with 1 the highest similarity. Read it alongside L2, which also describes timing. Use Measure full scores to update both scores."
        />
        <ScoreCard
          label="Reliable frame pairs"
          value={
            pdq?.status === "ok"
              ? `${pdq.reliableFrames} / ${pdq.frames.length}`
              : "—"
          }
          scale="PDQ quality ≥50 in both frames"
          status={pdqStatus}
          stale={Boolean(result?.score && !current)}
          description="The first number is how many sampled frame pairs have enough visual detail for a useful PDQ comparison; the second is the number sampled. Both frames must have PDQ quality of at least 50. Only these reliable pairs contribute to the mean and maximum distance. More reliable pairs support the estimate; this is not a similarity percentage. Zero reliable pairs means no mean distance is available."
        >
          {verifiedPdq?.status === "ok" && (
            <span className="mt-1 block">
              Encoded: {verifiedPdq.reliableFrames} /{" "}
              {verifiedPdq.frames.length}
              <span
                className={`block ${!currentMeasurement ? "text-amber-300" : ""}`}
              >
                {fullStatus}
              </span>
            </span>
          )}
        </ScoreCard>
        <CleanExtendedScoreCards
          scores={{
            ...measurement?.fingerprints,
            visual: result?.score?.visual ?? measurement?.fingerprints.visual,
            sscd: semantic?.score?.sscd ?? measurement?.fingerprints.sscd,
          }}
          status={fullStatus}
          stale={Boolean(measurement && !currentMeasurement)}
          visualStatus={result?.score?.visual ? pdqStatus : undefined}
          visualStale={result?.score?.visual ? !current : undefined}
          sscdStatus={
            semantic?.score?.sscd
              ? semantic.key === key
                ? "Current settings · fast estimate"
                : "Previous settings · updating…"
              : measurement?.fingerprints.sscd
                ? fullStatus
                : !sourceId
                  ? "Ready after upload"
                  : semantic?.error
                    ? "Measurement failed"
                    : "Calculating…"
          }
          sscdStale={
            semantic?.score?.sscd
              ? semantic.key !== key
              : Boolean(measurement && !currentMeasurement)
          }
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400">
        <ScoreHelp
          description="The edited video’s total playback time after trims, scene order and speed adjustments, followed by the number of scene ranges. This updates with your settings and does not require full-file measurement."
          className="flex items-center gap-1.5 rounded text-left hover:text-violet-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400"
        >
          Timeline: {output.toFixed(2)}s · {scenes}{" "}
          {scenes === 1 ? "scene" : "scenes"}
          <Info className="h-3 w-3" aria-hidden="true" />
        </ScoreHelp>
        <ScoreHelp
          description="Elapsed server processing time for the latest fast PDQ estimate, and how many source frames were reused from cache. Reusing frames makes feedback faster. These are performance numbers, not similarity scores."
          className="flex items-center gap-1.5 rounded text-left hover:text-violet-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400"
        >
          {!sourceId ? (
            "Ready after upload"
          ) : busy ? (
            "Full operation in progress"
          ) : !current ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" /> Updating PDQ…
            </>
          ) : result?.error ? (
            "Could not score PDQ"
          ) : (
            `PDQ: ${result?.score?.elapsedMs ?? 0} ms · ${result?.score?.cachedFrames ?? 0} cached frames`
          )}
          <Info className="h-3 w-3" aria-hidden="true" />
        </ScoreHelp>
      </div>
      {result?.error && current && (
        <p role="alert" className="mt-2 text-xs text-amber-300">
          {result.error}
        </p>
      )}
      {semantic?.error && semantic.key === key && (
        <p role="alert" className="mt-2 text-xs text-amber-300">
          SSCD: {semantic.error}
        </p>
      )}
      {pdq && pdq.status !== "ok" && (
        <p className="mt-2 text-xs text-amber-300">{pdq.message}</p>
      )}
      {tmk && tmk.status !== "ok" && (
        <p className="mt-2 text-xs text-amber-300">{tmk.message}</p>
      )}
      {pdq?.status === "ok" && !pdq.reliableFrames && (
        <p className="mt-2 text-xs text-amber-300">
          These sampled frames have too little detail for a reliable mean score.
        </p>
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-zinc-400">
        Hover, focus or tap a card to learn what its numbers mean. PDQ, SSCD,
        color and contrast update automatically. Full scores add vPDQ shared
        frames and motion, and verify the encoded output. Temporary renders are
        deleted after analysis.
      </p>
      <details className="mt-2 text-xs text-zinc-400">
        <summary className="cursor-pointer">What affects the scores?</summary>
        <p className="mt-2 leading-relaxed">
          Crop, zoom, framing, rotation, flips, color and encoding can change
          PDQ. Matching source moments are aligned across cuts here; reordering
          unchanged scenes can leave PDQ unchanged. Fast PDQ uses up to 4
          matching source moments reduced to 768px before editing. TMK+PDQF also
          describes the full video’s content and timing, so scene order, trims
          and speed can affect it. Audio, metadata removal and file-hash padding
          do not directly change these visual fingerprints. Captions burned into
          the picture can change them. These values describe this comparison,
          not a platform’s decisions.
        </p>
      </details>
    </section>
  );
}
