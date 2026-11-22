import { useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { DRAG } from "./moves";

/**
 * The tabs across the top of the grid (LibraryPage.tsx): All, A-roll, B-roll, Photos, then the top-level folders, each
 * with its count. A tab opens what it names; clips dragged from the grid drop on it (filed as that roll, or moved into
 * that folder); a folder's tab has the folder's right-click menu. The `movable` tabs (the top-level folders) are dragged
 * along the row into another order: a line shows where the tab lands, and no tab moves until it is dropped.
 */
export interface Tab {
  id: string;
  label: string;
  count?: number;
  active: boolean;
  onOpen: () => void;
  /** clips dropped on it; leave it out and nothing drops */
  onItems?: (ids: string[]) => void;
  /** its right-click menu (ContextMenuItem) */
  menu?: ReactNode;
  /** dragged along the row into another order (LibraryTabs' onReorder) */
  movable?: boolean;
  /** its sign before the name (an automatic folder's) */
  icon?: LucideIcon;
}

type Mark = { id: string; after: boolean };

/** Where `from` goes when dropped before or after `target`, among the movable ids; null: nothing changes */
export function reordered(ids: string[], from: string, target: string, after: boolean): string[] | null {
  if (from === target || !ids.includes(from) || !ids.includes(target)) return null;
  const rest = ids.filter((id) => id !== from);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  const next = [...rest.slice(0, at), from, ...rest.slice(at)];
  return next.join() === ids.join() ? null : next;
}

/** `onReorder`: the movable tabs' ids in their new order; `menu`: the row's own right-click menu, for the space between tabs */
export function LibraryTabs({ tabs, onReorder, menu }: { tabs: Tab[]; onReorder?: (ids: string[]) => void; menu?: ReactNode }) {
  // the tab being moved: a ref, since some browsers list a page's own drag type only at the drop
  const moving = useRef<string | null>(null);
  const [mark, setMark] = useState<Mark | null>(null);
  const movable = onReorder ? tabs.filter((t) => t.movable).map((t) => t.id) : [];
  const end = () => {
    moving.current = null;
    setMark(null);
  };
  const row = (
    // its own sideways scroll on a narrow screen; the page never scrolls sideways
    <nav aria-label="Library tabs" className="flex min-w-0 gap-1 overflow-x-auto border-b border-zinc-500/20 [scrollbar-width:none]">
      {tabs.map((t) => (
        <TabButton
          key={t.id}
          tab={t}
          moving={moving}
          line={mark?.id === t.id ? mark : undefined}
          move={
            movable.includes(t.id)
              ? {
                  start: () => (moving.current = t.id),
                  end,
                  over: (after) => (mark?.id !== t.id || mark.after !== after) && setMark({ id: t.id, after }),
                  drop: (after) => {
                    const next = moving.current && reordered(movable, moving.current, t.id, after);
                    end();
                    if (next) onReorder!(next);
                  },
                }
              : undefined
          }
        />
      ))}
    </nav>
  );
  if (!menu) return row;
  // a tab's own menu is opened first, and this one is then left closed (Radix skips a handled right-click)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">{menu}</ContextMenuContent>
    </ContextMenu>
  );
}

interface Move {
  start: () => void;
  end: () => void;
  over: (after: boolean) => void;
  drop: (after: boolean) => void;
}

function TabButton({ tab: t, moving, move, line }: { tab: Tab; moving: React.RefObject<string | null>; move?: Move; line?: Mark }) {
  const [over, setOver] = useState(false);
  const afterHalf = (e: React.DragEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientX > r.left + r.width / 2;
  };
  const button = (
    <button
      type="button"
      onClick={t.onOpen}
      aria-current={t.active ? "page" : undefined}
      data-tab={t.id}
      draggable={!!move}
      onDragStart={
        move &&
        ((e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", t.label); // a drag needs some data in Firefox
          move.start();
        })
      }
      onDragEnd={move?.end}
      onDragOver={(e) => {
        if (moving.current) {
          // a tab being moved: only another movable tab takes it
          if (!move) return;
          e.preventDefault();
          move.over(afterHalf(e));
          return;
        }
        // a page's own drag type may only be listed at the drop (some browsers): files are the page's, the rest are ours
        if (!t.onItems || (e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes(DRAG))) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
      onDrop={(e) => {
        if (moving.current) {
          if (!move) return;
          e.preventDefault();
          move.drop(afterHalf(e));
          return;
        }
        const ids = e.dataTransfer.getData(DRAG);
        setOver(false);
        if (!ids || !t.onItems) return;
        e.preventDefault();
        e.stopPropagation();
        t.onItems(ids.split(","));
      }}
      className={cn(
        "relative -mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-md border-b-2 px-2.5 py-2 text-sm transition-colors",
        t.active ? "border-violet-500 font-medium text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-200",
        over && "bg-violet-500/15 text-zinc-100",
      )}
    >
      {line && <span aria-hidden className={cn("pointer-events-none absolute inset-y-1.5 w-0.5 rounded bg-violet-500", line.after ? "right-0" : "left-0")} />}
      {t.icon && <t.icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-violet-400" />}
      {t.label}
      {t.count !== undefined && <span className="tabular-nums text-xs text-zinc-500">{t.count.toLocaleString()}</span>}
    </button>
  );
  if (!t.menu) return button;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">{t.menu}</ContextMenuContent>
    </ContextMenu>
  );
}
