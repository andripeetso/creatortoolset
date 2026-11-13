import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Pencil, PenTool, Plus, Trash2 } from "lucide-react";
import type { DesignSummary } from "@contracts/design";
import { AppBar, ToolIntro } from "@/components/AppBar";
import { BrowseBar, NewFolderButton } from "@/components/browse/Bar";
import { askRename } from "@/components/browse/browse";
import { FolderGrid } from "@/components/browse/Grid";
import { ListRow, RowLink } from "@/components/browse/List";
import { FolderTrail, MoveToMenu, ToolFolderCards, ToolFolderRows } from "@/components/browse/ToolFolders";
import { byName, matches, persistSort, storedSort, useBrowseView } from "@/components/browse/views";
import { DesignThumb } from "@/components/design/DesignThumb";
import { Button } from "@/components/ui/button";
import { createDesign, deleteDesign, listDesigns, saveDesign } from "@/lib/designs";
import { confirmDialog } from "@/lib/dialogs";
import { timeAgo } from "@/lib/exports";
import { useToolFolders } from "@/lib/folders";
import { onTopic } from "@/lib/sync";

/**
 * The Designer's start (/design): every design of this account, in the person's own folders, as cards or rows, found
 * by a search and sorted newest first or by name (the same browser as the other tools' start screens:
 * components/browse). Each opens in the designer (/design/:id). New canvas makes an empty canvas (its frames are made
 * on it: the frame tool offers the picture sizes), in the folder that is open. A carousel piece's design is started
 * from the piece (Design, beside Visualize in the Content Workshop), a cover from a video in Finals: both are listed
 * here too. A design made or changed somewhere else (the assistant, another window) shows without a reload.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const madeFrom = (d: DesignSummary) => (!d.from ? "" : "session" in d.from ? "From a Workshop carousel" : "From a video");
const framesOf = (d: DesignSummary) => (d.pages ? `${d.pages} ${d.pages === 1 ? "frame" : "frames"}` : "No frames yet");
const SORTS = ["recent", "name"] as const;
const SORT_KEY = "design:sort";
/** Every card's picture box, width over height: a frame of any shape (a tall cover, a wide thumbnail) is fitted inside it. */
const TILE = 1;

export default function DesignsPage() {
  const navigate = useNavigate();
  const [designs, setDesigns] = useState<DesignSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useBrowseView("design");
  const [find, setFind] = useState("");
  const [sort, setSort] = useState(() => storedSort(SORT_KEY, SORTS));

  const load = useCallback(() => listDesigns().then((all) => (setDesigns(all), setError(null)), (e) => setError(message(e))), []);
  useEffect(() => {
    void load();
    // this window's own changes too: a rename or a delete here is shown from what the server kept
    return onTopic("designs", () => void load(), { own: true });
  }, [load]);

  // the open folder's designs (every folder's when searching); the server sends them newest change first
  const folders = useToolFolders("design", designs ?? [], find);
  const listed = folders.here.filter((d) => matches(find, d.name, madeFrom(d))).sort((a, b) => (sort === "name" ? byName(a, b) : 0));

  const start = async () => {
    try {
      // an empty canvas: no frame yet (the size is only what a frame made by a click starts as)
      const d = await createDesign({ format: "portrait", blank: true, pages: 0, name: "Untitled canvas" });
      // made with a folder open: it is in that folder
      if (folders.open) await folders.move([d.id], folders.open, false).catch(() => {});
      navigate(`/design/${d.id}`);
    } catch (e) {
      setError(message(e));
    }
  };
  const rename = async (d: DesignSummary) => {
    const name = await askRename("Rename", d.name);
    if (name && name !== d.name) await saveDesign(d.id, { name }).then(load, (e) => setError(message(e)));
  };
  const remove = async (d: DesignSummary) => {
    const yes = await confirmDialog({ title: `Delete “${d.name}”?`, body: "Its frames and the pictures added to it are deleted for good. PNGs you saved stay where you saved them.", ok: "Delete", danger: true });
    if (yes) await deleteDesign(d.id).then(load, (e) => setError(message(e)));
  };
  /** A design's own buttons: move it to a folder, rename it, delete it. `on`: the classes of one button. */
  const actions = (d: DesignSummary, on: string, danger: string) => (
    <>
      <MoveToMenu state={folders} id={d.id} className={on} />
      <button type="button" title="Rename" aria-label={`Rename ${d.name}`} className={on} onClick={() => void rename(d)}>
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="Delete" aria-label={`Delete ${d.name}`} className={danger} onClick={() => void remove(d)}>
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </>
  );

  return (
    <div className="flex min-h-screen flex-col">
      <AppBar tool="Designer">
        {!!designs?.length && <NewFolderButton onClick={() => void folders.newFolder()} />}
        <Button size="sm" onClick={() => void start()}>
          <Plus className="h-4 w-4" />
          New canvas
        </Button>
      </AppBar>
      <div className="mx-auto w-full max-w-6xl flex-1 px-4 pb-10 sm:px-6">
        <ToolIntro icon={PenTool} title="Designer" line="Carousels, covers and thumbnails in layers: your AI designs them, you edit anything and save the PNGs" />
        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}
        {designs?.length === 0 ? (
          <p className="py-16 text-center text-sm text-zinc-500">
            Nothing here yet. New canvas opens an empty canvas; Design on a carousel piece in the <Link to="/workshop" className="underline">Content Workshop</Link> starts from its slides.
          </p>
        ) : (
          designs && (
            <>
              <FolderTrail state={folders} top="Designer" />
              <BrowseBar
                search={{ value: find, onChange: setFind, placeholder: "Search canvases (⌘K)" }}
                sort={{
                  value: sort,
                  onChange: (v) => {
                    setSort(v);
                    persistSort(SORT_KEY, v);
                  },
                  label: "Sort canvases",
                  options: [
                    { id: "recent", label: "Recent" },
                    { id: "name", label: "Name" },
                  ],
                }}
                view={{ value: view, onChange: setView }}
              />
              {find.trim() && listed.length === 0 && folders.folders.length === 0 && <p className="py-10 text-center text-sm text-zinc-500">No matches.</p>}
              {!find.trim() && folders.open && listed.length === 0 && folders.folders.length === 0 && <p className="py-10 text-center text-sm text-zinc-500">This folder is empty.</p>}
              {view === "grid" ? (
                <FolderGrid size="small">
                  <ToolFolderCards state={folders} pictureOf={() => undefined} aspect="square" />
                  {listed.map((d) => (
                    <div key={d.id} data-design={d.id} className="group relative">
                      <Link to={`/design/${d.id}`} aria-label={`Open ${d.name}`} {...folders.drag(d.id)} className="block w-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50 text-left transition-colors hover:border-violet-500/60">
                        <div className="relative flex aspect-square items-center justify-center overflow-hidden bg-zinc-950 p-4">
                          <PenTool className="absolute inset-0 m-auto h-8 w-8 text-zinc-700" />
                          <div className="relative flex h-full w-full items-center justify-center">
                            <DesignThumb id={d.id} stamp={d.updatedAt} width={d.width} height={d.height} tile={TILE} />
                          </div>
                        </div>
                        <div className="px-3.5 py-3">
                          <p className="truncate text-sm font-medium text-zinc-100">{d.name}</p>
                          <p className="mt-1 truncate text-xs text-zinc-500">
                            {framesOf(d)} · {timeAgo(d.updatedAt)}
                            {madeFrom(d) && ` · ${madeFrom(d)}`}
                          </p>
                        </div>
                      </Link>
                      <div className="absolute right-1.5 top-1.5 flex gap-1 rounded-md bg-black/60 p-0.5 text-white opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        {actions(d, "rounded p-1 hover:bg-white/20", "rounded p-1 hover:bg-red-600")}
                      </div>
                    </div>
                  ))}
                </FolderGrid>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <ToolFolderRows state={folders} />
                  {listed.map((d) => (
                    <div key={d.id} data-design={d.id} {...folders.drag(d.id)}>
                      <ListRow>
                        <RowLink to={`/design/${d.id}`}>
                          <PenTool className="h-4 w-4 shrink-0 text-zinc-500" />
                          <span className="min-w-0 flex-1 truncate text-sm text-zinc-100">{d.name}</span>
                          {madeFrom(d) && <span className="hidden shrink-0 text-[11px] text-zinc-500 sm:inline">{madeFrom(d)}</span>}
                          <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">
                            {framesOf(d)} · {timeAgo(d.updatedAt)}
                          </span>
                        </RowLink>
                        <span className="flex shrink-0 gap-0.5 text-zinc-600 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
                          {actions(d, "rounded p-1.5 hover:bg-zinc-800 hover:text-zinc-200", "rounded p-1.5 hover:bg-zinc-800 hover:text-red-400")}
                        </span>
                      </ListRow>
                    </div>
                  ))}
                </div>
              )}
            </>
          )
        )}
      </div>
    </div>
  );
}
