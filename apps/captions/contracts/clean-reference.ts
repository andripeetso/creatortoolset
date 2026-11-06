import type { FingerprintReport } from "./clean-fingerprints";

/** Public reference settings, not calibrated platform detection probabilities. */
export const CLEAN_REFERENCE_RULES = {
  version: "reference/1",
  pdq: {
    maximumDistance: 31,
    minimumQuality: 50,
    source:
      "https://github.com/facebook/ThreatExchange/blob/main/python-threatexchange/threatexchange/signal_type/pdq/pdq_utils.py",
  },
  tmk: {
    minimumLevel1: 0.7,
    minimumLevel2: 0.7,
    source:
      "https://github.com/facebook/ThreatExchange/blob/main/tmk/cpp/bin/tmk_default_thresholds.h",
  },
  vpdq: {
    minimumOriginalPercent: 0,
    minimumComparisonPercent: 80,
    source:
      "https://github.com/facebook/ThreatExchange/tree/main/vpdq#comparison-matching-algorithm",
  },
} as const;

export type ReferenceState =
  "match" | "outside" | "mixed" | "insufficient" | "unmeasured" | "stale";
export interface ReferenceCheck {
  id: "pdq" | "tmk" | "vpdq";
  label: string;
  state: ReferenceState;
  complete: boolean;
  value: string;
  range: string;
  detail: string;
  source: string;
}
type ReferenceInput = Partial<Pick<FingerprintReport, "pdq" | "tmk" | "vpdq">>;
export function assessReferenceRanges(
  scores: ReferenceInput,
  options: {
    mode?: "live" | "encoded";
    pdqStale?: boolean;
    fullStale?: boolean;
  } = {},
) {
  const mode = options.mode ?? "encoded";
  const checks: ReferenceCheck[] = [
    {
      id: "pdq",
      label: `PDQ frames · ${mode === "live" ? "live" : "encoded"}`,
      state: "unmeasured",
      complete: false,
      value: "Not measured",
      range: "0–31 bits: match · 32–256: outside",
      detail:
        "The range applies to each reliable frame pair, not the mean distance.",
      source: CLEAN_REFERENCE_RULES.pdq.source,
    },
    {
      id: "tmk",
      label: "TMK+PDQF · full video",
      state: "unmeasured",
      complete: false,
      value: "Not measured",
      range: "Match: L1 ≥0.70 and L2 ≥0.70",
      detail:
        "Both public cutoffs must be met. A value below either cutoff is outside this reference rule.",
      source: CLEAN_REFERENCE_RULES.tmk.source,
    },
    {
      id: "vpdq",
      label: "vPDQ · overlap example",
      state: "unmeasured",
      complete: false,
      value: "Not measured",
      range: "Comparison ≥80% · original ≥0%",
      detail:
        "The published directional example, not a universal default. Swapping the files can change the result.",
      source: CLEAN_REFERENCE_RULES.vpdq.source,
    },
  ];
  const [pdq, tmk, vpdq] = checks;
  for (const check of checks) {
    const score = scores[check.id];
    if (score && score.status !== "ok") {
      check.state = "insufficient";
      check.value =
        score.status === "unavailable" ? "Unavailable" : "Measurement failed";
      check.detail = score.message;
    }
  }
  if (scores.pdq?.status === "ok") {
    const frames = scores.pdq.frames;
    const valid = frames.filter(
      (f) =>
        f.reliable &&
        f.qualityBefore >= 50 &&
        f.qualityAfter >= 50 &&
        Number.isInteger(f.distance) &&
        f.distance >= 0 &&
        f.distance <= 256,
    );
    const matched = valid.filter(
      (f) => f.distance <= CLEAN_REFERENCE_RULES.pdq.maximumDistance,
    ).length;
    pdq.complete = valid.length > 0 && valid.length === frames.length;
    pdq.state = !valid.length
      ? "insufficient"
      : matched === valid.length
        ? "match"
        : matched === 0
          ? "outside"
          : "mixed";
    pdq.value = valid.length
      ? `${matched} / ${valid.length} reliable pairs match`
      : "No reliable frame pairs";
    pdq.detail = `${valid.length} of ${frames.length} sampled pairs are usable. ${valid.length - matched} usable pairs are outside the reference range. Unsampled content is unknown.`;
  }
  if (scores.tmk?.status === "ok") {
    const { level1, level2 } = scores.tmk;
    tmk.complete =
      Number.isFinite(level1) &&
      Number.isFinite(level2) &&
      level1 >= -1 &&
      level1 <= 1 &&
      level2 >= 0 &&
      level2 <= 1;
    tmk.state = !tmk.complete
      ? "insufficient"
      : level1 >= CLEAN_REFERENCE_RULES.tmk.minimumLevel1 &&
          level2 >= CLEAN_REFERENCE_RULES.tmk.minimumLevel2
        ? "match"
        : "outside";
    tmk.value = tmk.complete
      ? `L1 ${level1.toFixed(6)} · L2 ${level2.toFixed(6)}`
      : "Invalid TMK scores";
  }
  if (scores.vpdq?.status === "ok") {
    const { before, after, distanceLimit, qualityMinimum } = scores.vpdq;
    const usable = (side: typeof before) =>
      side.unique > 0 &&
      side.percent !== null &&
      Number.isFinite(side.percent) &&
      side.percent >= 0 &&
      side.percent <= 100;
    vpdq.complete =
      usable(before) &&
      usable(after) &&
      distanceLimit === CLEAN_REFERENCE_RULES.pdq.maximumDistance &&
      qualityMinimum === CLEAN_REFERENCE_RULES.pdq.minimumQuality;
    vpdq.state = !vpdq.complete
      ? "insufficient"
      : before.percent! >= CLEAN_REFERENCE_RULES.vpdq.minimumOriginalPercent &&
          after.percent! >= CLEAN_REFERENCE_RULES.vpdq.minimumComparisonPercent
        ? "match"
        : "outside";
    vpdq.value = vpdq.complete
      ? `Original ${before.percent!.toFixed(1)}% · comparison ${after.percent!.toFixed(1)}%`
      : "Insufficient or incompatible samples";
  }
  for (const check of checks)
    if (
      scores[check.id] &&
      (check.id === "pdq" ? options.pdqStale : options.fullStale)
    ) {
      check.state = "stale";
      check.complete = false;
    }
  const complete = mode === "encoded" && checks.every((c) => c.complete);
  const state = !complete
    ? "incomplete"
    : checks.every((c) => c.state === "outside")
      ? "outside"
      : checks.every((c) => c.state === "match")
        ? "match"
        : "mixed";
  const title = checks.every((c) => c.state === "unmeasured")
    ? "Measure to assess reference ranges"
    : checks.some((c) => c.state === "stale")
      ? "Settings changed · update the reference check"
      : !complete
        ? "Partial reference results"
        : state === "outside"
          ? "Outside these reference match ranges"
          : state === "match"
            ? "Within these reference match ranges"
            : "Mixed reference results";
  return {
    rules: CLEAN_REFERENCE_RULES,
    mode,
    complete,
    state,
    title,
    checks,
    platformOutcome: "unknown" as const,
    limitation:
      "These public settings compare this pair. They do not predict Meta approval, originality or detection. SSCD, color, contrast and motion have no calibrated pass cutoff here.",
  };
}
