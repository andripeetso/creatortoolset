import type {
  ExtendedScores,
  Measurement,
} from "@contracts/clean-fingerprints";
import { ScoreCard } from "./CleanScoreCard";

export function CleanExtendedScoreCards({
  scores,
  status,
  stale,
  visualStatus,
  visualStale,
  sscdStatus,
  sscdStale,
}: {
  scores: ExtendedScores;
  status: string;
  stale: boolean;
  visualStatus?: string;
  visualStale?: boolean;
  sscdStatus?: string;
  sscdStale?: boolean;
}) {
  const { visual, sscd, vpdq, motion } = scores;
  const state = (metric: Measurement<object> | undefined, normal = status) =>
    metric && metric.status !== "ok"
      ? metric.status === "unavailable"
        ? "Unavailable"
        : "Measurement failed"
      : normal;
  const value = (n: number | null | undefined, digits = 2) =>
    n == null ? "—" : n.toFixed(digits);
  const error = (metric: Measurement<object> | undefined) =>
    metric && metric.status !== "ok" ? (
      <span className="block text-amber-300">{metric.message}</span>
    ) : null;
  const v = visual?.status === "ok" ? visual : undefined;
  const delta = v ? v.contrastAfter - v.contrastBefore : undefined;
  return (
    <>
      <ScoreCard
        label="SSCD similarity"
        value={sscd?.status === "ok" ? value(sscd.meanSimilarity, 4) : "—"}
        scale="−1–1 · higher = more similar"
        status={state(sscd, sscdStatus ?? status)}
        stale={sscdStale ?? stale}
        description="Mean cosine similarity of Meta’s public SSCD image descriptors at matched source moments. Up to 4 pairs update automatically; full measurement uses up to 8 encoded pairs. The minimum is the least similar sampled pair. This is an image-based sample, not a temporal video model or Meta’s internal originality score."
      >
        {sscd?.status === "ok" && (
          <span>
            Minimum {value(sscd.minSimilarity, 4)} · {sscd.pairs} pairs
          </span>
        )}
        {error(sscd)}
      </ScoreCard>
      <ScoreCard
        label="Color difference"
        value={value(v?.colorDeltaE)}
        scale="Mean ΔE76 · 0 = identical sampled colors"
        status={state(visual, visualStatus ?? status)}
        stale={visualStale ?? stale}
        description="Average CIE Lab ΔE76 between corresponding pixels of 64×64 sampled frames, assuming sRGB/D65. Larger values mean greater color difference. Brightness, contrast and geometric edits also affect it. This is our visual diagnostic, not a Meta hash, calibrated colorimeter or HDR color measurement."
      >
        {v && <span>{v.pairs} aligned frame pairs</span>}
        {error(visual)}
      </ScoreCard>
      <ScoreCard
        label="Contrast change"
        value={
          delta === undefined
            ? "—"
            : `${delta > 0 ? "+" : ""}${value(delta)} pp`
        }
        scale="Luma spread · positive = more contrast"
        status={state(visual, visualStatus ?? status)}
        stale={visualStale ?? stale}
        description="Change in the standard deviation of normalized Rec.709-weighted RGB luma, in percentage points. Before and after values are averaged across matched 64×64 frames. Higher spread means a wider tonal range. Framing and subject changes can affect it too; this is not the editor’s contrast slider value."
      >
        {v && (
          <span>
            {value(v.contrastBefore)} → {value(v.contrastAfter)}%
          </span>
        )}
        {error(visual)}
      </ScoreCard>
      <ScoreCard
        label="Brightness"
        value={
          v
            ? `${value(v.brightnessBefore, 1)} → ${value(v.brightnessAfter, 1)}%`
            : "—"
        }
        scale="Mean luma · original → adjusted"
        status={state(visual, visualStatus ?? status)}
        stale={visualStale ?? stale}
        description="Average Rec.709-weighted RGB luma of matched sampled frames: 0% is black and 100% is white. This describes overall image brightness, including the effect of framing. It is not a perceptual hash or the brightness slider setting."
      >
        {error(visual)}
      </ScoreCard>
      {(["before", "after"] as const).map((side) => {
        const sample = vpdq?.status === "ok" ? vpdq[side] : undefined;
        return (
          <ScoreCard
            key={side}
            label={
              side === "before"
                ? "vPDQ · original found"
                : "vPDQ · comparison found"
            }
            value={
              sample?.percent == null ? "—" : `${value(sample.percent, 1)}%`
            }
            scale="Shared unique frames · either direction"
            status={state(vpdq)}
            stale={stale}
            description={`Percentage of the ${side === "before" ? "original’s" : "comparison’s"} unique, quality-qualified PDQ frame hashes with a match anywhere in the other video. Uses quality ≥50 and bit distance ≤31. Order and timestamps do not affect matching. Up to 64 frames per video are sampled, at 1 second or wider intervals. Short overlaps can be missed. Empty qualified samples produce no percentage. These are documented comparison settings, not Meta platform thresholds.`}
          >
            {sample && (
              <span>
                {sample.matched} / {sample.unique} unique · {sample.sampled}{" "}
                sampled
                <br />
                Every {value(sample.interval)}s
              </span>
            )}
            {error(vpdq)}
          </ScoreCard>
        );
      })}
      {(["before", "after"] as const).map((side) => {
        const sample = motion?.status === "ok" ? motion[side] : undefined;
        return (
          <ScoreCard
            key={`motion-${side}`}
            label={`Motion jitter · ${side === "before" ? "original" : "comparison"}`}
            value={value(sample?.jitter)}
            scale="px / step² · lower = steadier estimated motion"
            status={state(motion)}
            stale={stale}
            description="RMS change in estimated global translation between consecutive frame steps, measured at 8 fps on a 64×64 grid. Up to three 1.25-second windows are sampled independently in each video. Flat frames, large shifts and many cuts are rejected. Subject movement, edits and speed affect this rough motion proxy; it does not isolate camera shake. A dash means too few usable frame triples, not zero jitter."
          >
            {sample && (
              <span>
                {sample.validTriples} usable triples · {sample.rejectedPairs}{" "}
                rejected pairs
              </span>
            )}
            {error(motion)}
          </ScoreCard>
        );
      })}
    </>
  );
}
