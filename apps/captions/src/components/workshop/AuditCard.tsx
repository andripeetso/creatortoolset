import { ShieldCheck } from "lucide-react";
import { auditFixCount, liveAuditScore, type AuditMeta, type AuditResult } from "@/lib/workshop";

const scoreClass = (n: number) =>
  n >= 80 ? "text-emerald-700 dark:text-emerald-300" : n >= 50 ? "text-amber-700 dark:text-amber-300" : "text-red-700 dark:text-red-300";

/** Chat teaser: score + Open. The claims live in AuditModal. */
export function AuditOpenRow({ audit, onOpen }: { audit: AuditMeta & { result: AuditResult }; onOpen: () => void }) {
  const left = auditFixCount(audit);
  const applied = audit.applied?.length ?? 0;
  const score = liveAuditScore(audit);
  const status = left ? `${left} to review` : applied ? `${applied} applied` : "All clear";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-lg border border-border bg-muted/50 px-3 py-2.5 text-left hover:bg-muted"
    >
      <ShieldCheck className="h-4 w-4 shrink-0 text-violet-500" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-foreground">Accuracy audit · “{audit.target.title}”</span>
        <span className="text-[11px] text-muted-foreground">
          <span className={`font-medium ${scoreClass(score)}`}>{score}/100</span>
          <span> · {status}</span>
        </span>
      </span>
      <span className="shrink-0 text-[12px] font-medium text-violet-600 dark:text-violet-300">Open</span>
    </button>
  );
}
