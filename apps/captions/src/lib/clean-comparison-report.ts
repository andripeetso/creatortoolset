import type {
  ComparisonTimeline,
  MatchState,
} from "@contracts/clean-comparison";
const labels: Record<MatchState, string> = {
  matched: "Shared sample",
  ambiguous: "Multiple possible locations",
  unmatched: "No sampled match",
  "low-detail": "Insufficient detail",
};
const time = (n: number) => `${n.toFixed(2)}s`;
export function comparisonText(data: ComparisonTimeline) {
  return [
    "# Video comparison",
    "",
    data.method,
    "",
    `Original: ${time(data.beforeDuration)}. Comparison: ${time(data.afterDuration)}.`,
    `Sampling: ${time(data.beforeInterval)} / ${time(data.afterInterval)}.`,
    "",
    "| Comparison range | Result | Original moment | PDQ distance |",
    "| --- | --- | --- | --- |",
    ...data.samples.map(
      (s) =>
        `| ${time(s.start)}–${time(s.end)} | ${labels[s.state]} | ${s.sourceStart === null ? "—" : time(s.sourceStart)} | ${s.distance ?? "—"} |`,
    ),
    "",
    `Longest unambiguous sampled sequence: ${data.longestRun ? time(data.longestRun.seconds) : "not established"}.`,
    "",
    "Audio is not fingerprinted. These results do not predict platform treatment or prove originality.",
  ].join("\n");
}
