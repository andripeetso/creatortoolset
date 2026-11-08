import type { ReactNode } from "react";
import { Check, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * One answer card in setup (What you make, Your tools): an icon, a name and a line. Picked = the accent colour
 * (`--tint`, the project colour where one is set) with a tick in the corner. `multi` = a checkbox, else a radio.
 */
export function Choice({
  on,
  onClick,
  icon: Icon,
  name,
  line,
  multi,
}: {
  on: boolean;
  onClick: () => void;
  icon: LucideIcon;
  name: string;
  line?: ReactNode;
  multi?: boolean;
}) {
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={on}
      onClick={onClick}
      className={cn(
        "group relative flex w-full rounded-xl border text-left outline-none transition-[border-color,background-color,box-shadow] duration-150",
        "focus-visible:ring-2 focus-visible:ring-[var(--tint)]",
        "items-center gap-3 px-3 py-2.5",
        on
          ? "border-[var(--tint)] bg-[color-mix(in_srgb,var(--tint)_7%,transparent)]"
          : "border-border/70 bg-card/40 hover:border-foreground/25 hover:bg-accent/40",
      )}
    >
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-lg transition-colors",
          "size-8",
          on
            ? "bg-[color-mix(in_srgb,var(--tint)_20%,transparent)] text-[var(--tint-text)]"
            : "bg-muted text-muted-foreground group-hover:text-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1 pr-5">
        <span className="block text-sm font-medium text-foreground">{name}</span>
        {line && <span className="block text-xs text-muted-foreground">{line}</span>}
      </span>
      <span
        aria-hidden
        className={cn(
          "absolute right-3 top-1/2 flex size-[18px] -translate-y-1/2 items-center justify-center border transition-all",
          multi ? "rounded-[5px]" : "rounded-full",
          on ? "border-[var(--tint)] bg-[var(--tint)] text-white" : "border-foreground/20 bg-background/40",
        )}
      >
        {on && <Check className="size-3" strokeWidth={3} />}
      </span>
    </button>
  );
}
