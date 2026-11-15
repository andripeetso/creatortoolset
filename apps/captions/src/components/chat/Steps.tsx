import { ChevronDown } from "lucide-react";
import { duration } from "@/components/assistant/WorkCards";
import { cn } from "@/lib/utils";

/** One thing the AI did; `ms` is how long it took (or has taken so far), when the chat knows it. */
export type Step = { label: string; ms?: number };

/**
 * What the AI did in a reply, folded into one row, the same in both chats. While it works: the step it is on, a light
 * running through it. Once done: "Worked for 1m 12s" (or "N steps" for a reply that kept no time), opening to the list.
 */
export function Steps({ steps, working = false, took }: { steps: Step[]; working?: boolean; took?: number }) {
  if (!steps.length) return null;
  const last = steps[steps.length - 1].label;
  const label = working ? `${last}…` : took !== undefined ? `Worked for ${duration(took)}` : steps.length === 1 ? last : `${steps.length} steps`;
  const opens = steps.length > 1 || (!working && took !== undefined);
  return (
    <details className="group mt-1 mb-1.5 text-xs text-muted-foreground">
      <summary className={cn("flex w-fit max-w-full list-none items-center gap-1.5 select-none [&::-webkit-details-marker]:hidden", opens && "cursor-pointer hover:text-foreground")}>
        <span className={cn("truncate", working && "ct-shimmer")} role={working ? "status" : undefined}>
          {label}
        </span>
        {opens && <ChevronDown className="size-3 shrink-0 -rotate-90 transition-transform group-open:rotate-0" aria-hidden />}
      </summary>
      {opens && (
        <ul className="mt-1 ml-0.5 space-y-0.5 border-l border-border pl-2.5">
          {steps.map((s, i) => (
            <li key={i}>
              {s.label}
              {s.ms !== undefined && <span className="ml-2 tabular-nums text-muted-foreground/70">{duration(s.ms)}</span>}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
