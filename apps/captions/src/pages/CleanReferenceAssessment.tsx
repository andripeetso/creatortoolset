import {
  assessReferenceRanges,
  type ReferenceState,
} from "@contracts/clean-reference";
import type { FingerprintReport } from "@contracts/clean-fingerprints";
import { ScoreHelp } from "./CleanScoreCard";
import { Info } from "lucide-react";

const labels: Record<ReferenceState, string> = {
  match: "Within match range",
  outside: "Outside match range",
  mixed: "Mixed frame results",
  insufficient: "Insufficient data",
  unmeasured: "Not measured",
  stale: "Previous settings",
};
const colors: Record<ReferenceState, string> = {
  match: "text-amber-200",
  outside: "text-sky-200",
  mixed: "text-violet-200",
  insufficient: "text-zinc-400",
  unmeasured: "text-zinc-400",
  stale: "text-amber-300",
};
export function CleanReferenceAssessment({
  scores,
  mode = "encoded",
  pdqStale = false,
  fullStale = false,
}: {
  scores: Partial<FingerprintReport>;
  mode?: "live" | "encoded";
  pdqStale?: boolean;
  fullStale?: boolean;
}) {
  const assessment = assessReferenceRanges(scores, {
    mode,
    pdqStale,
    fullStale,
  });
  return (
    <section
      aria-label="Public reference assessment"
      className="mt-3 rounded-xl border border-zinc-700/60 bg-zinc-950/30 p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-medium text-zinc-400">
            Public reference assessment
          </h3>
          <p className="mt-1 text-sm font-medium text-zinc-100" role="status">
            {assessment.title}
          </p>
        </div>
        <ScoreHelp
          description={assessment.limitation}
          className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400"
        >
          Meta outcome: unknown <Info className="h-3 w-3" aria-hidden="true" />
        </ScoreHelp>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {assessment.checks.map((check) => (
          <div
            key={check.id}
            className="min-w-0 rounded-lg border border-zinc-800 p-2.5"
          >
            <p className="text-[11px] text-zinc-400">{check.label}</p>
            <ScoreHelp
              description={check.detail}
              className={`mt-1 flex items-center gap-1.5 rounded text-left text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 ${colors[check.state]}`}
            >
              {labels[check.state]}{" "}
              <Info className="h-3 w-3 shrink-0" aria-hidden="true" />
            </ScoreHelp>
            <p className="mt-1 text-xs tabular-nums text-zinc-200">
              {check.value}
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-zinc-400">
              {check.range}
            </p>
            <a
              href={check.source}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block text-[10px] text-violet-300 underline underline-offset-2"
            >
              {check.id === "vpdq" ? "Published example" : "Reference source"}
            </a>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">
        {assessment.complete
          ? "Sampled results apply only to these measured files. "
          : "Measure full scores for the current edit; missing, low-detail and older results stay inconclusive. "}
        SSCD and visual diagnostics have no calibrated pass cutoff.
      </p>
    </section>
  );
}
