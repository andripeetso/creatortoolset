import type {
  CleanupAudit,
  MetadataInspection,
} from "@contracts/clean-inspection";
import { saveCleanBlob } from "@/lib/clean-edit";

const labels: Record<CleanupAudit["rows"][number]["status"], string> = {
  removed: "Removed",
  remaining: "Still present",
  kept: "Kept",
  "not-retained": "Not retained by MP4",
  "not-found": "Not found",
  unchecked: "Not fully checked",
};
export function AuditTable({ audit }: { audit: CleanupAudit }) {
  return (
    <div className="mt-4">
      <table className="w-full text-left text-xs">
        <thead className="text-zinc-500">
          <tr>
            <th className="py-2 font-normal">Category</th>
            <th className="px-2 font-normal">Before</th>
            <th className="px-2 font-normal">After</th>
            <th className="font-normal">Result</th>
          </tr>
        </thead>
        <tbody>
          {audit.rows.map((row) => (
            <tr key={row.category} className="border-t border-zinc-800/70">
              <th className="py-2 pr-2 font-normal text-zinc-300">
                {row.label}
              </th>
              <td className="px-2 tabular-nums">{row.before ?? "—"}</td>
              <td className="px-2 tabular-nums">{row.after ?? "—"}</td>
              <td
                className={
                  row.status === "removed"
                    ? "text-emerald-300"
                    : ["unchecked", "remaining", "not-retained"].includes(
                          row.status,
                        )
                      ? "text-amber-300"
                      : "text-zinc-400"
                }
              >
                {labels[row.status]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {[
        ...new Set([
          ...audit.before.embedded.warnings,
          ...audit.after.embedded.warnings,
        ]),
      ].map((warning) => (
        <p key={warning} className="mt-2 text-xs text-amber-300">
          {warning}
        </p>
      ))}
    </div>
  );
}
export function CleanMetadataAudit({
  inspection,
  audit,
  current,
  busy,
  checking,
  onCheck,
}: {
  inspection?: MetadataInspection;
  audit?: CleanupAudit;
  current: boolean;
  busy: boolean;
  checking: boolean;
  /** Unset = no Check cleanup (the demo). */
  onCheck: () => void;
}) {
  const embedded = inspection?.embedded;
  return (
    <section className="mt-5 rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">
          Privacy inspection & cleanup audit
        </h2>
        <button
          disabled={busy}
          onClick={onCheck}
          className="rounded-lg border border-violet-500/40 px-3 py-2 text-xs text-violet-200 disabled:opacity-40"
        >
          {checking ? "Checking export…" : "Check cleanup"}
        </button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-zinc-400">
        The original is inspected on upload. Check cleanup renders your current
        settings and compares metadata, without running PDQ or TMK.
      </p>
      <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
        <div className="rounded-lg bg-zinc-950 p-3">
          <span className="text-zinc-500">Native entries</span>
          <p className="mt-1 text-lg tabular-nums">
            {inspection?.native.length ?? "—"}
          </p>
        </div>
        {(["xmp", "c2pa"] as const).map((kind) => (
          <div key={kind} className="rounded-lg bg-zinc-950 p-3">
            <span className="text-zinc-500">{kind.toUpperCase()} boxes</span>
            <p className="mt-1 text-lg tabular-nums">
              {embedded?.status === "checked"
                ? embedded.findings.filter((f) => f.kind === kind).length
                : "Unchecked"}
            </p>
          </div>
        ))}
      </div>
      {embedded?.warnings.map((w) => (
        <p key={w} className="mt-2 text-xs text-amber-300">
          {w}
        </p>
      ))}
      {audit && (
        <>
          <p
            className={`mt-4 text-xs ${current ? "text-emerald-300" : "text-amber-300"}`}
          >
            {current
              ? "Verified with the current settings"
              : "Settings changed — this audit describes a previous export."}
          </p>
          <AuditTable audit={audit} />
          <button
            className="mt-3 text-xs text-violet-300 underline"
            onClick={() =>
              saveCleanBlob(
                new Blob(
                  [
                    JSON.stringify(
                      {
                        scope:
                          "Container metadata only; signatures, codec payloads, sidecars and remote credentials unchecked. Private values omitted.",
                        audit,
                      },
                      null,
                      2,
                    ),
                  ],
                  { type: "application/json" },
                ),
                "cleanup-audit.json",
              )
            }
          >
            Download audit report
          </button>
        </>
      )}
      <details className="mt-4 text-xs text-zinc-500">
        <summary className="cursor-pointer">
          Inspection coverage & detected boxes
        </summary>
        <p className="mt-2 leading-relaxed">
          Native tags are read with FFprobe. Deeper inspection checks known XMP
          and C2PA boxes in MP4, M4V and MOV container headers. It does not
          inspect codec payloads, sidecar files or remote credentials, or verify
          C2PA signatures. Unknown UUID boxes require separate interpretation.
        </p>
        {embedded?.findings.map((f, i) => (
          <p key={i} className="mt-2 break-all font-mono">
            {f.kind.toUpperCase()} · {f.where} · {f.bytes} bytes
          </p>
        ))}
      </details>
    </section>
  );
}
