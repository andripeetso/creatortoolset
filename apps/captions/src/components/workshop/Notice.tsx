import type { ReactNode } from "react";
import { TriangleAlert, X } from "lucide-react";

const TONE = {
  error: { box: "border-red-500/25 bg-red-500/[0.07] text-red-200", icon: "text-red-400" },
  warn: { box: "border-amber-500/25 bg-amber-500/[0.07] text-amber-200", icon: "text-amber-400" },
};

/** An error or a heads-up as a card: tinted box, icon, the words, then its action or ×. */
export function Notice({ tone = "error", children, action, onDismiss, className = "" }: { tone?: keyof typeof TONE; children: ReactNode; action?: ReactNode; onDismiss?: () => void; className?: string }) {
  const t = TONE[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-[12.5px] leading-snug ${t.box} ${className}`}>
      <TriangleAlert className={`mt-px h-4 w-4 shrink-0 ${t.icon}`} />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
      {onDismiss ? (
        <button type="button" onClick={onDismiss} className="-mr-1 shrink-0 rounded-md p-0.5 opacity-60 hover:bg-white/10 hover:opacity-100" aria-label="Dismiss">
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}
