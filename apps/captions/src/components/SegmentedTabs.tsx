import { cn } from "@/lib/utils";

/**
 * The one segmented-tab style: a zinc track, the chosen
 * segment in the project's accent. Use `segmentList` on the track and `segmentItem` on each button.
 * Full-width rows add `flex-1` to the item; inline rows leave the list `self-start`.
 */
export const segmentList = "flex max-w-full rounded-lg border border-zinc-800 bg-zinc-900/50 p-0.5";

export function segmentItem(on: boolean, className?: string) {
  return cn(
    "min-w-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
    on ? "bg-violet-600/25 text-violet-100" : "text-zinc-400 hover:text-zinc-200",
    className,
  );
}

/** The one filter-chip style: a pill, the accent when on. */
export function filterChip(on: boolean, className?: string) {
  return cn(
    "whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
    on
      ? "border-violet-500/50 bg-violet-600/20 text-violet-100"
      : "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
    className,
  );
}
