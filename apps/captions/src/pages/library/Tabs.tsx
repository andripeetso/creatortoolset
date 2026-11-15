import { useState, type ReactNode } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { DRAG } from "./moves";

/**
 * The tabs across the top of the grid (LibraryPage.tsx): All, A-roll, B-roll, Photos, then the top-level folders, each
 * with its count. A tab opens what it names; clips dragged from the grid drop on it (filed as that roll, or moved into
 * that folder); a folder's tab has the folder's right-click menu.
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
}

export function LibraryTabs({ tabs }: { tabs: Tab[] }) {
  return (
    // its own sideways scroll on a narrow screen; the page never scrolls sideways
    <nav aria-label="Library tabs" className="flex min-w-0 gap-1 overflow-x-auto border-b border-zinc-500/20 [scrollbar-width:none]">
      {tabs.map((t) => (
        <TabButton key={t.id} tab={t} />
      ))}
    </nav>
  );
}

function TabButton({ tab: t }: { tab: Tab }) {
  const [over, setOver] = useState(false);
  const drops = t.onItems
    ? {
        onDragOver: (e: React.DragEvent) => {
          // a page's own drag type may only be listed at the drop (some browsers): files are the page's, the rest are ours
          if (e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes(DRAG)) return;
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        },
        onDragLeave: (e: React.DragEvent) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false),
        onDrop: (e: React.DragEvent) => {
          const ids = e.dataTransfer.getData(DRAG);
          setOver(false);
          if (!ids) return;
          e.preventDefault();
          e.stopPropagation();
          t.onItems!(ids.split(","));
        },
      }
    : {};
  const button = (
    <button
      type="button"
      onClick={t.onOpen}
      aria-current={t.active ? "page" : undefined}
      data-tab={t.id}
      {...drops}
      className={cn(
        "-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-md border-b-2 px-2.5 py-2 text-sm transition-colors",
        t.active ? "border-violet-500 font-medium text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-200",
        over && "bg-violet-500/15 text-zinc-100",
      )}
    >
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
