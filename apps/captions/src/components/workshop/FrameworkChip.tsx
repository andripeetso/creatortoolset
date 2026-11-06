import { useEffect, useRef, useState } from "react";
import type { WorkshopFramework } from "@/lib/workshop";

/**
 * How long the pointer has to rest on a chip before the card opens. OS
 * tooltips use 500–1000 ms; rich cards like this one are opened deliberately,
 * so a pass-over or a slow drift across the row must show nothing.
 */
const HOVER_DELAY_MS = 1500;

/**
 * A toggle for one framework with a card that opens after a short hover
 * (or at once on keyboard focus): how it works, the beats, what it is best
 * for, what it pairs with.
 */
export function FrameworkChip({
  framework,
  on,
  order,
  onToggle,
}: {
  framework: WorkshopFramework;
  on: boolean;
  /** 1-based position among the selected ones, shown when several are on. */
  order?: number;
  onToggle: () => void;
}) {
  const f = framework;
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  return (
    <span
      className="relative"
      onMouseEnter={() => {
        cancel();
        timer.current = setTimeout(() => setOpen(true), HOVER_DELAY_MS);
      }}
      onMouseLeave={() => {
        cancel();
        setOpen(false);
      }}
    >
      <button
        type="button"
        aria-pressed={on}
        onClick={onToggle}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={`rounded-md border px-2 py-1 text-[11px] ${
          on
            ? "border-violet-500/60 bg-violet-600/20 text-violet-950 dark:text-violet-100"
            : "border-border text-muted-foreground hover:border-violet-400/50 hover:text-foreground"
        }`}
      >
        {order ? <span className="mr-1 text-[10px] text-violet-300">{order}</span> : null}
        {f.name}
      </button>
      {open && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-0 z-30 mb-1.5 block w-80 rounded-xl border border-border bg-popover p-3 text-left text-popover-foreground shadow-2xl"
        >
          <span className="block text-xs font-medium text-foreground">{f.name}</span>
          {f.summary ? <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">{f.summary}</span> : null}
          <ol className="mt-2 list-decimal space-y-0.5 pl-4 text-[11px] leading-snug text-muted-foreground">
            {f.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          {f.whenToUse ? (
            <span className="mt-2 block text-[11px] leading-snug text-muted-foreground">
              <span className="text-muted-foreground/80">Best for: </span>
              {f.whenToUse}
            </span>
          ) : null}
          {f.pairsWith ? (
            <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
              <span className="text-muted-foreground/80">Pairs with: </span>
              {f.pairsWith}
            </span>
          ) : null}
        </span>
      )}
    </span>
  );
}
