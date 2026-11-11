import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AudioLines, Quote, FileText, Image as ImageIcon, Search, Upload, Video } from "lucide-react";
import type { AssetCard, AssetKind, AssetPage, Collection, LibrarySummary, SearchHit, WatchStatus } from "@contracts/library";
import { AppBar } from "@/components/AppBar";
import { BrowseBar, NewFolderButton, TrashLink } from "@/components/browse/Bar";
import { askFolderName, askRename } from "@/components/browse/browse";
import { FolderCard, FolderRow, type FolderProps } from "@/components/browse/Folder";
import { FolderGrid } from "@/components/browse/Grid";
import { FolderTrail } from "@/components/browse/ToolFolders";
import { byName, persistSort, storedSort, useBrowseView } from "@/components/browse/views";
import { FootageFolderCard } from "@/components/FootageFolderCard";
import { BIG_DROP, BigUploadDialog, ClipStage, LibraryProgressBar, MovingBar } from "@/components/LibraryProcessing";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { confirmDialog } from "@/lib/dialogs";
import {
  createCollection,
  createLibrary,
  deleteCollection,
  getAsset,
  getWatch,
  isFinals,
  listAssets,
  listCollections,
  listLibraries,
  listSources,
  changeFolderItems,
  renameCollection,
  searchLibrary,
  setTrashed,
  uploadFile,
  audioOf,
} from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";
import { pathOnMac } from "@/lib/thisMac";
import { cn } from "@/lib/utils";
import { LibraryFacetBar } from "@/components/LibraryFacetBar";
import { libraryBadges, libraryFacets } from "@/lib/library-slots";
import { AiBadge, ClipPanel } from "./library/ClipPanel";
import { ClipView } from "./library/ClipView";
import { folderTo, foldersAt, holdsClips, moveOptions, moveSteps, trailOf } from "./library/folders";
import { LibrarySettings } from "./library/LibrarySettings";

/**
 * Media Library (/library): the person's raw materials, one library's footage as a grid of 16:9 cards. An empty library
 * is one screen: what the library is for and the folder to choose (FootageFolderCard), upload as the second way. Its
 * folders (the library's collections, ./library/folders.ts) are the app's folder cards and rows (components/browse/):
 * the top level shows the folders and the clips in none, `?f=` opens one, `?trash=1` the Trash. Above them: the trail
 * back up, the bar (search, sort, cards or list, the kind, the settings button), then one row to narrow (A-roll and
 * B-roll first), then the progress while there is any. Search and that row look in the whole library from the top, in
 * the folder when one is open: titles and tags (FTS5, api/library/query.ts) and what is said in the clips (api/library/search.ts),
 * where a line said opens the preview at its second. A card opens its preview; dragged onto a folder it moves there.
 * Uploads go in one at a time, from the tray. A card being prepared updates when the server finishes it (the change
 * stream), without polling. Finals has its own tool (/finals): its folder is not shown here.
 */

const KINDS: { value: AssetKind | "all"; label: string }[] = [
  { value: "all", label: "All kinds" },
  { value: "video", label: "Videos" },
  { value: "audio", label: "Audio" },
  { value: "image", label: "Images" },
  { value: "doc", label: "Documents" },
];
const KIND_ICON: Record<AssetKind, typeof Video> = { video: Video, audio: AudioLines, image: ImageIcon, doc: FileText };

/** A-roll or B-roll, as the server sorted the clip (api/library/roll.ts); finished work and unsorted clips have none. */
type Roll = "a" | "b";
const rollOf = (a: AssetCard) => a.roll;
const ROLLS: { value: Roll | null; label: string }[] = [
  { value: null, label: "All" },
  { value: "a", label: "A-roll" },
  { value: "b", label: "B-roll" },
];

interface Upload {
  key: number;
  file: File;
  sent: number;
  /** the manual folder open when the file was dropped: it goes in there */
  folderId?: string;
  status: "waiting" | "uploading" | "added" | "duplicate" | "failed";
  error?: string;
  inPlace?: boolean; // added where it is on this Mac, not uploaded
  final?: boolean; // refused for good (too large for this server): no Retry
}

/** what a clip carries when it is dragged onto a folder */
const DRAG = "application/x-ct-media-item";
const SORTS = ["new", "name"] as const;
const SORT_KEY = "library:sort";

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function LibraryPage() {
  // the lists are saved copies (lib/local-cache): they paint on the first frame and the change stream's library topic
  // reads them again (an upload elsewhere, a picture or transcript the server finished), so nothing here polls
  const libs = useCachedLoad<LibrarySummary[]>("/api/library", listLibraries);
  const libraries = libs.data;
  const setLibraries = libs.set;
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [kind, setKind] = useState<AssetKind | "all">("all");
  const [roll, setRoll] = useState<Roll | null>(null);
  const [facets, setFacets] = useState<Record<string, string[]>>({}); // plug-in sidebar filters picked so far
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [asking, setAsking] = useState<File[] | null>(null); // a big upload, waiting for its go after the estimate
  const [askingHere, setAskingHere] = useState(false); // those files are on this computer: added where they are, not uploaded
  const [preview, setPreview] = useState<AssetCard | null>(null);
  const [startAt, setStartAt] = useState(0); // the second the preview opens at (a line said in it)
  const [found, setFound] = useState<{ hits: SearchHit[]; meaningGettingReady: boolean } | null>(null); // a search's answer
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState(() => storedSort(SORT_KEY, SORTS));
  const [view, setView] = useBrowseView("media");
  const navigate = useNavigate();
  const [source, setSource] = useState(""); // "" = this library, else a plug-in source's id (its cards only)
  const [sourceList, setSources] = useState<{ id: string; label: string }[] | null>(null); // null: not read yet
  const sources = sourceList ?? [];
  const picker = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const keys = useRef(0);

  const library = libraries?.find((l) => l.id === libraryId) ?? libraries?.[0] ?? null;
  const libId = library?.id;
  const folderList = useCachedLoad<Collection[]>(libId ? `/api/library/${libId}/collections` : null, () => listCollections(libId!));
  // Finals has its own tool (/finals reads this folder's pieces): it is kept, never shown or offered here
  const collections = (folderList.data ?? []).filter((c) => !isFinals(c));
  const reloadFolders = () => void folderList.refresh().catch((e) => setError(message(e)));
  // the open folder (?f=), or the Trash (?trash=1); a folder that is gone is the top level once the folders are known
  const [linked] = useSearchParams(); // also ?library=&asset= (the Video Cleaner's duplicate check links here)
  const trash = linked.get("trash") === "1";
  const asked = trash ? null : linked.get("f");
  const open = asked && (!folderList.data || collections.some((c) => c.id === asked)) ? asked : null;
  const openFolder = collections.find((c) => c.id === open);
  const smart = openFolder?.kind === "smart" ? openFolder : undefined;
  /** the plain folder open: clips move out of it, uploads and new folders go in it */
  const into = openFolder && holdsClips(openFolder) ? openFolder.id : null;
  // the footage folders (the owner's view; anyone else gets an error and no settings): an empty grid says whether clips
  // are on their way from one
  const watchLoad = useCachedLoad<WatchStatus>(libId ? `/api/library/${libId}/watch` : null, () => getWatch(libId!));
  const watch = watchLoad.data;
  const adding = !!watch?.folders.some((f) => f.adding > 0);

  useEffect(() => {
    const lib = linked.get("library");
    const asset = linked.get("asset");
    if (lib) setLibraryId(lib);
    if (lib && asset) getAsset(lib, asset).then((a) => openClip(a), (e) => setError(message(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked]);

  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  // the first page for the current library, search, kind and folder, kept per view; "Load more" pages add to it. The top
  // level lists the clips in no folder; narrowed there (a kind, a roll, a facet), the whole library
  const picked = kind !== "all" || !!roll || Object.values(facets).some((v) => v.length);
  const folder = trash ? { trashed: true } : open ? { collectionId: open } : picked ? {} : { unfiled: true };
  const query = { q: term || undefined, kind: kind === "all" ? undefined : [kind], facets, ...folder, source: source || undefined, roll: roll ?? undefined };
  const pageKey = libId ? `/api/library/${libId}/assets?view=${encodeURIComponent(JSON.stringify(query))}` : null;
  const first = useCachedLoad<AssetPage>(pageKey, () => listAssets(libId!, query));
  const reload = () => void first.refresh().catch((e) => setError(message(e)));
  const [more, setMore] = useState<{ key: string; items: AssetCard[]; next?: string } | null>(null);
  const extra = more && more.key === pageKey ? more : null;
  const shownIds = new Set(first.data?.items.map((a) => a.id));
  // while a term is typed the grid is the search's own answer, best first: by words, by what is said, or by meaning. A
  // saved search with words runs that search, and a term typed in it narrows it
  const words = [smart?.query?.q, term].filter(Boolean).join(" ");
  const searching = !!words && !trash && !source;
  const items = searching
    ? [...new Map((found?.hits ?? []).map((h) => [h.asset.id, h.asset])).values()]
    : [...(first.data?.items ?? []), ...(extra?.items.filter((a) => !shownIds.has(a.id)) ?? [])];
  const said = found?.hits.filter((h) => h.seconds !== undefined) ?? [];
  const next = searching ? undefined : extra ? extra.next : first.data?.next;
  // A-roll / B-roll is the server's filter (the whole library, not only the pages loaded); the row shows once clips are
  // sorted. At the top level with no sorted clip on screen (all of them in folders), one look asks whether any is
  const rollOnScreen = items.some((a) => rollOf(a));
  const askRolls = !rollOnScreen && !open && !trash && !source && !!first.data && collections.length > 0;
  const rolled = useCachedLoad<boolean>(askRolls && libId ? `/api/library/${libId}/assets?view=any-roll` : null, () =>
    Promise.all((["a", "b"] as const).map((r) => listAssets(libId!, { roll: r, limit: 1 }))).then((pages) => pages.some((p) => p.items.length > 0)),
  );
  const hasRoll = rollOnScreen || (askRolls && !!rolled.data);
  // ponytail: Name orders the pages loaded so far (the server pages newest first); a server-side order when a folder
  // holds more than a page or two
  const shown = sort === "name" && !searching ? [...items].sort((x, y) => byName({ name: x.title }, { name: y.title })) : items;
  const narrowed = !!term || kind !== "all" || !!roll || Object.values(facets).some((v) => v.length) || !!source;
  const shownFolders = trash || source ? [] : foldersAt(collections, open, term);

  // an empty library is one screen (what it is for, the folder to choose): nothing in it, no folder, nothing in its
  // trash, no footage folder, no plug-in source, no upload on its way. Until all of that is known the grid's frame stands.
  const foldersKnown = !!folderList.data || !!folderList.error;
  const emptyView = !open && !trash && !narrowed && first.data?.items.length === 0 && !collections.length;
  const trashPeek = useCachedLoad<AssetPage>(emptyView && libId ? `/api/library/${libId}/assets?view=trash-peek` : null, () =>
    listAssets(libId!, { trashed: true, limit: 1 }),
  );
  const watchKnown = watch !== null || !!watchLoad.error;
  const firstScreen =
    emptyView &&
    foldersKnown &&
    watchKnown &&
    sourceList?.length === 0 &&
    !watch?.folders.length &&
    !uploads.length &&
    !asking &&
    trashPeek.data?.items.length === 0;
  const settling = emptyView && !firstScreen && (!foldersKnown || !watchKnown || !trashPeek.data || !sourceList); // still finding out: the frame, not a wrong screen

  // the plug-in sources this account may browse here (none unless a plug-in brings one)
  useEffect(() => {
    if (!libId) return;
    listSources(libId)
      .then(setSources)
      .catch(() => setSources([]));
  }, [libId]);

  // the search: the clips found for the grid, and the lines said in them. In a saved search: its words, kind and roll
  // with the ones picked now
  useEffect(() => {
    setFound(null);
    if (!libId || !searching) return;
    let live = true;
    const saved = smart?.query;
    searchLibrary(libId, words, {
      facets,
      kind: kind === "all" ? saved?.kind?.[0] : kind,
      collectionId: smart ? undefined : (open ?? undefined),
      roll: roll ?? saved?.roll,
    })
      .then((r) => live && setFound(r))
      .catch((e) => live && (setFound({ hits: [], meaningGettingReady: false }), setError(message(e))));
    return () => void (live = false);
  }, [libId, words, open, smart, facets, kind, roll, searching]);

  const openClip = (a: AssetCard, at = 0) => {
    // a plug-in source's item (external ref) has no library asset to open here yet: its own page holds it
    if (a.id.startsWith("ext_")) return;
    setStartAt(at);
    setPreview(a);
  };

  const loadMore = () => {
    if (!libId || !next || !pageKey) return;
    const mine = ++seq.current;
    listAssets(libId, { ...query, cursor: next })
      .then((page) => {
        if (mine !== seq.current) return;
        setMore({ key: pageKey, items: [...(extra?.items ?? []), ...page.items], next: page.next });
      })
      .catch((e) => {
        if (mine === seq.current) setError(message(e));
      });
  };

  const patch = (key: number, change: Partial<Upload>) =>
    setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, ...change } : u)));

  const send = async (u: Upload) => {
    if (!libId) return;
    patch(u.key, { status: "uploading", sent: 0, error: undefined });
    try {
      const r = await uploadFile(libId, u.file, (sent, inPlace) => patch(u.key, { sent, inPlace }), u.folderId);
      patch(u.key, r.duplicateOf ? { status: "duplicate", sent: u.file.size } : { status: "added", sent: u.file.size });
      reload();
      if (u.folderId) reloadFolders(); // the folder's count
    } catch (e) {
      patch(u.key, { status: "failed", error: message(e), final: (e as { code?: string }).code === "too_large" });
    }
  };

  // a big upload says first what preparing it takes (time, and money on whose AI and keys)
  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const all = Array.from(files); // before the picker is cleared
    // picked in the Mac app on its own server: they are added where they are (lib/library.ts uploadFile)
    const here = !!(await pathOnMac(all[0]!));
    if (all.length >= BIG_DROP) {
      setAskingHere(here);
      setAsking(all);
    } else start(all, here);
  };

  // one file after another: the server's disk and the phone's data are both easier on that
  const start = (files: File[], here = false) => {
    const folderId = into ?? undefined;
    const added = files.map((file) => ({ key: ++keys.current, file, sent: 0, folderId, status: "waiting" as const, inPlace: here }));
    setUploads((prev) => [...prev, ...added]);
    void (async () => {
      for (const u of added) await send(u);
    })();
  };

  const create = async () => {
    try {
      const lib = await createLibrary("Library");
      setLibraries((prev) => [...(prev ?? []), lib]);
      setLibraryId(lib.id);
    } catch (e) {
      setError(message(e));
    }
  };

  // a new folder goes in the open one
  const newFolder = async () => {
    const name = await askFolderName();
    if (name && libId) await createCollection(libId, { name, ...(into ? { parentId: into } : {}) }).then(reloadFolders, (e) => setError(message(e)));
  };
  const renameFolder = async (c: Collection) => {
    const name = await askRename("Rename folder", c.name);
    if (name && libId) await renameCollection(libId, c.id, name).then(reloadFolders, (e) => setError(message(e)));
  };
  // api/library/collections.ts: its folders move up one level, its clips stay in the library. They do not go into the
  // folder above: a share or a grant on that one would then show them to someone new
  const removeFolder = async (c: Collection) => {
    const yes = await confirmDialog({
      title: `Delete the folder “${c.name}”?`,
      ...(holdsClips(c)
        ? { body: `Its clips stay in the library.${collections.some((x) => x.parentId === c.id) ? " The folders in it move up one level." : ""}` }
        : {}),
      ok: "Delete folder",
      danger: true,
    });
    if (!yes || !libId) return;
    await deleteCollection(libId, c.id).then(
      () => {
        reloadFolders();
        reload();
      },
      (e) => setError(message(e)),
    );
  };

  // clips dragged onto a folder or moved from their window: into that folder, out of the one open
  const move = async (ids: string[], to: string | null) => {
    if (!libId) return;
    const step = moveSteps(into, to);
    try {
      if (step.add) await changeFolderItems(libId, step.add, ids, true);
      if (step.remove) await changeFolderItems(libId, step.remove, ids, false);
    } catch (e) {
      setError(message(e));
    }
    reload();
    reloadFolders();
  };

  // the search on screen at the top level, kept as a saved search that runs it again (in a folder it would not be the same)
  const canSave = !!term && searching && !open && !Object.values(facets).some((v) => v.length);
  const saveSearch = async () => {
    if (!libId || !term) return;
    try {
      const c = await createCollection(libId, {
        name: term.slice(0, 80),
        kind: "smart",
        query: { q: term, kind: kind === "all" ? undefined : [kind], roll: roll ?? undefined },
      });
      reloadFolders();
      setQ("");
      navigate(folderTo(c.id));
    } catch (e) {
      setError(message(e));
    }
  };

  const folderProps = (c: Collection): FolderProps => ({
    name: c.name,
    to: folderTo(c.id),
    icon: c.kind === "smart" ? Search : undefined,
    meta: holdsClips(c) ? (c.count ?? 0) + collections.filter((x) => x.parentId === c.id).length : undefined,
    drop: holdsClips(c) ? { type: DRAG, onItems: (ids) => void move(ids, c.id), label: "Move into this folder" } : undefined,
    onRename: () => void renameFolder(c),
    onDelete: () => void removeFolder(c),
  });
  // a library clip can be dragged onto a folder (not from the Trash, not a plug-in source's item)
  const dragOf = (a: AssetCard) =>
    trash || a.id.startsWith("ext_")
      ? undefined
      : {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.setData(DRAG, a.id);
            e.dataTransfer.effectAllowed = "move";
          },
        };

  const moveAsset = async (a: AssetCard, trash: boolean) => {
    if (!libId) return;
    try {
      await setTrashed(libId, a.id, trash);
      setPreview(null);
      reload();
    } catch (e) {
      setError(message(e));
    }
  };

  const label = (u: Upload) =>
    u.status === "waiting"
      ? "Waiting"
      : u.status === "uploading"
      ? u.inPlace ? "Adding" : `Uploading ${Math.round((u.sent / Math.max(1, u.file.size)) * 100)}%`
      : u.status === "added"
        ? "Added"
        : u.status === "duplicate"
          ? "Already in library"
          : "Failed";

  // the Upload button's handler: the top bar's button and the first screen's second way both call it
  const chooseFiles = () => picker.current?.click();

  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar tool="Media Library" trail={library?.name}>
        {library && !firstScreen && !trash && (
          <>
            {!open && <TrashLink to="/library?trash=1" title="Trash" />}
            {!smart && <NewFolderButton onClick={() => void newFolder()} />}
            <Button size="sm" onClick={chooseFiles}>
              <Upload className="h-4 w-4" />
              Upload
            </Button>
          </>
        )}
      </AppBar>
      {asking && libId && (
        <BigUploadDialog
          libraryId={libId}
          drop={{ clips: asking.length, bytes: asking.reduce((n, f) => n + f.size, 0), ...audioOf(asking) }}
          title={`${askingHere ? "Add" : "Upload"} ${asking.length.toLocaleString()} clips?`}
          go={askingHere ? "Add" : "Upload"}
          onClose={() => setAsking(null)}
          onUpload={() => {
            start(asking, askingHere);
            setAsking(null);
          }}
        />
      )}
      <input
        ref={picker}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          void addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-4 sm:px-6">
        {libraries === null && !error && <TileFrame />}

        {libraries?.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-sm text-zinc-500">No library yet. Make one to start: it's where your footage lives.</p>
            <Button variant="outline" size="sm" onClick={create}>
              Create library
            </Button>
          </div>
        )}

        {libraries && libraries.length > 1 && (
          <select
            aria-label="Library"
            value={libId ?? ""}
            onChange={(e) => setLibraryId(e.target.value)}
            className="h-9 w-fit rounded-md border border-zinc-500/30 bg-transparent px-2 text-sm"
          >
            {libraries.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}

        {library && firstScreen && <FootageFolderCard page libraryId={library.id} onUpload={chooseFiles} />}

        {library && !firstScreen && (
          <>
            <FolderTrail state={{ open: trash ? "trash" : open, trail: trailOf(collections, open, trash), to: folderTo }} top={library.name} />
            <BrowseBar
              search={{ value: q, onChange: setQ, placeholder: "Search clips and what is said" }}
              sort={{
                value: sort,
                onChange: (v) => {
                  setSort(v);
                  persistSort(SORT_KEY, v);
                },
                label: "Sort clips",
                options: [
                  { id: "new", label: "Newest" },
                  { id: "name", label: "Name" },
                ],
              }}
              view={{ value: view, onChange: setView }}
            >
              {canSave && (
                <Button size="sm" variant="ghost" className="h-8" onClick={() => void saveSearch()}>
                  <Search className="h-4 w-4" />
                  Save this search as a folder
                </Button>
              )}
              <select
                aria-label="Kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as AssetKind | "all")}
                className="h-8 rounded-md border border-zinc-800 bg-transparent px-2 text-[12px] text-zinc-400 outline-none hover:text-zinc-200"
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
              {watch && (
                <LibrarySettings
                  library={library}
                  watch={watch}
                  folders={collections.filter(holdsClips)}
                  onChange={(l) => setLibraries((all) => all?.map((x) => (x.id === l.id ? l : x)) ?? all)}
                  onError={setError}
                />
              )}
            </BrowseBar>

            <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
              {(hasRoll || roll) && (
                <div role="group" aria-label="Roll" className="flex flex-wrap gap-1.5">
                  {ROLLS.map((r) => (
                    <Button key={r.label} size="sm" variant={roll === r.value ? "default" : "outline"} aria-pressed={roll === r.value} onClick={() => setRoll(r.value)}>
                      {r.label}
                    </Button>
                  ))}
                </div>
              )}
              {sources.length > 0 && (
                <div role="group" aria-label="Sources" className="flex flex-wrap items-center gap-1.5">
                  <Button size="sm" variant={!source ? "default" : "outline"} aria-pressed={!source} onClick={() => setSource("")}>
                    Library
                  </Button>
                  {sources.map((s) => (
                    <Button key={s.id} size="sm" variant={source === s.id ? "default" : "outline"} aria-pressed={source === s.id} onClick={() => setSource(s.id)}>
                      {s.label}
                    </Button>
                  ))}
                </div>
              )}
              <LibraryFacetBar facets={libraryFacets("library")} value={facets} onChange={setFacets} />
            </div>

            <LibraryProgressBar libraryId={library.id} />

            {uploads.length > 0 && (
              <section aria-label="Uploads" className="flex flex-col gap-2 rounded-xl border border-zinc-500/20 p-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{uploads.every((u) => u.inPlace) ? "Adding" : "Uploads"}</span>
                  <Button variant="ghost" size="sm" onClick={() => setUploads((prev) => prev.filter((u) => u.status === "uploading" || u.status === "waiting"))}>
                    Clear finished
                  </Button>
                </div>
                {uploads.map((u) => (
                  <div key={u.key} className="flex flex-col gap-1 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate">{u.file.name}</span>
                      <span className="shrink-0 text-xs text-zinc-500">{label(u)}</span>
                    </div>
                    {/* a file added where it is has no bytes to count: its bar moves until it is in */}
                    {u.status === "uploading" && (u.inPlace ? <MovingBar /> : <Progress value={(u.sent / Math.max(1, u.file.size)) * 100} className="h-1.5" />)}
                    {u.status === "failed" && (
                      <div className="flex items-center gap-2 text-xs text-red-400">
                        <span className="min-w-0">{u.error}</span>
                        {!u.final && (
                        <Button variant="outline" size="sm" onClick={() => void send(u)}>
                          Retry
                        </Button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </section>
            )}

            {found?.meaningGettingReady && <p className="text-xs text-zinc-500">Search by meaning is getting ready.</p>}

            {said.length > 0 && (
              <section aria-label="Said in clips" className="flex flex-col gap-1 rounded-xl border border-zinc-500/20 p-3">
                <span className="text-sm font-medium">Said in clips</span>
                {said.slice(0, 12).map((h, i) => (
                  <button
                    key={`${h.asset.versionId}-${i}`}
                    type="button"
                    onClick={() => openClip(h.asset, h.seconds)}
                    className="flex items-baseline gap-2 rounded px-1 py-1 text-left text-sm hover:bg-zinc-500/10"
                  >
                    <Quote className="h-3.5 w-3.5 shrink-0 self-center text-zinc-500" />
                    <span className="shrink-0 font-mono text-xs text-zinc-500">{clock(h.seconds ?? 0)}</span>
                    <span className="min-w-0 flex-1 truncate">{h.snippet}</span>
                    <span className="max-w-[35%] shrink-0 truncate text-xs text-zinc-500">{h.asset.title}</span>
                  </button>
                ))}
              </section>
            )}

            {(searching ? !found : !first.data) || settling ? (
              view === "list" ? <RowFrame /> : <TileFrame />
            ) : shown.length > 0 || shownFolders.length > 0 ? (
              view === "list" ? (
                <div className="flex flex-col gap-1.5">
                  {shownFolders.map((c) => (
                    <FolderRow key={c.id} {...folderProps(c)} />
                  ))}
                  {shown.map((a) => (
                    <AssetRow key={a.id} asset={a} onOpen={() => openClip(a)} drag={dragOf(a)} />
                  ))}
                </div>
              ) : (
                <FolderGrid size="small">
                  {shownFolders.map((c) => (
                    <FolderCard key={c.id} {...folderProps(c)} covers={(c.covers ?? []).map((src) => ({ src }))} />
                  ))}
                  {shown.map((a) => (
                    <AssetTile key={a.id} asset={a} onOpen={() => openClip(a)} drag={dragOf(a)} />
                  ))}
                </FolderGrid>
              )
            ) : (
              libraries !== null && (
                <p className="py-16 text-center text-sm text-zinc-500">
                  {narrowed
                    ? "No matches."
                    : adding
                      ? null // the line above the grid says how many are in
                      : trash
                        ? "The trash is empty."
                        : open
                          ? "Nothing in this folder yet."
                          : watch?.folders.length
                            ? "No videos in your folder yet."
                            : "Nothing here yet."}
                </p>
              )
            )}

            {next && (
              <Button variant="outline" className="self-center" onClick={loadMore}>
                Load more
              </Button>
            )}
          </>
        )}

        {(error ?? ((!libraries && libs.error) || (!first.data && first.error) || null)) && (
          <p className="text-sm text-red-400">{error ?? (libs.error || first.error)}</p>
        )}
      </main>

      <ClipView open={preview !== null} onClose={() => setPreview(null)}>
          {preview && libId && (
            <ClipPanel
              libraryId={libId}
              asset={preview}
              startAt={startAt}
              inTrash={trash}
              moveTo={moveOptions(collections, into)}
              onTrash={(t) => void moveAsset(preview, t)}
              onPrev={((i) => (i > 0 ? () => openClip(shown[i - 1]!) : undefined))(shown.findIndex((x) => x.id === preview.id))}
              onNext={((i) => (i >= 0 && i < shown.length - 1 ? () => openClip(shown[i + 1]!) : undefined))(shown.findIndex((x) => x.id === preview.id))}
              onMove={(id) => move([preview.id], id)}
              onSaved={(a) => {
                setPreview(a);
                const fix = (all: AssetCard[]) => all.map((x) => (x.id === a.id ? { ...x, description: a.description, tags: a.tags, aiTags: a.aiTags } : x));
                first.set((p) => p && { ...p, items: fix(p.items) });
                setMore((m) => m && { ...m, items: fix(m.items) });
              }}
              onError={setError}
            />
          )}
      </ClipView>
    </div>
  );
}

/** The list view's rows before its list is known, their height: nothing moves when the list arrives. */
function RowFrame() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-1.5">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="h-[58px] rounded-lg border border-zinc-800 bg-zinc-900/50" />
      ))}
    </div>
  );
}

/** The grid's boxes before its list is known, the size of the cards: nothing moves when the list arrives. */
function TileFrame() {
  return (
    <ul aria-hidden="true" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => (
        <li key={i} className="flex flex-col gap-1.5">
          <div className="aspect-video w-full rounded-lg bg-zinc-900 ring-1 ring-zinc-500/20" />
          <div className="h-5" />
        </li>
      ))}
    </ul>
  );
}

/**
 * One clip. Its picture shows the moment there is one; before that a clip being prepared says so, quietly and moving
 * (never amber: amber is for what needs the person). A failed clip says why; a missing one (its drive unplugged) says so.
 */
type Drag = { draggable: boolean; onDragStart: (e: React.DragEvent) => void };

function AssetTile({ asset: a, onOpen, drag }: { asset: AssetCard; onOpen: () => void; drag?: Drag }) {
  const Icon = KIND_ICON[a.kind];
  const preparing = a.state === "processing" && !a.thumbUrl;
  return (
    <button type="button" onClick={onOpen} data-state={a.state} {...drag} className="group flex w-full min-w-0 flex-col gap-1.5 text-left">
      <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-zinc-900 ring-1 ring-zinc-500/20 transition group-hover:ring-zinc-400/60">
        {a.thumbUrl ? (
          <img src={a.thumbUrl} alt="" loading="lazy" className={cn("h-full w-full object-cover", a.state === "missing" && "opacity-40")} />
        ) : (
          <div className={cn("flex h-full w-full flex-col items-center justify-center gap-1.5 text-zinc-600", preparing && "motion-safe:animate-pulse")}>
            <Icon className="h-7 w-7" />
            {/* the clip's own step when the server says it ("Getting its picture"), else the plain word */}
            {preparing && (a.preparing ? <ClipStage card={a} /> : <span className="text-xs text-zinc-400">Preparing</span>)}
          </div>
        )}
        {a.durationS !== undefined && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-white">
            {clock(a.durationS)}
          </span>
        )}
        {(a.state === "missing" || (a.state === "failed" && !a.failed)) && (
          // on the picture's own dark label in both themes: white words, the colour in the dot (red failed, amber needs the person)
          <span className="absolute left-1.5 top-1.5 flex max-w-[calc(100%-0.75rem)] items-center gap-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[11px] text-white">
            <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", a.state === "failed" ? "bg-red-500" : "bg-amber-500")} />
            {/* a failed clip whose step is known says which one under its name (ClipStage) */}
            <span className="truncate">{a.state === "failed" ? "Couldn't read this file" : "File not found"}</span>
          </span>
        )}
      </div>
      <span className="truncate text-sm font-medium">{a.title}</span>
      {/* the step running on this clip now, or what failed; nothing for a clip that is ready or waits its turn */}
      {(a.thumbUrl || a.state === "failed") && <ClipStage card={a} />}
      {libraryBadges(a).map((b) => (
        <span key={b.label} className="w-fit rounded bg-zinc-500/20 px-1 py-px text-[10px] font-medium text-zinc-400">
          {b.label}
        </span>
      ))}
      {a.description && (
        <span className="line-clamp-2 text-xs text-zinc-500">
          {a.description.source === "ai" && <AiBadge />}
          {a.description.text}
        </span>
      )}
    </button>
  );
}

/** One clip in the list view: its picture, name, the step running on it and its length, as a folder's row. */
function AssetRow({ asset: a, onOpen, drag }: { asset: AssetCard; onOpen: () => void; drag?: Drag }) {
  const Icon = KIND_ICON[a.kind];
  return (
    <button
      type="button"
      onClick={onOpen}
      data-state={a.state}
      {...drag}
      className="flex w-full items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-left transition-colors hover:border-violet-500/50"
    >
      <div className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-zinc-950 text-zinc-600">
        {a.thumbUrl ? <img src={a.thumbUrl} alt="" loading="lazy" className={cn("h-full w-full object-cover", a.state === "missing" && "opacity-40")} /> : <Icon className="h-4 w-4" />}
      </div>
      <span className="min-w-0 flex-1 truncate text-sm">{a.title}</span>
      {a.state === "missing" ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-zinc-500">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          File not found
        </span>
      ) : (
        <ClipStage card={a} className="shrink-0" />
      )}
      {a.durationS !== undefined && <span className="shrink-0 font-mono text-[11px] text-zinc-500">{clock(a.durationS)}</span>}
    </button>
  );
}
