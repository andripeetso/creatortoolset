import type { ReactNode, Ref } from "react";
import { Link } from "react-router";
import type { LucideIcon } from "lucide-react";
import { Picture } from "@/components/Picture";
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
  /** In a narrow column under a drop zone: two or three across. */
  column: "grid grid-cols-2 gap-3 sm:grid-cols-3",
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

/**
 * One item in the cards view, for a tool with no card of its own: its picture (or the tool's sign), its name, a line
 * under it, a badge beside the name and a corner label on the picture (a length). A click opens it; `actions` (the
 * row's own buttons: rename, delete) show over the picture's corner on hover.
 */
export function ItemCard({
  to,
  onClick,
  picture,
  icon: Icon,
  name,
  meta,
  badge,
  corner,
  title,
  actions,
  drag,
}: {
  to?: string;
  onClick?: () => void;
  picture?: string;
  icon: LucideIcon;
  name: ReactNode;
  meta?: ReactNode;
  badge?: ReactNode;
  corner?: ReactNode;
  title?: string;
  actions?: ReactNode;
  /** dragged onto a folder (lib/folders.ts `drag`) */
  drag?: { draggable: boolean; onDragStart: (e: React.DragEvent) => void };
}) {
  const body = (
    <>
      <div className="relative aspect-video overflow-hidden bg-zinc-950">
        <Icon className="absolute inset-0 m-auto h-8 w-8 text-zinc-700" />
        {picture && <Picture src={picture} alt="" className="relative h-full w-full object-cover" />}
        {corner && <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] tabular-nums text-white">{corner}</span>}
      </div>
      <div className="flex items-start gap-2 px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-zinc-100">{name}</p>
          {meta && <p className="mt-1 truncate text-xs text-zinc-500">{meta}</p>}
        </div>
        {badge}
      </div>
    </>
  );
  const box = "block w-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50 text-left transition-colors hover:border-violet-500/60";
  const card = to ? (
    <Link to={to} title={title} className={box} {...drag}>
      {body}
    </Link>
  ) : (
    <button type="button" onClick={onClick} title={title} className={box} {...drag}>
      {body}
    </button>
  );
  if (!actions) return card;
  return (
    <div className="group relative">
      {card}
      <div className="absolute right-1.5 top-1.5 flex gap-1 rounded-md bg-black/60 p-0.5 text-white opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        {actions}
      </div>
    </div>
  );
}
