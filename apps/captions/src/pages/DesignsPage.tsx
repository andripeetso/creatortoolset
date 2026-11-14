import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Pencil, PenTool, Plus, Trash2 } from "lucide-react";
import { DESIGN_LIMITS, type DesignListed } from "@contracts/design";
import type { AnimationStylesView } from "@contracts/editor-styles";
import { AppBar, ToolIntro } from "@/components/AppBar";
import { BrowseBar, NewFolderButton } from "@/components/browse/Bar";
import { askRename } from "@/components/browse/browse";
import { FolderGrid } from "@/components/browse/Grid";
import { ListRow, RowLink } from "@/components/browse/List";
import { FolderTrail, MoveToMenu, ToolFolderCards, ToolFolderRows } from "@/components/browse/ToolFolders";
import { byName, matches, persistSort, storedSort, useBrowseView } from "@/components/browse/views";
import { DesignThumb } from "@/components/design/DesignThumb";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { showAssistantNotice, useAssistant } from "@/lib/assistant";
import { addPicture, createDesign, deleteDesign, isPicture, listDesigns, pictureFrames, pictureSize, saveDesign } from "@/lib/designs";
import { confirmDialog } from "@/lib/dialogs";
import { listAnimationStyles } from "@/lib/editor";
import { timeAgo } from "@/lib/exports";
import { useToolFolders } from "@/lib/folders";
import { useCachedLoad } from "@/lib/local-cache";
import { onTopic } from "@/lib/sync";
import { useWorkspace } from "@/lib/workspace";
import { AnimationStyles, STYLE_WORDS, type OpenAnimation } from "./editor/AnimationStyles";

/**
 * The Designer's start (/design): every design of this account, in the person's own folders, as cards or rows, found
 * by a search and sorted newest first or by name (the same browser as the other tools' start screens:
 * components/browse). Each opens in the designer (/design/:id). New canvas makes an empty canvas (its frames are made
 * on it: the frame tool offers the picture sizes), in the folder that is open and the brand project the window is in. A
 * carousel piece's design is started from the piece (Design, beside Visualize in the Content Workshop), a cover from a
 * video in Finals: both are listed here too, each with the script or the video it was made from (the script's name
 * opens it), and a search finds a design by that name too. With more than one brand project, each design says which
 * it is in. A design made or changed somewhere else (the assistant, another window) shows without a reload.
 * Pictures dropped on the page start a canvas of their own: a frame each, the picture's size, and it opens.
 *
 * Its second tab (/design?tab=styles) is the person's carousel styles: each a name, their own words and pictures, the
 * looks the Designer's AI designs in (kept as the AI Editor's animation styles are: pages/editor/AnimationStyles.tsx).
 * /design?tab=styles&style=<id> opens one's sheet (the assistant, after it saved one).
 */

/** A first carousel style is set up by talking to the assistant, as a first animation style is (EditorPage's styleChat). */
function carouselChat(): void {
  useAssistant.getState().setQuote(STYLE_WORDS.carousel.new);
  showAssistantNotice({ text: "Describe the carousel style you want, and drop in pictures of carousels you like. Say it your way and I'll set up the style." });
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** What it was made from, in words: by its name while that script or video is there, else only what kind of thing it was. */
const madeFrom = (d: DesignListed) => (!d.from ? "" : "session" in d.from ? (d.madeFrom ? `Script: ${d.madeFrom}` : "From a Workshop carousel") : d.madeFrom ? `Video: ${d.madeFrom}` : "From a video");
const framesOf = (d: DesignListed) => (d.pages ? `${d.pages} ${d.pages === 1 ? "frame" : "frames"}` : "No frames yet");
const SORTS = ["recent", "name"] as const;
const SORT_KEY = "design:sort";
/** Every card's picture box, width over height: a frame of any shape (a tall cover, a wide thumbnail) is fitted inside it. */
const TILE = 1;

export default function DesignsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "styles" ? "styles" : "canvases";
  const styles = useCachedLoad<AnimationStylesView>("/api/designs/styles", () => listAnimationStyles("carousel"), { own: true });
  const [openStyle, setOpenStyle] = useState<OpenAnimation>(null);
  const chat = useAssistant((s) => s.connected);
  // ?tab=styles&style=<id>: that style's sheet, read from the server (what was just saved), then the tab's own address again
  const wanted = tab === "styles" ? params.get("style") : null;
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    const done = () => live && setParams({ tab: "styles" }, { replace: true });
    void listAnimationStyles("carousel").then((v) => {
      const found = v.styles.find((x) => x.id === wanted);
      if (live && found) setOpenStyle(found);
      void styles.refresh();
      done();
    }, done);
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);
  const [designs, setDesigns] = useState<DesignListed[] | null>(null);
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
  const listed = folders.here.filter((d) => matches(find, d.name, madeFrom(d), d.projectName)).sort((a, b) => (sort === "name" ? byName(a, b) : 0));
  // with one brand project its name on every design says nothing
  const projects = useWorkspace((s) => s.projects.length);
  /** What a design is connected to: the script (a link to it) or the video it was made from, and its project. Nothing when it has neither. */
  const connection = (d: DesignListed, className: string) => {
    const from = madeFrom(d);
    const project = projects > 1 ? d.projectName : undefined;
    if (!from && !project) return null;
    return (
      <p data-connection className={className}>
        {d.from && "session" in d.from && d.madeFrom ? (
          <Link to={`/workshop/sessions/${d.from.session}`} className="hover:text-zinc-200 hover:underline">
            {from}
          </Link>
        ) : (
          from
        )}
        {from && project && " · "}
        {project}
      </p>
    );
  };

  const start = async () => {
    try {
      // an empty canvas: no frame yet (the size is only what a frame made by a click starts as)
      const d = await createDesign({ format: "portrait", blank: true, pages: 0, name: "Untitled canvas", project: useWorkspace.getState().currentProjectId ?? undefined });
      // made with a folder open: it is in that folder
      if (folders.open) await folders.move([d.id], folders.open, false).catch(() => {});
      navigate(`/design/${d.id}`);
    } catch (e) {
      setError(message(e));
    }
  };
  /** Pictures dropped on the page: a new canvas named after the first, a frame for each (the picture's size, the picture filling it), opened. */
  const [dropping, setDropping] = useState(false);
  // on the styles tab a picture goes into a style's sheet, never into a new canvas
  const hasFiles = (e: React.DragEvent) => tab === "canvases" && [...e.dataTransfer.types].includes("Files");
  const fromPictures = async (given: readonly File[]) => {
    const files = given.filter(isPicture).slice(0, DESIGN_LIMITS.pages);
    if (!files.length) return setError("Only JPEG, PNG and WebP pictures can start a canvas");
    try {
      const name = files[0]!.name.replace(/\.[^.]+$/, "").trim().slice(0, DESIGN_LIMITS.name) || "Untitled canvas";
      const d = await createDesign({ format: "portrait", blank: true, pages: 0, name, project: useWorkspace.getState().currentProjectId ?? undefined });
      const got: { picture: string; w: number; h: number }[] = [];
      for (const file of files) got.push({ ...(await pictureSize(file)), picture: await addPicture(d.id, file) });
      await saveDesign(d.id, { pages: pictureFrames(got, 0, 0, got.map((_, n) => `p${n + 1}`)) });
      if (folders.open) await folders.move([d.id], folders.open, false).catch(() => {});
      navigate(`/design/${d.id}`);
    } catch (e) {
      setError(message(e));
    }
  };
  const rename = async (d: DesignListed) => {
    const name = await askRename("Rename", d.name);
    if (name && name !== d.name) await saveDesign(d.id, { name }).then(load, (e) => setError(message(e)));
  };
  const remove = async (d: DesignListed) => {
    const yes = await confirmDialog({ title: `Delete “${d.name}”?`, body: "Its frames and the pictures added to it are deleted for good. PNGs you saved stay where you saved them.", ok: "Delete", danger: true });
    if (yes) await deleteDesign(d.id).then(load, (e) => setError(message(e)));
  };
  /** A design's own buttons: move it to a folder, rename it, delete it. `on`: the classes of one button. */
  const actions = (d: DesignListed, on: string, danger: string) => (
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
    <div
      data-dropping={dropping || undefined}
      className={`flex min-h-screen flex-col ${dropping ? "ring-2 ring-inset ring-violet-500" : ""}`}
      // a file held over the page is the page's to take: without this the window would open the file instead
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropping(false)}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDropping(false);
        void fromPictures([...e.dataTransfer.files]);
      }}
    >
      <AppBar tool="Designer">
        {tab === "styles" ? (
          !!styles.data?.styles.length && (
            <Button size="sm" onClick={() => setOpenStyle("new")}>
              <Plus className="h-4 w-4" />
              {STYLE_WORDS.carousel.new}
            </Button>
          )
        ) : (
          <>
            {!!designs?.length && <NewFolderButton onClick={() => void folders.newFolder()} />}
            <Button size="sm" onClick={() => void start()}>
              <Plus className="h-4 w-4" />
              New canvas
            </Button>
          </>
        )}
      </AppBar>
      <div className="mx-auto w-full max-w-6xl flex-1 px-4 pb-10 sm:px-6">
        <ToolIntro icon={PenTool} title="Designer" line="Carousels, covers and thumbnails in layers: your AI designs them, you edit anything and save the PNGs" />
        <Tabs value={tab} onValueChange={(t) => setParams(t === "styles" ? { tab: t } : {})} className="mb-4">
          <TabsList>
            <TabsTrigger value="canvases">Canvases</TabsTrigger>
            <TabsTrigger value="styles">Carousel styles</TabsTrigger>
          </TabsList>
        </Tabs>
        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}
        {tab === "styles" ? (
          <>
            {styles.data && <AnimationStyles kind="carousel" styles={styles.data.styles} open={openStyle} onOpen={setOpenStyle} onChanged={styles.refresh} onChat={chat ? carouselChat : undefined} />}
            {!styles.data && styles.error && <p className="text-sm text-red-400">{styles.error}</p>}
          </>
        ) : designs?.length === 0 ? (
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
                    <div key={d.id} data-design={d.id} className="group relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50 transition-colors hover:border-violet-500/60">
                      <Link to={`/design/${d.id}`} aria-label={`Open ${d.name}`} {...folders.drag(d.id)} className="block w-full text-left">
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
                          </p>
                        </div>
                      </Link>
                      {connection(d, "-mt-2 truncate px-3.5 pb-3 text-xs text-zinc-500")}
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
                        </RowLink>
                        {connection(d, "hidden min-w-0 max-w-[40%] shrink truncate text-[11px] text-zinc-500 sm:block")}
                        <Link to={`/design/${d.id}`} tabIndex={-1} className="shrink-0 text-[11px] tabular-nums text-zinc-500">
                          {framesOf(d)} · {timeAgo(d.updatedAt)}
                        </Link>
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
