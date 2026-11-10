import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Section } from "./kit-rows";
import type { SearchRowId } from "./search";

/*
 * Compatibility exports for the sections not rebuilt yet. Each screen builder deletes its own use of these. The coordinator
 * removes this file at the end. Nothing new uses them.
 */

/** @deprecated Use Section. The hint is dropped on purpose: no text under a section title. */
export function Group({ id, title, action, children, className }: { id?: SearchRowId; title: string; hint?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Section id={id} title={title} action={action} className={className}>
      {children}
    </Section>
  );
}

/** @deprecated A note under a card. Use a Row's description, or an EmptyRow. */
export function Footnote({ children }: { children: ReactNode }) {
  return <p className="px-0.5 text-xs text-muted-foreground">{children}</p>;
}

/** @deprecated The old status dot. There is no green: the dot is solid when on, faint when off. Use Status. */
export function Dot({ on, className }: { on: boolean; className?: string }) {
  return <span aria-hidden className={cn("inline-block h-2 w-2 shrink-0 rounded-full", on ? "bg-foreground/70" : "bg-muted-foreground/40", className)} />;
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
