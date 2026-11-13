import { Fragment } from "react";
import { Link } from "react-router";
import { ChevronRight, FolderInput, Link2, Share2 } from "lucide-react";
import type { ToolFolder } from "@contracts/folders";
import { Button } from "@/components/ui/button";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ToolFoldersState } from "@/lib/folders";
import { FolderCard, FolderRow } from "./Folder";

/** The folders on screen as cards: their pictures from inside, their count, items dropped on one go in. `aspect`: the picture box's shape, when the tool's own cards are not 16:9. */
export function ToolFolderCards({ state, pictureOf, aspect }: { state: ToolFoldersState; pictureOf: (id: string) => string | undefined; aspect?: "video" | "portrait" | "square" }) {
  return (
    <>
      {state.folders.map((f) => (
        <FolderCard
          key={f.id}
          name={f.name}
          to={state.to(f.id)}
          covers={state
            .inside(f.id)
            .map((i) => pictureOf(i.id))
            .filter((src): src is string => !!src)
            .slice(0, 4)
            .map((src) => ({ src }))}
          aspect={aspect}
          meta={<FolderMeta state={state} f={f} />}
          drop={{ type: state.dragType, onItems: (ids) => void state.move(ids, f.id), label: "Move into this folder" }}
          onRename={() => void state.rename(f)}
          onDelete={() => void state.remove(f)}
          menu={<ShareItems state={state} f={f} />}
        />
      ))}
    </>
  );
}

/** The folders on screen as rows, the same menu and drops. */
export function ToolFolderRows({ state }: { state: ToolFoldersState }) {
  return (
    <>
      {state.folders.map((f) => (
        <FolderRow
          key={f.id}
          name={f.name}
          to={state.to(f.id)}
          meta={<FolderMeta state={state} f={f} />}
          drop={{ type: state.dragType, onItems: (ids) => void state.move(ids, f.id), label: "Move into this folder" }}
          onRename={() => void state.rename(f)}
          onDelete={() => void state.remove(f)}
          menu={<ShareItems state={state} f={f} />}
        />
      ))}
    </>
  );
}

/** Its count, and a link sign while it is shared. */
function FolderMeta({ state, f }: { state: ToolFoldersState; f: ToolFolder }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {f.share && <Link2 className="h-3.5 w-3.5 text-violet-400" aria-label="Shared by link" />}
      {state.countOf(f.id)}
    </span>
  );
}

/** A folder's right-click: share it by link, and turn the link off. */
function ShareItems({ state, f }: { state: ToolFoldersState; f: ToolFolder }) {
  if (!state.shareable) return null;
  return (
    <>
      <ContextMenuItem onClick={() => void state.share(f)}>{f.share ? "Copy share link" : "Share…"}</ContextMenuItem>
      {f.share && <ContextMenuItem onClick={() => void state.unshare(f)}>Stop sharing</ContextMenuItem>}
    </>
  );
}

/** Inside a folder that can be shared: Share (copies its link), and Stop sharing while it is. */
export function FolderShareButton({ state }: { state: ToolFoldersState }) {
  const f = state.trail.at(-1) as ToolFolder | undefined;
  if (!state.shareable || !f) return null;
  return (
    <div className="flex items-center gap-1">
      {f.share && (
        <button type="button" onClick={() => void state.unshare(f)} className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
          Stop sharing
        </button>
      )}
      <Button size="sm" onClick={() => void state.share(f)} className="h-8 bg-violet-600 text-white hover:bg-violet-500">
        {f.share ? <Link2 /> : <Share2 />} {f.share ? "Copy link" : "Share folder"}
      </Button>
    </div>
  );
}

/** Inside a folder: the way back up, the top first. */
export function FolderTrail({ state, top }: { state: Pick<ToolFoldersState, "open" | "to"> & { trail: { id: string; name: string }[] }; top: string }) {
  if (!state.open) return null;
  const up = state.trail.slice(0, -1);
  return (
    <nav aria-label="Folder" className="mb-3 flex min-w-0 flex-wrap items-center gap-1 text-sm">
      <Link to={state.to(null)} className="rounded px-1 text-zinc-500 hover:text-zinc-200">
        {top}
      </Link>
      {up.map((f) => (
        <Fragment key={f.id}>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
          <Link to={state.to(f.id)} className="truncate rounded px-1 text-zinc-500 hover:text-zinc-200">
            {f.name}
          </Link>
        </Fragment>
      ))}
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
      <span className="truncate px-1 font-medium text-zinc-200">{state.trail.at(-1)?.name}</span>
    </nav>
  );
}

/** "Move to" on an item: the top level and every folder, each under its parent. Nothing when there is nowhere to go. */
export function MoveToMenu({ state, id, className }: { state: ToolFoldersState; id: string; className?: string }) {
  const options = state.options(state.folderOf(id));
  if (!options.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" title="Move to" aria-label="Move to a folder" onClick={(e) => e.stopPropagation()} className={className}>
          <FolderInput className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
        {options.map((o) => (
          <DropdownMenuItem key={o.id ?? "top"} onSelect={() => void state.move([id], o.id)} style={{ paddingLeft: `${0.5 + o.depth}rem` }}>
            {o.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
