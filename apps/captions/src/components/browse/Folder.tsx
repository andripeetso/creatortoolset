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

/** The folders view's folder: a 2×2 mosaic of `covers` (up to four), its name and `meta`. With no pictures, `lines`
 *  (a few of the files in it by name, songs say) under its sign. */
export function FolderCard({ covers, lines, aspect = "video", ...p }: FolderProps & { covers: Cover[]; lines?: string[]; aspect?: "video" | "portrait" | "square" }) {
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
        <div className={cn("relative overflow-hidden bg-zinc-950", aspect === "video" ? "aspect-video" : aspect === "square" ? "aspect-square" : "aspect-[4/5]")}>
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
          ) : lines?.length ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4">
              <Icon className="h-8 w-8 shrink-0 text-zinc-600" />
              <ul className="w-full max-w-full text-center text-xs text-zinc-500">
                {lines.map((l, i) => (
                  <li key={i} className="truncate">
                    {l}
                  </li>
                ))}
              </ul>
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

/** One line of a folder sidebar: the folder's own menu and drops, `depth` for the indent, `on` while it is open. */
export type SidebarFolder = FolderProps & { id: string; depth: number; on: boolean };

/**
 * The folders as a sidebar, the same in every tool: the top level first (`top`: "All edits"), then each folder under
 * its parent with its count. The open one is lit; items dropped on a line go into it, on the top line out of every folder.
 */
export function FolderSidebar({ top, folders, label = "Folders" }: { top: Omit<SidebarFolder, "id" | "depth">; folders: SidebarFolder[]; label?: string }) {
  return (
    <nav aria-label={label} className="flex flex-col gap-0.5">
      <SidebarLine {...top} depth={0} />
      {folders.map((f) => (
        <FolderMenu key={f.id} {...f}>
          <SidebarLine name={f.name} to={f.to} meta={f.meta} drop={f.drop} depth={f.depth} on={f.on} icon={f.icon} />
        </FolderMenu>
      ))}
    </nav>
  );
}

/** `menu`: what the right-click menu's trigger hands its child (its handlers and ref), passed on to the link. */
function SidebarLine({ name, to, meta, drop, depth, on, icon, ...menu }: Pick<SidebarFolder, "name" | "to" | "meta" | "drop" | "depth" | "on" | "icon"> & React.HTMLAttributes<HTMLAnchorElement>) {
  const { over, handlers } = useFolderDrop(drop);
  const Icon = icon ?? FolderIcon;
  return (
    <Link
      {...menu}
      to={to}
      draggable={false}
      {...handlers}
      aria-current={on ? "page" : undefined}
      style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
      className={cn(
        "flex h-8 items-center gap-2 rounded-md pr-2 text-[13px] transition-colors",
        over ? "bg-violet-500/15 text-zinc-100 ring-1 ring-violet-500" : on ? "bg-zinc-500/15 font-medium text-zinc-100" : "text-zinc-400 hover:bg-zinc-500/10 hover:text-zinc-200",
      )}
    >
      <Icon className={cn("h-4 w-4 shrink-0", on ? "text-violet-400" : "text-zinc-500")} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {meta !== undefined && <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">{meta}</span>}
    </Link>
  );
}
