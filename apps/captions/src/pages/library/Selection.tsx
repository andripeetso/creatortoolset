import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Check, Download, Folder, RefreshCw, RotateCcw, Tag, Trash2, X } from "lucide-react";
import type { AssetCard, LibrarySummary } from "@contracts/library";
import { isPickClick } from "@/components/browse/browse";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { promptDialog } from "@/lib/dialogs";
import { cn } from "@/lib/utils";
import { revealClip, servedHere } from "./clip";

/**
 * Picking several clips in the Media Library (LibraryPage.tsx), as Review picks videos: a plain click still opens a clip,
 * ⌘/Ctrl-click adds or drops one, Shift-click adds the run from the last pick, ⌘A picks all shown (grid.ts). The picks
 * belong to the view they were made in, and a plain click anywhere but a clip, the bar or a menu lets go of them. The
 * bar acts on all of them; right-click acts on one clip (on all picked when it is one of them).
 */

const NONE = new Set<string>();

export function usePicks(at: string, order: string[]) {
  const [sel, setSel] = useState<{ at: string; ids: Set<string>; anchor?: string }>({ at, ids: NONE });
  const picked = sel.at === at ? sel.ids : NONE;
  const clear = () => setSel({ at, ids: NONE });
  /** A modifier click: `range` (Shift) adds the run from the last pick, else this one is added or dropped. */
  const pick = (id: string, range: boolean) =>
    setSel((s) => {
      const cur = s.at === at ? s : { at, ids: NONE };
      const from = cur.anchor ? order.indexOf(cur.anchor) : -1;
      const to = order.indexOf(id);
      const ids = new Set(cur.ids);
      if (range && from >= 0 && to >= 0) for (const x of order.slice(Math.min(from, to), Math.max(from, to) + 1)) ids.add(x);
      else if (!range && ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { at, ids, anchor: range && from >= 0 ? cur.anchor : id };
    });
  const set = (ids: string[]) => setSel({ at, ids: new Set(ids) });
  const some = picked.size > 0;
  useEffect(() => {
    if (!some) return;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || isPickClick(e)) return;
      const keep = (e.target as Element).closest?.('[data-keep-picked], [role="menu"], [role="dialog"], [role="alertdialog"], [data-sonner-toaster]');
      if (!keep) setSel((s) => ({ ...s, ids: NONE, anchor: undefined }));
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [some]);
  return { picked, pick, set, clear };
}

/**
 * A clip's card or row (ClipCards.tsx) made pickable: a modifier click picks it instead of opening it, a picked one is
 * ringed and ticked, right-click opens `menu`. Without `onPick` (a plug-in source's item) it is only the card.
 */
export function ClipPick({ picked, onPick, menu, row, children }: { picked: boolean; onPick?: (range: boolean) => void; menu?: ReactNode; row?: boolean; children: ReactNode }) {
  const body = (
    <div
      data-keep-picked
      data-picked={picked || undefined}
      className="relative min-w-0"
      onMouseDown={(e) => onPick && isPickClick(e) && e.preventDefault()} // a pick never selects text
      onClickCapture={(e) => {
        if (!onPick || !isPickClick(e)) return;
        e.preventDefault();
        e.stopPropagation(); // not the card's own click: it would open the clip
        onPick(e.shiftKey);
      }}
    >
      {children}
      {picked && (
        <>
          <span aria-hidden className={cn("pointer-events-none absolute ring-2 ring-violet-500", row ? "inset-0 rounded-lg" : "-inset-1 rounded-xl")} />
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute z-10 flex items-center justify-center rounded-full bg-violet-600 text-white shadow",
              row ? "left-1.5 top-1.5 h-4 w-4" : "left-2 top-2 h-5 w-5",
            )}
          >
            <Check className={row ? "h-3 w-3" : "h-3.5 w-3.5"} />
          </span>
        </>
      )}
    </div>
  );
  if (!menu) return body;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{body}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">{menu}</ContextMenuContent>
    </ContextMenu>
  );
}

export type MoveTarget = { id: string | null; name: string; depth: number };

/** What can be made again on clips (api/library/bulk.ts); search data only while search by meaning is on (it reads nothing else). */
export const redoKinds = (settings: LibrarySummary["settings"]) => [
  { kind: "describe", label: "Descriptions" },
  ...(settings.look ? [{ kind: "look", label: "Shot descriptions" }] : []),
  { kind: "transcribe", label: "Transcripts" },
  ...(settings.embed ? [{ kind: "embed", label: "Search data" }] : []),
];

type Item = ComponentType<{ onSelect?: (e: Event) => void; className?: string; children?: ReactNode; style?: React.CSSProperties }>;

/** The library's most used tags, then New tag…: the same in the right-click menu and the bar. */
function TagChoices({ tags, onTag, Item }: { tags: string[]; onTag: (tag: string) => void; Item: Item }) {
  return (
    <>
      {tags.slice(0, 8).map((t) => (
        <Item key={t} onSelect={() => onTag(t)}>
          <Tag /> {t}
        </Item>
      ))}
      <Item
        onSelect={() =>
          void promptDialog({ title: "Add tag", ok: "Add" }).then((t) => {
            const tag = t?.trim().slice(0, 80);
            if (tag) onTag(tag);
          })
        }
      >
        New tag…
      </Item>
    </>
  );
}

function MoveChoices({ to, onMove, Item }: { to: MoveTarget[]; onMove: (id: string | null) => void; Item: Item }) {
  return to.map((f) => (
    <Item key={f.id ?? "top"} onSelect={() => onMove(f.id)} style={{ paddingLeft: `${0.5 + f.depth * 0.75}rem` }}>
      <Folder /> {f.name}
    </Item>
  ));
}

export interface ClipMoves {
  open: () => void;
  share: () => void;
  download: () => void;
  copyLink: () => void;
  move: (to: string | null) => void;
  tag: (tag: string) => void;
  trash: () => void;
  restore: () => void;
}

/** One clip's right-click menu. `extra` goes after Copy link (Show in Finder, where the Mac app can). */
export function ClipMenu({
  inTrash,
  readOnly,
  moveTo,
  tags,
  on,
  extra,
}: {
  inTrash: boolean;
  /** someone else's library to look at: open, download, copy the link */
  readOnly?: boolean;
  moveTo: MoveTarget[];
  tags: string[];
  on: ClipMoves;
  extra?: ReactNode;
}) {
  if (readOnly)
    return (
      <>
        <ContextMenuItem onSelect={on.open}>Open</ContextMenuItem>
        <ContextMenuItem onSelect={on.download}>Download</ContextMenuItem>
        <ContextMenuItem onSelect={on.copyLink}>Copy link</ContextMenuItem>
        {extra}
      </>
    );
  if (inTrash)
    return (
      <>
        <ContextMenuItem onSelect={on.open}>Open</ContextMenuItem>
        <ContextMenuItem onSelect={on.download}>Download</ContextMenuItem>
        <ContextMenuItem onSelect={on.restore}>Restore</ContextMenuItem>
      </>
    );
  return (
    <>
      <ContextMenuItem onSelect={on.open}>Open</ContextMenuItem>
      <ContextMenuItem onSelect={on.share}>Share…</ContextMenuItem>
      <ContextMenuItem onSelect={on.download}>Download</ContextMenuItem>
      <ContextMenuItem onSelect={on.copyLink}>Copy link</ContextMenuItem>
      {extra}
      <ContextMenuSeparator />
      {moveTo.length > 0 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>Move to</ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-80 w-52 overflow-y-auto">
            <MoveChoices to={moveTo} onMove={on.move} Item={ContextMenuItem} />
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      <ContextMenuSub>
        <ContextMenuSubTrigger>Add tag</ContextMenuSubTrigger>
        <ContextMenuSubContent className="max-h-80 w-52 overflow-y-auto">
          <TagChoices tags={tags} onTag={on.tag} Item={ContextMenuItem} />
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuItem className="text-red-400" onSelect={on.trash}>
        <Trash2 /> Move to trash
      </ContextMenuItem>
    </>
  );
}

const barButton = "h-8 gap-1.5 px-2.5";
// the bar's menus are not modal: New tag… opens a question while its menu is still fading out, and a modal menu's lock
// on the page can then outlive both and leave the page unclickable

/** The bar for the picked clips, at the foot of the page, apart from any one clip's buttons. */
export function PickBar({
  count,
  inTrash,
  readOnly,
  moveTo,
  tags,
  redo,
  on,
}: {
  count: number;
  inTrash: boolean;
  /** someone else's library to look at: Download only (a member never moves, tags or deletes the owner's footage) */
  readOnly?: boolean;
  moveTo: MoveTarget[];
  tags: string[];
  redo: { kind: string; label: string }[];
  on: Omit<ClipMoves, "open" | "share" | "copyLink"> & { redo: (kind: string) => void; clear: () => void };
}) {
  return (
    // on a narrow screen it sits above the assistant's round button while that is in a bottom corner
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 max-md:[html:has(button[data-assistant-dock][data-corner^=b])_&]:bottom-20">
      <div
        data-keep-picked
        role="toolbar"
        aria-label="Selected clips"
        className="pointer-events-auto flex max-w-full items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-950/95 p-1.5 pl-3.5 text-sm text-zinc-100 shadow-2xl"
      >
        <span className="mr-1 shrink-0 tabular-nums text-zinc-300">{count} selected</span>
        {readOnly ? null : inTrash ? (
          <Button size="sm" className={cn(barButton, "bg-violet-600 text-white hover:bg-violet-500")} onClick={on.restore}>
            <RotateCcw /> Restore
          </Button>
        ) : (
          <>
            {moveTo.length > 0 && (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" className={cn(barButton, "bg-violet-600 text-white hover:bg-violet-500")} title="Move to">
                    <Folder /> <span className="hidden sm:inline">Move to</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="center" side="top" className="max-h-80 w-56 overflow-y-auto">
                  <MoveChoices to={moveTo} onMove={on.move} Item={DropdownMenuItem} />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className={barButton} title="Add tag">
                  <Tag /> <span className="hidden sm:inline">Add tag</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" side="top" className="max-h-80 w-56 overflow-y-auto">
                <TagChoices tags={tags} onTag={on.tag} Item={DropdownMenuItem} />
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        <Button size="sm" variant="ghost" className={barButton} title="Download" onClick={on.download}>
          <Download /> <span className="hidden sm:inline">Download</span>
        </Button>
        {!inTrash && !readOnly && (
          <>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className={barButton} title="Redo">
                  <RefreshCw /> <span className="hidden sm:inline">Redo</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" side="top" className="w-48">
                {redo.map((r) => (
                  <DropdownMenuItem key={r.kind} onSelect={() => on.redo(r.kind)}>
                    {r.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" variant="ghost" className={cn(barButton, "text-red-400 hover:text-red-300")} title="Move to trash" aria-label="Move to trash" onClick={on.trash}>
              <Trash2 />
            </Button>
          </>
        )}
        <button
          type="button"
          onClick={on.clear}
          title="Clear selection (Esc)"
          aria-label="Clear selection"
          className="rounded-md p-2 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/** A file to save, as a link with `download` does it. */
export function saveFile(href: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = "";
  document.body.append(a);
  a.click();
  a.remove();
}


/**
 * Show in Finder, in the Mac app. On the server on this Mac every clip has its file here; on a server elsewhere only a
 * clip read in place from a computer's folder, or one whose original this computer has (its place rows, `placeWord`
 * here), can be (apps/mac Reveal.swift): an upload from a phone with no copy here has none, so it is not offered there.
 * Decided from the card, so the menu never changes once open.
 */
export function RevealItem({ libraryId, asset, onProblem }: { libraryId: string; asset: Pick<AssetCard, "id" | "onComputer" | "placeWord">; onProblem: (p: string) => void }) {
  const assetId = asset.id;
  if (!servedHere() && !asset.onComputer && asset.placeWord?.word !== "here") return null;
  return <ContextMenuItem onSelect={() => void revealClip(libraryId, assetId).then((problem) => problem && onProblem(problem))}>Show in Finder</ContextMenuItem>;
}
