import { useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, Loader2, ShieldCheck, X } from "lucide-react";
import {
  VERDICTS,
  auditFixCount,
  claimPlaceLabel,
  isAuditFixWhere,
  liveAuditScore,
  type AuditClaim,
  type AuditMeta,
  type AuditResult,
  type WorkshopDocument,
} from "@/lib/workshop";

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const scoreClass = (n: number) =>
  n >= 80 ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200" : n >= 50 ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200" : "border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-200";

function hasWording(c: AuditClaim) {
  return !!c.fix && isAuditFixWhere(c.where);
}

const byVerdict = (a: AuditClaim, b: AuditClaim) => VERDICTS[a.verdict].rank - VERDICTS[b.verdict].rank;

/**
 * Review an accuracy audit: accept or skip each rewording, then Process
 * writes the accepted ones in one go.
 */
export function AuditModal({
  audit,
  doc,
  busy,
  onClose,
  onProcess,
}: {
  audit: AuditMeta & { result: AuditResult };
  doc?: WorkshopDocument;
  busy: boolean;
  onClose: () => void;
  onProcess: (claimIds: string[]) => Promise<void>;
}) {
  const r = audit.result;
  const applied = useMemo(() => new Set(audit.applied ?? []), [audit.applied]);
  const score = liveAuditScore(audit);
  const canApply = audit.target.type === "document" && !!doc;
  const wording = useMemo(() => r.claims.filter(hasWording).sort(byVerdict), [r.claims]);
  const flags = useMemo(() => r.claims.filter((c) => !hasWording(c) && c.verdict !== "supported").sort(byVerdict), [r.claims]);
  const listed = useMemo(() => [...wording, ...flags], [wording, flags]);
  const solid = r.claims.length - listed.length;
  const pending = useMemo(() => wording.filter((c) => !applied.has(c.id)), [wording, applied]);
  const [working, setWorking] = useState(false);
  // nothing is pre-accepted: a rewording goes in only when the author says so
  const [decisions, setDecisions] = useState<Record<string, "accept" | "skip">>({});

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const accepted = pending.filter((c) => decisions[c.id] === "accept").map((c) => c.id);
  const skipped = pending.filter((c) => decisions[c.id] === "skip").length;
  const locked = busy || working;

  const process = async () => {
    if (!accepted.length || locked) return;
    setWorking(true);
    try {
      await onProcess(accepted);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div
        role="dialog"
        aria-labelledby="audit-modal-title"
        aria-modal="true"
        className="relative flex max-h-[90vh] w-[720px] max-w-full flex-col overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-border bg-card px-4 py-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-violet-500" />
          <div className="min-w-0 flex-1">
            <h2 id="audit-modal-title" className="text-base font-semibold">
              Accuracy audit · “{audit.target.title}”
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
              <span className={`rounded-md border px-1.5 py-0.5 font-medium ${scoreClass(score)}`}>{score}/100</span>
              <span>
                {audit.depth === "deep" ? "Deep research" : "Quick check"}
                {audit.model ? ` · ${audit.model}` : ""}
              </span>
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-card px-4 py-3">
          {r.summary ? <p className="mb-3 text-[13px] leading-relaxed text-foreground">{r.summary}</p> : null}
          {listed.length === 0 ? <p className="text-[13px] text-muted-foreground">Nothing to reword.</p> : null}
          <ol className="flex flex-col gap-2">
            {listed.map((c) => (
              <ClaimRow
                key={c.id}
                claim={c}
                place={claimPlaceLabel(doc, c.where)}
                applied={applied.has(c.id)}
                canApply={canApply}
                decision={decisions[c.id]}
                locked={locked}
                onDecision={(d) => setDecisions((prev) => ({ ...prev, [c.id]: d }))}
              />
            ))}
          </ol>
          {solid ? (
            <p className="mt-3 text-[12px] text-muted-foreground">
              {solid} other claim{solid === 1 ? "" : "s"} look solid.
            </p>
          ) : null}
          {r.citations.length ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Read {r.citations.length} page{r.citations.length === 1 ? "" : "s"}: {r.citations.slice(0, 8).map(host).join(", ")}
              {r.citations.length > 8 ? "…" : ""}
            </p>
          ) : null}
        </div>

        {canApply ? (
          <div className="flex shrink-0 items-center gap-3 border-t border-border bg-card px-4 py-3">
            <p className="min-w-0 flex-1 text-[12px] text-muted-foreground">
              {pending.length === 0
                ? auditFixCount(audit) === 0 && applied.size
                  ? "Those wordings are in the document."
                  : "No rewordings to apply."
                : accepted.length || skipped
                  ? `${accepted.length} accepted${skipped ? ` · ${skipped} skipped` : ""}`
                  : `${pending.length} rewording${pending.length === 1 ? "" : "s"} for claims that would be false as posted. Accept the ones you want.`}
            </p>
            <button
              type="button"
              disabled={locked || accepted.length === 0}
              onClick={() => void process()}
              className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-violet-500 disabled:opacity-40"
            >
              {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Process{accepted.length ? ` ${accepted.length}` : ""}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ClaimRow({
  claim: c,
  place,
  applied,
  canApply,
  decision,
  locked,
  onDecision,
}: {
  claim: AuditClaim;
  place: string;
  applied: boolean;
  canApply: boolean;
  decision?: "accept" | "skip";
  locked: boolean;
  onDecision: (d: "accept" | "skip") => void;
}) {
  const v = VERDICTS[c.verdict];
  const [why, setWhy] = useState(false);
  const reviewable = canApply && !!c.fix && isAuditFixWhere(c.where) && !applied;
  const hasWhy = !!(c.evidence || c.sources.length);
  const btn = "rounded-md border px-2.5 py-1 text-[12px] font-medium";
  const idle = `${btn} border-border text-muted-foreground hover:bg-muted hover:text-foreground`;
  return (
    <li className="rounded-lg border border-border px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${v.className}`}>{v.label}</span>
        {place ? <span>{place}</span> : null}
        <span>{Math.round(c.confidence * 100)}%</span>
      </div>
      {c.fix ? (
        <div className="mt-3 grid gap-3">
          <div>
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Now</p>
            <p className={`text-[13px] leading-relaxed ${decision === "skip" && !applied ? "text-foreground" : "text-muted-foreground"}`}>{c.claim}</p>
          </div>
          <div className={`border-t border-border pt-3 ${decision === "skip" && !applied ? "opacity-40" : ""}`}>
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-foreground">Change to</p>
            <p className="text-[13px] leading-relaxed text-foreground">{c.fix}</p>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-[13px] leading-relaxed text-foreground">{c.claim}</p>
      )}
      {reviewable || hasWhy || (applied && c.fix) ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {reviewable ? (
            <>
              <button
                type="button"
                disabled={locked}
                onClick={() => onDecision("accept")}
                className={decision === "accept" ? `${btn} border-violet-600 bg-violet-600 text-white` : idle}
              >
                Accept
              </button>
              <button
                type="button"
                disabled={locked}
                onClick={() => onDecision("skip")}
                className={decision === "skip" ? `${btn} border-foreground bg-foreground text-background` : idle}
              >
                Skip
              </button>
            </>
          ) : applied && c.fix ? (
            <span className="flex items-center gap-1 text-[12px] text-emerald-700 dark:text-emerald-300">
              <Check className="h-3 w-3" /> Applied
            </span>
          ) : null}
          {hasWhy ? (
            <button type="button" onClick={() => setWhy((o) => !o)} className={why ? `${btn} border-border bg-muted text-foreground` : idle} aria-expanded={why}>
              Why
            </button>
          ) : null}
        </div>
      ) : null}
      {why ? (
        <div className="mt-2 space-y-1.5 border-t border-border pt-2">
          {c.evidence ? <p className="text-[12px] leading-relaxed text-muted-foreground">{c.evidence}</p> : null}
          {c.sources.length ? (
            <p className="flex flex-wrap gap-1">
              {c.sources.map((s) => (
                <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-sky-700 hover:bg-muted/80 dark:text-sky-200" title={s.title || s.url}>
                  <ExternalLink className="h-2.5 w-2.5" /> {s.title ? s.title.slice(0, 48) : host(s.url)}
                </a>
              ))}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
