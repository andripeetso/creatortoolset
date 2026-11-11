import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Folder as FolderIcon, Trash2, type LucideIcon } from "lucide-react";
import { Picture } from "@/components/Picture";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

/**
 * A folder, the same in every tool: a card in the folders view (a mosaic of up to four pictures from inside it) or a
 * row in the list view. Click opens it; drop items or files on it; right-click for Open, Rename…, the tool's own
 * items, and Delete. The tool keeps its data: what is inside, what a drop does, what deleting takes with it.
 */
export interface FolderProps {
  name: string;
  /** Where opening it goes. */
  to: string;
  /** Right of the name: "4 videos · 1 finished", a date and a count. */
  meta?: ReactNode;
  /** What can be dropped on it, and what the drop does. Leave it out and nothing can be. */
  drop?: FolderDrop;
  onRename?: () => void;
  onDelete?: () => void;
  /** The Delete item's words ("Delete project"). */
  deleteLabel?: string;
  /** The tool's own menu items, after Rename (ContextMenuItem). */
  menu?: ReactNode;
  /** Its sign in place of the folder (a saved search's magnifier). */
  icon?: LucideIcon;
}

export interface FolderDrop {
  /** The dataTransfer type the tool's item cards set when dragged; its value is their ids joined by ",". A drop with
   *  neither that nor files does nothing. */
  type: string;
  /** Items dragged from the page onto it. */
  onItems: (ids: string[]) => void;
  /** Files from the computer dropped on it; leave it out and file drops pass through to the page. */
  onFiles?: (files: File[]) => void;
  /** Shown over it while something is held above it ("Move 3 videos into this project"). */
  label: string;
  /** False: nothing may be dropped right now (a viewer who can't change it). */
  enabled?: boolean;
}

/** dragleave also fires when the pointer moves onto a child: only leaving the element itself counts. */
const leftFor = (e: React.DragEvent) => !e.currentTarget.contains(e.relatedTarget as Node | null);

/** A drop target's handlers and whether something is held above it. */
function useFolderDrop(drop?: FolderDrop) {
  const [over, setOver] = useState(false);
  if (!drop || drop.enabled === false) return { over: false, handlers: {} };
  // every drag but files it can't take (those fall through to the page): a browser may not list a page's own drag type
  // until the drop, so the type is read there
  const ours = (e: React.DragEvent) => !!drop.onFiles || !e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes(drop.type);
  return {
    over,
    handlers: {
      onDragOver: (e: React.DragEvent) => {
        if (!ours(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      },
      onDragLeave: (e: React.DragEvent) => leftFor(e) && setOver(false),
      onDrop: (e: React.DragEvent) => {
        if (!ours(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const ids = e.dataTransfer.getData(drop.type);
        if (ids) drop.onItems(ids.split(","));
        else drop.onFiles?.([...e.dataTransfer.files]);
      },
    },
  };
}

/** Its right-click menu, around the card or the row. */
function FolderMenu({ to, onRename, onDelete, deleteLabel = "Delete folder", menu, children }: FolderProps & { children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem asChild>
          <Link to={to}>Open</Link>
        </ContextMenuItem>
        {onRename && <ContextMenuItem onClick={onRename}>Rename…</ContextMenuItem>}
        {menu}
        {onDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem className="text-red-400" onClick={onDelete}>
              <Trash2 /> {deleteLabel}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export interface Cover {
  src: string;
  /** Stays the same while its picture changes (a new version): the picture is not drawn again. Default: src. */
  key?: string;
  /** Not to show yet (a page that reveals its pictures top to bottom); it keeps its place. */
  hidden?: boolean;
}

/** The folders view's folder: a 2×2 mosaic of `covers` (up to four), its name and `meta`. */
export function FolderCard({ covers, aspect = "video", ...p }: FolderProps & { covers: Cover[]; aspect?: "video" | "portrait" }) {
  const { over, handlers } = useFolderDrop(p.drop);
  const shown = covers.slice(0, 4);
  const Icon = p.icon ?? FolderIcon;
  return (
    <FolderMenu {...p}>
      <Link
        to={p.to}
        draggable={false}
        {...handlers}
        className={cn(
          "group overflow-hidden rounded-xl border bg-zinc-900/50 transition-colors hover:border-violet-500/60",
          over ? "border-violet-500 ring-2 ring-violet-500/40" : "border-zinc-800",
        )}
      >
        <div className={cn("relative overflow-hidden bg-zinc-950", aspect === "video" ? "aspect-video" : "aspect-[4/5]")}>
          {shown.length > 0 ? (
            // fixed rows: a tall (9:16) picture must not grow past the box
            <div
              className={cn(
                "absolute inset-0 grid gap-px",
                shown.length > 1 ? "grid-cols-2" : "grid-cols-1",
                shown.length > 2 ? "grid-rows-2" : "grid-rows-1",
              )}
            >
              {shown.map((c) => (
                <Picture key={c.key ?? c.src} src={c.src} alt="" className="h-full min-h-0 w-full object-cover" style={c.hidden ? { opacity: 0 } : undefined} />
              ))}
            </div>
          ) : (
            <Icon className="absolute inset-0 m-auto h-10 w-10 text-zinc-700" />
          )}
          {over && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-violet-950/70 text-sm font-medium">
              {p.drop?.label}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 px-3.5 py-3">
          <Icon className="h-4 w-4 shrink-0 text-violet-400" />
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100">{p.name}</p>
          {p.meta !== undefined && <span className="text-xs tabular-nums text-zinc-500">{p.meta}</span>}
        </div>
      </Link>
    </FolderMenu>
  );
}

/** The list view's folder: one row, the same menu and drops as its card. */
export function FolderRow(p: FolderProps) {
  const { over, handlers } = useFolderDrop(p.drop);
  const Icon = p.icon ?? FolderIcon;
  return (
    <FolderMenu {...p}>
      <Link
        to={p.to}
        draggable={false}
        {...handlers}
        className={cn(
          "flex items-center gap-2.5 rounded-lg border px-3 py-2.5 transition-colors hover:border-violet-500/50",
          over ? "border-violet-500 bg-violet-500/10" : "border-zinc-800 bg-zinc-900/50",
        )}
      >
        <Icon className="h-4 w-4 shrink-0 text-violet-400" />
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-100">{over ? p.drop?.label : p.name}</span>
        {p.meta !== undefined && <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">{p.meta}</span>}
      </Link>
    </FolderMenu>
  );
}
