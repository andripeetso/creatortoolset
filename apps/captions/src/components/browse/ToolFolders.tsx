import { Fragment } from "react";
import { Link } from "react-router";
import { ChevronRight, FolderInput } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ToolFoldersState } from "@/lib/folders";
import { FolderCard, FolderRow } from "./Folder";

/** The folders on screen as cards: their pictures from inside, their count, items dropped on one go in. */
export function ToolFolderCards({ state, pictureOf }: { state: ToolFoldersState; pictureOf: (id: string) => string | undefined }) {
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
          meta={state.countOf(f.id)}
          drop={{ type: state.dragType, onItems: (ids) => void state.move(ids, f.id), label: "Move into this folder" }}
          onRename={() => void state.rename(f)}
          onDelete={() => void state.remove(f)}
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
          meta={state.countOf(f.id)}
          drop={{ type: state.dragType, onItems: (ids) => void state.move(ids, f.id), label: "Move into this folder" }}
          onRename={() => void state.rename(f)}
          onDelete={() => void state.remove(f)}
        />
      ))}
    </>
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
