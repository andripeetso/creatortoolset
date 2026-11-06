import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { EFFORTS, type Effort } from "@contracts/providers";
import { effortLabel, modelName } from "@/lib/providers";
import { cn } from "@/lib/utils";
import { selectCls } from "./helpers";


/** A titled group of rows (each settings section is a titled block with a hint under the title). */
export function Group({ title, hint, children, className }: { title: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("mt-8 first:mt-0", className)}>
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {hint && <p className="mb-2 mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      {children}
    </section>
  );
}

/** A bordered list of rows: label and hint on the left, the control on the right. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("divide-y divide-border rounded-lg border border-border", className)}>{children}</div>;
}

export function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
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

