import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { EFFORTS, type Effort } from "@contracts/providers";
import { effortLabel, modelName } from "@/lib/providers";
import { cn } from "@/lib/utils";
import { selectCls } from "./helpers";


/**
 * A group of settings: a small heading flush with the cards' left edge (an action, e.g. "Add", on its right), an
 * optional one-line hint under it, then its cards. Spacing: 8px between the heading block and each card or note.
 * Groups are spaced 32px apart; the first one sits flush under the page's intro line.
 */
export function Group({ title, hint, action, children, className }: { title: string; hint?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("mt-8 space-y-2 first:mt-0", className)}>
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/** A note under a group's cards: one line, same spacing as the cards, never on a card's edge. */
export function Footnote({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

/** A rounded card of rows with hairlines between them. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-xl border border-border/60 bg-card/40 text-foreground [&>*+*]:border-t [&>*+*]:border-border/50", className)}>
      {children}
    </div>
  );
}

export function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 px-3 py-3 sm:px-4">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export function ModelSelect({ value, options, onChange, disabled }: { value: string; options: string[]; onChange: (m: string) => void; disabled?: boolean }) {
  const list = options.includes(value) || !value ? options : [value, ...options];
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={selectCls} aria-label="Model">
      {list.map((m) => (
        <option key={m} value={m}>
          {modelName(m)}
        </option>
      ))}
    </select>
  );
}

export function EffortSelect({ value, onChange, disabled }: { value: Effort; onChange: (e: Effort) => void; disabled?: boolean }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as Effort)} disabled={disabled} className={selectCls} aria-label="Effort">
      {EFFORTS.map((e) => (
        <option key={e} value={e}>
          {effortLabel(e)}
        </option>
      ))}
    </select>
  );
}


export function Dot({ on, className }: { on: boolean; className?: string }) {
  return <span aria-hidden className={cn("inline-block h-2 w-2 shrink-0 rounded-full", on ? "bg-emerald-500" : "bg-muted-foreground/40", className)} />;
}

export function Loading() {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
    </div>
  );
}

export function Notice({ tone = "muted", children }: { tone?: "muted" | "warn" | "error"; children: ReactNode }) {
  return (
    <p
      className={cn(
        "rounded-md px-3 py-2 text-xs",
        tone === "muted" && "bg-muted/60 text-muted-foreground",
        tone === "warn" && "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        tone === "error" && "bg-red-500/10 text-red-600 dark:text-red-300",
      )}
    >
      {children}
    </p>
  );
}

