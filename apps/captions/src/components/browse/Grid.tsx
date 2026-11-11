import type { ReactNode, Ref } from "react";
import { Button } from "@/components/ui/button";

/**
 * The folders view: folder cards and the tool's item cards in one grid, folders first. `GridHeading`s (a month) span
 * the row. Its cards are its direct children, so `useSteadyList` (lib/steady-list) can glide them by the grid's `ref`.
 * A big library pages from its server: `onMore` shows Load more under the grid.
 */
const COLUMNS = {
  /** 16:9 cards, three across (Review). */
  large: "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3",
  /** Smaller cards, four across (a library of clips). */
  small: "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4",
} as const;
export type GridSize = keyof typeof COLUMNS;

export function FolderGrid({ ref, size = "large", onMore, children }: { ref?: Ref<HTMLDivElement>; size?: GridSize; onMore?: () => void; children: ReactNode }) {
  return (
    <>
      <div ref={ref} className={COLUMNS[size]}>
        {children}
      </div>
      {onMore && (
        <Button variant="outline" className="mx-auto mt-4 flex" onClick={onMore}>
          Load more
        </Button>
      )}
    </>
  );
}

export function GridHeading({ children }: { children: ReactNode }) {
  return <h2 className="col-span-full mt-2 text-sm font-semibold text-zinc-400 first:mt-0">{children}</h2>;
}

/** Before the list is known: the cards in their final size, empty (no spinner; nothing moves when they fill). */
export function GridFrame({ size = "large", count = 6 }: { size?: GridSize; count?: number }) {
  return (
    <div className={COLUMNS[size]} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50">
          <div className="aspect-video bg-zinc-950" />
          <div className="h-16" />
        </div>
      ))}
    </div>
  );
}
