import { CleanReferenceAssessment } from "./CleanReferenceAssessment";
import { assessReferenceRanges } from "@contracts/clean-reference";
import { CleanExtendedScoreCards } from "./CleanExtendedScoreCards";
import { Download, Fingerprint } from "lucide-react";
import type { EditOptions } from "@contracts/clean-edit";
import type { FingerprintReport } from "@contracts/clean-fingerprints";

function downloadReport(
  name: string,
  md5: { before: string; after: string },
  fingerprints: FingerprintReport,
  settings?: EditOptions,
  comparisonLabel?: string,
  stale = false,
) {
  const url = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          {
            name,
            comparisonLabel,
            settings,
            md5,
            fingerprints,
            referenceAssessment: assessReferenceRanges(fingerprints, {
              pdqStale: stale,
              fullStale: stale,
            }),
          },
          null,
          2,
        ),
      ],
      {
        type: "application/json",
      },
    ),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name.replace(/\.[^.]+$/, "")}-fingerprints.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function FingerprintResults({
  report,
  name,
  md5,
  comparisonLabel = "cleaned copy",
  settings,
  stale = false,
}: {
  report: FingerprintReport;
  settings?: EditOptions;
  stale?: boolean;
  comparisonLabel?: string;
  name: string;
  md5: { before: string; after: string };
}) {
  const { pdq, tmk } = report;
  return (
    <section
      aria-label="Visual fingerprint measurements"
      className="mt-4 border-t border-zinc-800 pt-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-zinc-200">
          <Fingerprint className="h-4 w-4 text-violet-400" /> Visual
          fingerprints
        </h2>
        <button
          type="button"
          onClick={() =>
            downloadReport(name, md5, report, settings, comparisonLabel, stale)
          }
          className="flex items-center gap-1 text-xs text-violet-300 hover:text-violet-200"
        >
          <Download className="h-3.5 w-3.5" /> JSON report
        </button>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Original → {comparisonLabel} ·{" "}
        {md5.before === md5.after ? "file MD5 unchanged" : "file MD5 changed"}
      </p>
      <CleanReferenceAssessment
        scores={report}
        pdqStale={stale}
        fullStale={stale}
      />
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-zinc-800 p-3">
          <h3 className="text-xs font-medium text-zinc-300">
            PDQ · sampled frames
          </h3>
          {pdq.status === "ok" ? (
            <>
              <p className="mt-2 text-xl font-semibold tabular-nums text-zinc-100">
                {pdq.meanDistance === null
                  ? "Low detail"
                  : `${pdq.meanDistance.toFixed(1)} / 256`}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                {pdq.meanDistance === null
                  ? "No frame pairs have enough detail for the distance summary."
                  : `Mean differing bits · maximum ${pdq.maxDistance}. Zero means identical hashes.`}
              </p>
              <p className="mt-2 text-xs text-zinc-400">
                {pdq.reliableFrames} of {pdq.frames.length} pairs with quality
                ≥50
              </p>
            </>
          ) : (
            <p className="mt-2 text-xs leading-relaxed text-amber-300">
              {pdq.status === "unavailable"
                ? "Unavailable. "
                : "Not measured. "}
              {pdq.message}
            </p>
          )}
        </div>
        <div className="rounded-xl border border-zinc-800 p-3">
          <h3 className="text-xs font-medium text-zinc-300">
            TMK+PDQF · full video
          </h3>
          {tmk.status === "ok" ? (
            <>
              <p className="mt-2 text-xl font-semibold tabular-nums text-zinc-100">
                {tmk.level2.toFixed(6)}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                Temporal similarity (L2) · 1 is the highest similarity.
              </p>
              <p className="mt-2 text-xs text-zinc-400">
                Average-frame score (L1): {tmk.level1.toFixed(6)}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                Signature bytes{" "}
                {tmk.signatureIdentical ? "identical" : "different"}
              </p>
            </>
          ) : (
            <p className="mt-2 text-xs leading-relaxed text-amber-300">
              {tmk.status === "unavailable"
                ? "Unavailable. "
                : "Not measured. "}
              {tmk.message}
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <CleanExtendedScoreCards
          scores={report}
          status={
            stale ? "Previous settings" : "Encoded files · sampled analysis"
          }
          stale={stale}
        />
      </div>
      {pdq.status === "ok" && (
        <details className="mt-3 text-xs text-zinc-400">
          <summary className="cursor-pointer hover:text-zinc-200">
            Frame measurements and hashes
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-[11px] tabular-nums">
              <thead className="text-zinc-500">
                <tr>
                  <th className="py-2">Target time</th>
                  <th>Bit difference</th>
                  <th>Quality before / after</th>
                </tr>
              </thead>
              <tbody>
                {pdq.frames.map((frame, index) => (
                  <tr key={index} className="border-t border-zinc-800">
                    <td className="py-2 align-top">
                      {frame.seconds.toFixed(2)}s
                      {frame.originalSeconds !== undefined && (
                        <span className="block text-zinc-500">
                          Original {frame.originalSeconds.toFixed(2)}s
                        </span>
                      )}
                    </td>
                    <td className="py-2 align-top">{frame.distance} / 256</td>
                    <td className="py-2">
                      {frame.qualityBefore} / {frame.qualityAfter}
                      {!frame.reliable && (
                        <span className="ml-1 text-amber-300">low detail</span>
                      )}
                      <details className="mt-1">
                        <summary className="cursor-pointer text-violet-300">
                          Hashes
                        </summary>
                        <p className="mt-1 max-w-56 break-all font-mono">
                          Before: {frame.before}
                        </p>
                        <p className="mt-1 max-w-56 break-all font-mono">
                          After: {frame.after}
                        </p>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
        These scores compare the two files. They do not predict whether a
        platform will match a video. PDQ covers sampled frames; audio is not
        measured.
      </p>
      <details className="mt-2 text-[11px] text-zinc-500">
        <summary className="cursor-pointer hover:text-zinc-300">
          Method and implementation
        </summary>
        <p className="mt-2 leading-relaxed">{report.scope}</p>
        <p className="mt-1 break-all">
          {report.implementation} · {report.revision || "revision unknown"}
        </p>
        {report.ffmpeg && <p className="mt-1 break-all">{report.ffmpeg}</p>}
      </details>
    </section>
  );
}
