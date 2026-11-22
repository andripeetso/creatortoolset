import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { Activity, MoreHorizontal, Music, RefreshCw, Search, Settings2, Trash2, Upload } from "lucide-react";
import type { AssetCard, AssetKind, AssetPage, Collection, LibrarySort, LibrarySummary, SearchHit, WatchStatus } from "@contracts/library";
import { hostsOriginals, hostsProxies, levelOf, LIBRARY_WORDS, uploadSent } from "@contracts/library";
import { AppBar } from "@/components/AppBar";
import { CtMark } from "@/components/CtMark";
import { BrowseBar, NewFolderButton } from "@/components/browse/Bar";
import { askFolderName, askRename } from "@/components/browse/browse";
import { FolderCard, FolderRow, type FolderProps } from "@/components/browse/Folder";
import { FolderGrid } from "@/components/browse/Grid";
import { FolderTrail } from "@/components/browse/ToolFolders";
import { persistSort, storedSort } from "@/components/browse/views";
import { LibrarySetup } from "./library/Setup";
import { LibraryProgressBar } from "@/components/LibraryProcessing";
import { LibraryHealthButton, LibraryStatusDialog } from "./library/Health";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { ProjectSwitcher } from "@/components/workspace/ProjectSwitcher";
import {
  createCollection,
  createLibrary,
  deleteCollection,
  getAsset,
  getWatch,
  isFinals,
  listAllAssets,
  listAssets,
  listCollections,
  orderCollections,
  listLibraries,
  listSources,
  changeFolderItems,
  renameCollection,
  searchLibrary,
  setTrashed,
  emptyTrash,
  libraryZipUrl,
  listTags,
  redoMany,
  updateAsset,
} from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";
import { thisMacBridge } from "@/lib/thisMac";
import { addRefused, scanWatchNow } from "@/lib/library";
import { canChange, useMe } from "@/lib/auth";
import { confirmDialog } from "@/lib/dialogs";
import { undoable } from "@/lib/undo";
import { libraryFacets } from "@/lib/library-slots";
import { ClipPanel } from "./library/ClipPanel";
import { AssetRow, AssetTile, LIST_CONTAINER, PhotoMasonry, RowFrame, TileFrame } from "./library/ClipCards";
import { ImportSummary, PlaceholderTile, commonAspect, going, placeholderShown, placeholderWide, summaryLine } from "./library/Placeholders";
import { addImports, cancelImports, onImported, retryImport, useImportQueue } from "@/lib/import-queue";
import { ClipView } from "./library/ClipView";
import { FoundInClips } from "./library/FoundInClips";
import { clipHref, folderTo, foldersAt, holdsClips, moveOptions, moveSteps, trailOf } from "./library/folders";
import { ClipShare } from "./library/ClipShare";
import { useEndOfList, useEscapeSteps, useSelectAll, watchesEnd } from "./library/grid";
import { ClipMenu, ClipPick, offlineWords, PickBar, redoKinds, RevealItem, saveFile, usePicks } from "./library/Selection";
import { setOffline, useOffline } from "./library/offline-state";
import { thisMacDevice } from "@/lib/providers";
import { LibrarySettings, needsAttention } from "./library/LibrarySettings";
import { useLibraryDrop } from "./library/LibraryDrop";
import { EmptyDrop } from "./library/EmptyDrop";
import { CantRead, lookForNew, lookedLine, useImportQuestion, useWaitingFolders } from "./library/Import";
import { repairPictures, repairStrips } from "@/lib/onMac";
import { SourceMediaItems } from "./library/SourceMediaItems";
import { useOrganize } from "./library/Organize";
import { anyFilter, savable, withSaved } from "./library/Filters";
import { canReveal } from "./library/clip";
import type { LibraryFilters } from "@/lib/library";
import { restoreFolder, tabCounts, type TabCounts } from "./library/api";
import { GalleryGrid, GalleryTile } from "./library/Gallery";
import { DRAG, putBack, ROLL_LABEL, rollOfFolder, takeOut, takesRoll, type Roll } from "./library/moves";
import { CLIP_CARDS, type DraggedClip } from "@/lib/chat-clips";
import { LibrarySidebar, SidebarSheet, sidebarPicked } from "./library/Sidebar";
import { ListHeader, SORT_IDS, SortControls } from "./library/SortControls";
import { noBrowserMenu, SpaceMenu } from "./library/SpaceMenu";
import { LibraryTabs, type Tab } from "./library/Tabs";
import { ReorganizeDialog, SmartFolderDialog } from "./library/SmartFolders";
import { cardColumns, LibraryViewMenu, useCardSize, useLibraryView } from "./library/views";

/**
 * Media Library (/library): the person's raw materials, one library's footage. An empty library is this same page,
 * as one drop box with no toolbar (./library/EmptyDrop.tsx) in place of the grid (the first upload's dialog asks
 * how to sort the files, ./library/Organize.tsx); a drop anywhere on it adds files and folders (./library/LibraryDrop.tsx).
 * Left: the sidebar (./library/Sidebar.tsx: sort, when, where, tags, kinds, a plug-in's own filters; a sheet on a
 * narrow window). Above the grid: the page's own row (left: search, View with the layout and card size, More with Library
 * settings and the Trash; right: New folder and Upload), then the
 * tabs (./library/Tabs.tsx: All, A-roll, B-roll, Photos, the top-level folders), each a place to drop clips on. Three
 * views (./library/views.tsx): Folders (the folder cards, components/browse/, then the clips in none), Gallery (the
 * clips, ./library/Gallery.tsx; inside a folder, its folders above them) and List. `?f=` opens a folder, `?trash=1` the Trash. Search looks in the whole library
 * from the top, in the folder when one is open: titles and tags (FTS5, api/library/query.ts) and what is said in the
 * clips (api/library/search.ts), where a moment found (a line said, a shot, a timeline moment) opens the preview at its second. A card opens its preview; dragged
 * onto a folder or a tab it moves there, at once on screen (./library/moves.ts), with Undo. Right-click on the empty
 * space: New folder, Upload. Uploads go in one at a time, from the tray. A card being prepared updates when the server
 * finishes it (the change stream), without polling. Finals has its own tool (/finals): its folder is not shown here.
 */

const SORT_KEY = "library:sort";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The libraries whose photos with no picture and stray strips this window has asked this Mac for, once a session (repairPictures, repairStrips). */
const picturesRepaired = new Set<string>();

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
  const [filters, setFilters] = useState<LibraryFilters>({}); // tags, when, where (./library/Filters.tsx)
  // a drop's files, going in side by side: the app's own queue (lib/import-queue.ts), so leaving this page keeps them
  // going and coming back shows their cards and the line as they are
  const queue = useImportQueue();
  const [sharing, setSharing] = useState<AssetCard | null>(null); // the clip whose share box is open (right-click Share…)
  const [ruling, setRuling] = useState<Collection | null>(null); // the folder whose "What goes here…" is open (smart folders)
  const [reorganizing, setReorganizing] = useState(false);
  const [tags, setTags] = useState<string[]>([]); // the library's tags, most used first (Add tag)
  const [preview, setPreview] = useState<AssetCard | null>(null);
  const [startAt, setStartAt] = useState(0); // the second the preview opens at (a line said in it)
  const [found, setFound] = useState<{ hits: SearchHit[]; meaningGettingReady: boolean } | null>(null); // a search's answer
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState(() => storedSort(SORT_KEY, SORT_IDS));
  // the one sort: Sort by, its order button and the list's headers all write it
  const pickSort = (v: LibrarySort) => {
    setSort(v);
    persistSort(SORT_KEY, v);
  };
  const [view, setView] = useLibraryView();
  const [cardSize, setCardSize] = useCardSize();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const columns = cardSize === null ? undefined : cardColumns(cardSize);
  const navigate = useNavigate();
  const [source, setSource] = useState(""); // "" = this library, else a plug-in source's id (its cards only)
  const [sourceList, setSources] = useState<{ id: string; label: string }[] | null>(null); // null: not read yet
  const sources = sourceList ?? [];
  const picker = useRef<HTMLInputElement>(null);
  // Blur faces unticked by the owner or an admin: the library whose next files are kept as filmed (contracts Blur "no")
  const [asFilmed, setAsFilmed] = useState<string | null>(null);
  const seq = useRef(0);
  const loading = useRef<string | null>(null); // the cursor of the page on its way
  const loc = useLocation();

  const library = libraries?.find((l) => l.id === libraryId) ?? libraries?.[0] ?? null;
  const libId = library?.id;
  // this library's files on their way in (the queue is the whole app's)
  const uploads = queue.items.filter((u) => u.libraryId === libId);
  /** a workspace given to this person by its owner, or the Media Library on Read for them: to look at and download from,
   *  never change (the server refuses). `canAdd`: the owner's library takes their uploads all the same (Read & write). */
  const me = useMe();
  const readOnly = !!library?.readOnly || (!!me && !canChange(me, "media"));
  // the page's own writes read these again too ({ own }): a refresh right after a write can join a read that started
  // before it, and without the write's own notice that read's answer would stand (an Undo that never showed)
  const folderList = useCachedLoad<Collection[]>(libId ? `/api/library/${libId}/collections` : null, () => listCollections(libId!), { own: true });
  // Finals has its own tool (/finals reads this folder's pieces): it is kept, never shown or offered here
  const collections = (folderList.data ?? []).filter((c) => !isFinals(c));
  const reloadFolders = () => void folderList.refresh().catch((e) => setError(message(e)));
  // the open folder (?f=), or the Trash (?trash=1); a folder that is gone is the top level once the folders are known
  const [linked] = useSearchParams(); // also ?library=&asset=: a link from outside the page to one item (a plug-in's list of matches)
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
  const waitingFolders = useWaitingFolders(libId); // Media folders waiting for Allow on this Mac: the empty page's one thing, else a bar on top
  const adding = !!watch?.folders.some((f) => f.adding > 0);
  // the setup: the owner's only (watch is theirs alone). Until the library is set up it is the page itself, with no way
  // around it; after that ?setup=1 opens it again as a sheet
  const needsSetup = !!watch && !!library && !library.settings.setupAt;
  const setupOpen = !!watch && linked.get("setup") === "1" && !needsSetup;
  const closeSetup = () => navigate("/library", { replace: true });

  // ?clip= is the clip open (?asset= in older links), ?library= the library when not the first: Back closes the clip,
  // Forward opens it again, a link opens it. Read from the address itself on Back and Forward too: the router's copy can
  // stay behind while the clip's window is open
  const clipIn = (p: URLSearchParams) => p.get("clip") ?? p.get("asset");
  const [clipId, setClipId] = useState(() => clipIn(linked));
  useEffect(() => setClipId(clipIn(linked)), [linked]);
  useEffect(() => {
    const onPop = () => setClipId(clipIn(new URLSearchParams(window.location.search)));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const linkedLib = linked.get("library");
  useEffect(() => {
    if (linkedLib) setLibraryId(linkedLib);
  }, [linkedLib]);

  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  // the first page for the current library, search, kind and folder, kept per view; "Load more" pages add to it. The top
  // level lists the clips in no folder; narrowed there (a kind, a roll, a facet), the whole library
  // The Gallery shows only clips, so at the top it shows every clip in the library
  const picked = kind !== "all" || !!roll || Object.values(facets).some((v) => v.length) || anyFilter(filters);
  const folder: { trashed?: true; collectionId?: string; unfiled?: true } = trash
    ? { trashed: true }
    : open
      ? { collectionId: open }
      : picked || view === "gallery"
        ? {}
        : { unfiled: true };
  // Available offline (M14): the person's own list of clips, as `versions` (the filter is on this computer only)
  const offline = useOffline();
  const query = {
    q: term || undefined,
    kind: kind === "all" ? undefined : [kind],
    facets,
    ...folder,
    source: source || undefined,
    roll: roll ?? undefined,
    sort,
    ...filters,
    ...(filters.offline ? { versions: offline.versions } : {}),
  };
  const pageKey = libId ? `/api/library/${libId}/assets?view=${encodeURIComponent(JSON.stringify(query))}` : null;
  const first = useCachedLoad<AssetPage>(pageKey, () => listAssets(libId!, query), { own: true });
  const reload = () => void first.refresh().catch((e) => setError(message(e)));
  const [more, setMore] = useState<{ key: string; items: AssetCard[]; next?: string } | null>(null);
  const extra = more && more.key === pageKey ? more : null;
  // another view: a page or Select all still loading for the last one is dropped
  useEffect(() => void ++seq.current, [pageKey]);
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
  // the tabs' counts (A-roll, B-roll, photos), read again after every change to the library
  const counts = useCachedLoad<TabCounts>(libId ? `/api/library/${libId}/counts` : null, () => tabCounts(libId!), { own: true });
  // in the sort picked, by the server (api/library/query.ts) across every page; a search keeps its own order, best first
  const shown = items;
  const narrowed = !!term || kind !== "all" || !!roll || Object.values(facets).some((v) => v.length) || !!source || anyFilter(filters);
  // the Gallery's tabs are the top-level folders; inside one it shows the folders in it above its clips
  const shownFolders = trash || source || (view === "gallery" && !open) ? [] : foldersAt(collections, open, term);

  // an empty library says what it is for and the folder to choose in place of the grid: no clip in it (its folders,
  // the default ones say, hold none either), nothing in its trash, no footage folder, no plug-in source, no upload on
  // its way. Until all of that is known the grid's frame stands.
  const foldersKnown = !!folderList.data || !!folderList.error;
  const emptyView = !open && !trash && !narrowed && first.data?.items.length === 0 && collections.every((c) => !holdsClips(c) || !c.count);
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
    trashPeek.data?.items.length === 0;
  // nothing at all yet (no clip and no folder): the page is the drop box, with no toolbar (11-19, Andri)
  const bare = firstScreen && !collections.some(holdsClips);
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
    let again: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const saved = smart?.query;
    // asked again while the search's English line for the pictures is being written, so its picture hits join the list
    const run = () =>
      searchLibrary(libId, words, {
        facets,
        kind: kind === "all" ? saved?.kind?.[0] : kind,
        collectionId: smart ? undefined : (open ?? undefined),
        roll: roll ?? saved?.roll,
        ...withSaved(filters, saved),
      })
        .then((r) => {
          if (!live) return;
          setFound(r);
          if (r.picturesPending && ++tries < 6) again = setTimeout(() => void run(), 2500);
        })
        .catch((e) => live && (setFound({ hits: [], meaningGettingReady: false }), setError(message(e))));
    void run();
    return () => {
      live = false;
      clearTimeout(again);
    };
  }, [libId, words, open, smart, facets, kind, roll, searching, filters]);

  const opened = useRef("");
  const openClip = (a: AssetCard, at = 0) => {
    // a plug-in source's item (external ref) has no library asset to open here yet: its own page holds it
    if (a.id.startsWith("ext_")) return;
    // opened from a search: a video plays from its best moment (hits come best first), what is said, a shot or a timeline moment
    if (!at && searching) at = found?.hits.find((h) => h.asset.id === a.id && h.seconds !== undefined)?.seconds ?? 0;
    setStartAt(at);
    setPreview(a);
    opened.current = a.id;
    // picked by a tag: a video opens where its shot or a line said names the tag (a search's hit for it), when one does
    const tags = filters.tags ?? [];
    if (!at && tags.length && a.kind === "video" && libId)
      void searchLibrary(libId, tags.join(" "))
        .then((r) => r.hits.find((h) => h.asset.id === a.id && h.seconds !== undefined)?.seconds)
        .then((s) => s && opened.current === a.id && setStartAt(s), () => {});
    const p = new URLSearchParams(linked);
    p.delete("asset");
    p.delete("at");
    p.set("clip", a.id);
    if (libId && libId !== libraries?.[0]?.id) p.set("library", libId);
    else p.delete("library");
    // a clip opened over another (the window's arrows) takes its place: Back still closes the window
    navigate({ search: `?${p}` }, clipId ? { replace: true, state: pushedHere() ? { clip: true } : null } : { state: { clip: true } });
    setClipId(a.id);
  };
  /** this page put the open clip in the history (Back closes it), rather than a link opening it */
  const pushedHere = () => {
    const h = window.history.state as { usr?: { clip?: boolean } | null } | null; // the browser's entry; a test's router has none
    return !!(h && "usr" in h ? h.usr : (loc.state as { clip?: boolean } | null))?.clip;
  };
  const closeClip = () => {
    setPreview(null);
    setClipId(null);
    if (pushedHere()) return void navigate(-1);
    const p = new URLSearchParams(linked);
    p.delete("clip");
    p.delete("asset");
    p.delete("at");
    navigate({ search: p.size ? `?${p}` : "" }, { replace: true });
  };
  useEffect(() => {
    if (!clipId) return setPreview(null);
    const lib = linkedLib ?? libId;
    if (!lib || preview?.id === clipId) return;
    // a link to a shot (More like this) opens at its second
    setStartAt(Number(new URLSearchParams(window.location.search).get("at")) || 0);
    const known = items.find((a) => a.id === clipId);
    if (known) return setPreview(known);
    let live = true;
    getAsset(lib, clipId).then(
      (a) => live && setPreview(a),
      (e) => live && setError(message(e)),
    );
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId, linkedLib, libId]);

  // the next page as the end of the list nears (useEndOfList), one at a time
  const loadMore = () => {
    if (!libId || !next || !pageKey || pickingAll === pageKey || loading.current === next) return;
    const mine = ++seq.current;
    const cursor = next;
    loading.current = cursor;
    listAssets(libId, { ...query, cursor })
      .then((page) => {
        if (mine !== seq.current) return;
        setMore({ key: pageKey, items: [...(extra?.items ?? []), ...page.items], next: page.next });
      })
      .catch((e) => {
        if (mine === seq.current) setError(message(e));
      })
      .finally(() => {
        if (loading.current === cursor) loading.current = null;
      });
  };
  const endOfList = useEndOfList(loadMore, next);
  const [pickingAll, setPickingAll] = useState<string | null>(null); // the view whose every clip is being read for Select all


  // the Mac app with the server elsewhere: files are indexed where they are, never uploaded, unless the library's
  // upload setting says so (Library settings and Settings → Media Library, UploadSelect). A ref: an add's own answer
  // can change it for the files it starts
  // Blur faces: a new file is not blurred, so it is indexed where it is and nothing is sent (uploadSent)
  const upload = useRef(library ? uploadSent(library.settings) : "none");
  upload.current = library ? uploadSent(library.settings) : "none";
  const macRemote = !!thisMacBridge() && !watch?.allowed;
  const onMac = macRemote && !hostsOriginals(upload.current) && !hostsProxies(upload.current);

  // a big upload says first what preparing it takes (time, and money on whose AI and keys); the first add, or one from a
  // new place, asks how the files come in (./library/Import.tsx)
  const addFiles = async (files: FileList | File[] | null, paths?: Map<File, string>) => {
    if (!files?.length) return;
    if (addRefused(library)) return setError("Upload is off for this workspace, so files can't be added from this computer.");
    const all = Array.from(files); // before the picker is cleared
    const look = await importQ.prepare(all, paths);
    // picked or dropped in the Mac app on its own server: they are added where they are (lib/library.ts uploadFile)
    // indexed on this Mac: nothing uploads either
    const here = onMac || (look.paths ? look.paths.size === all.length : false);
    // a drop or a pick goes in at once (11-19: no "Add N files?"): Effort, models and the monthly budget were chosen in
    // setup, and the budget holds the analysis at its cap
    void importQ.answer(look, all).then((copies) => copies && start(all, here, look.paths, copies));
  };

  // every file starts at once and waits only where its stage is full (lib/import-queue.ts); each has its card at once
  const start = (files: File[], here = false, paths?: Map<File, string>, copies?: Map<File, string>) => {
    if (!libId) return;
    addImports(files, { libraryId: libId, folderId: into ?? undefined, here, paths, copies, mac: onMac, blur: !!library?.settings.blurFaces, asFilmed: keepsAsFilmed, cost: levelOf(library?.settings ?? {}) !== "off" });
    setAsFilmed(null); // the box is ticked again for the next drop
  };
  // a file of this library went in: its clips (and the folder's count) read again
  useEffect(
    () =>
      onImported((lib, folderId) => {
        if (lib !== libId) return;
        reload();
        if (folderId) reloadFolders();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload and reloadFolders read the page's current lists
    [libId],
  );

  const saved = (l: LibrarySummary) => setLibraries((all) => all?.map((x) => (x.id === l.id ? l : x)) ?? all);
  const organize = useOrganize({ onSaved: saved, setFolders: folderList.set });
  const importQ = useImportQuestion({ serverHere: !!watch?.allowed, onError: setError });
  const drop = useLibraryDrop({ library, ignore: DRAG, readsFolders: !!watch?.allowed, addFiles, onError: setError });

  const create = async () => {
    try {
      const lib = await createLibrary("Library");
      setLibraries((prev) => [...(prev ?? []), lib]);
      setLibraryId(lib.id);
    } catch (e) {
      setError(message(e));
    }
  };

  // a new folder goes in the open one, or in the folder whose menu asked
  const newFolder = async (parent: string | null = into) => {
    const name = await askFolderName();
    if (name && libId) await createCollection(libId, { name, ...(parent ? { parentId: parent } : {}) }).then(reloadFolders, (e) => setError(message(e)));
  };
  const renameFolder = async (c: Collection) => {
    const name = await askRename("Rename folder", c.name);
    if (name && libId) await renameCollection(libId, c.id, name).then(reloadFolders, (e) => setError(message(e)));
  };
  // gone at once, with Undo (api/library/collections.ts puts it back as it was): its folders move up one level, its
  // clips stay in the library. They do not go into the folder above: a share or a grant on that one would then show them
  // to someone new
  const removeFolder = (c: Collection) => {
    if (!libId) return;
    const lib = libId;
    const before = folderList.data;
    folderList.set((all) => all && all.filter((x) => x.id !== c.id).map((x) => (x.parentId === c.id ? { ...x, parentId: c.parentId } : x)));
    if (open === c.id) navigate(folderTo(c.parentId));
    const sent = deleteCollection(lib, c.id);
    sent.then(
      () => reload(),
      (e) => {
        folderList.set(before);
        setError(message(e));
      },
    );
    undoable(
      "folder deleted",
      async () => {
        folderList.set(before);
        await sent;
        await restoreFolder(lib, c.id);
        reloadFolders();
        reload();
      },
      1,
    );
  };

  /** The cards the page holds, changed where they are: the first page and the pages loaded after it. */
  const changeCards = (fix: (all: AssetCard[]) => AssetCard[]) => {
    first.set((p) => p && { ...p, items: fix(p.items) });
    setMore((m) => m && { ...m, items: fix(m.items) });
  };
  /** `ids` off the view now; the returned call puts them back in their places (in this view's own list, wherever the
   *  page is by then) */
  const takeCards = (ids: string[]) => {
    const setFirst = first.set;
    const key = pageKey;
    const fromFirst = takeOut(first.data?.items ?? [], ids).taken;
    const fromMore = takeOut(extra?.items ?? [], ids).taken;
    changeCards((all) => all.filter((x) => !ids.includes(x.id)));
    return () => {
      setFirst((p) => p && { ...p, items: putBack(p.items, fromFirst) });
      setMore((m) => (m && m.key === key ? { ...m, items: putBack(m.items, fromMore) } : m));
    };
  };

  // clips dragged onto a folder or a tab, moved from their window, the bar or their menu: into that folder, out of the
  // one open (`from`). The view changes the moment they are dropped and the notice shows with Undo; Undo puts them back
  // the moment it is pressed, then asks the server. A request that fails puts them back and says so
  const move = (ids: string[], to: string | null, from: string | null = into): Promise<void> => {
    if (!libId || readOnly) return Promise.resolve();
    const lib = libId;
    const r = rollOfFolder(collections.find((c) => c.id === to));
    if (r) return fileAs(ids, r);
    const step = moveSteps(from, to);
    if (!step.add && !step.remove) return Promise.resolve();
    const send = (s: { add?: string; remove?: string }) =>
      (async () => {
        if (s.add) await changeFolderItems(lib, s.add, ids, true);
        if (s.remove) await changeFolderItems(lib, s.remove, ids, false);
      })();
    // gone from this view: the folder open, or the top level's clips in no folder
    const back = from === into && (!!into || !!folder.unfiled) ? takeCards(ids) : () => {};
    picks.clear();
    const sent = send(step);
    sent.then(reloadFolders, (e) => {
      back();
      setError(`Could not move the clips: ${message(e)}`);
      reloadFolders();
    });
    const name = to ? collections.find((c) => c.id === to)?.name : null;
    undoable(
      name ? `moved to ${name}` : "moved",
      async () => {
        back();
        await sent;
        await send(moveSteps(to, from));
        reloadFolders();
      },
      ids.length,
    );
    return sent.catch(() => {});
  };

  // clips dropped on A-roll or B-roll are filed so (api/library/roll.ts): at once on screen, Undo files them as nothing
  // again and the sort decides. Photos and finished work have no roll
  const viewRoll = rollOfFolder(smart) ?? roll;
  const fileAs = (ids: string[], r: Roll): Promise<void> => {
    if (!libId || readOnly) return Promise.resolve();
    const lib = libId;
    const label = collections.find((c) => rollOfFolder(c) === r)?.name ?? ROLL_LABEL[r];
    const known = ids.map((id) => items.find((a) => a.id === id)).filter((a): a is AssetCard => !!a);
    const fit = known.length === ids.length ? known.filter(takesRoll) : null; // a card not on screen: the server decides
    if (fit && !fit.length) return (toast("Photos and finished videos have no A-roll or B-roll"), Promise.resolve());
    const these = fit ? fit.filter((a) => a.roll !== r).map((a) => a.id) : ids;
    if (!these.length) return (toast(`Already ${label}`), Promise.resolve());
    picks.clear();
    // out of the other roll's view, else marked with its new roll
    const was = new Map(known.map((a) => [a.id, a.roll]));
    const back =
      viewRoll && viewRoll !== r
        ? takeCards(these)
        : (changeCards((all) => all.map((x) => (these.includes(x.id) ? { ...x, roll: r } : x))),
          () => changeCards((all) => all.map((x) => (these.includes(x.id) ? { ...x, roll: was.get(x.id) } : x))));
    const sent = (async () => {
      const f = collections.find((c) => rollOfFolder(c) === r) ?? (await createCollection(lib, { name: label, kind: "smart", query: { roll: r } }));
      const res = (await changeFolderItems(lib, f.id, these, true)) as { added?: number };
      return { folder: f.id, added: res.added ?? 0 };
    })();
    sent.then(
      ({ added }) => {
        if (!added) {
          back();
          toast("Photos and finished videos have no A-roll or B-roll");
        } else if (added < these.length) reload();
        reloadFolders();
      },
      (e) => {
        back();
        setError(`Could not file as ${label}: ${message(e)}`);
      },
    );
    undoable(
      `filed as ${label}`,
      async () => {
        back();
        const { folder: f } = await sent;
        await changeFolderItems(lib, f, these, false);
        reload();
      },
      these.length,
    );
    return sent.then(
      () => {},
      () => {},
    );
  };

  // the search on screen at the top level, kept as a saved search that runs it again (in a folder it would not be the same)
  const canSave = !!term && searching && !open && !Object.values(facets).some((v) => v.length);
  const saveSearch = async () => {
    if (!libId || !term) return;
    try {
      const c = await createCollection(libId, {
        name: term.slice(0, 80),
        kind: "smart",
        query: { q: term, kind: kind === "all" ? undefined : [kind], roll: roll ?? undefined, ...savable(filters) },
      });
      reloadFolders();
      setQ("");
      navigate(folderTo(c.id));
    } catch (e) {
      setError(message(e));
    }
  };

  // a plain folder can be told what goes in it (a smart folder, api/library/smart.ts); Finals has its own tool
  const sortsItself = (c: Collection) => holdsClips(c) && !isFinals(c);
  // Available offline for a clip or a folder, on this computer's list (M14); the server's answer replaces the list
  const keepOffline = (target: { version: string } | { collection: string }, on: boolean) => setOffline(target, on).catch((e: unknown) => setError(message(e)));
  const folderKeep = (c: Collection) => (
    <ContextMenuItem onClick={() => void keepOffline({ collection: c.id }, !offline.collections.includes(c.id))}>{offlineWords(offline.collections.includes(c.id))}</ContextMenuItem>
  );
  const folderProps = (c: Collection): FolderProps => ({
    name: c.name,
    to: folderTo(c.id),
    icon: c.rule ? CtMark : rollOfFolder(c) ? undefined : c.kind === "smart" ? Search : c.sounds?.length ? Music : undefined,
    meta: c.sorting ? "Sorting" : holdsClips(c) ? (c.count ?? 0) + collections.filter((x) => x.parentId === c.id).length : rollOfFolder(c) ? c.count : undefined,
    drop:
      !readOnly && (holdsClips(c) || rollOfFolder(c))
        ? { type: DRAG, onItems: (ids) => void move(ids, c.id), label: rollOfFolder(c) ? `File as ${c.name}` : "Move into this folder" }
        : undefined,
    onRename: readOnly ? undefined : () => void renameFolder(c),
    onDelete: readOnly ? undefined : () => removeFolder(c),
    menu:
      (!readOnly && holdsClips(c)) || thisMacDevice() ? (
        <>
          {!readOnly && holdsClips(c) && <ContextMenuItem onClick={() => void newFolder(c.id)}>New folder inside</ContextMenuItem>}
          {!readOnly && sortsItself(c) && <ContextMenuItem onClick={() => setRuling(c)}>Folder rule…</ContextMenuItem>}
          {thisMacDevice() && folderKeep(c)}
        </>
      ) : undefined,
  });
  /** a tab's right-click menu: the folder's own (Open, Rename…, New folder inside, Delete folder) */
  const folderMenu = (c: Collection) => (
    <>
      <ContextMenuItem onSelect={() => go(c.id)}>Open</ContextMenuItem>
      {thisMacDevice() && folderKeep(c)}
      {!readOnly && (
        <>
          <ContextMenuItem onSelect={() => void renameFolder(c)}>Rename…</ContextMenuItem>
          {holdsClips(c) && <ContextMenuItem onSelect={() => void newFolder(c.id)}>New folder inside</ContextMenuItem>}
          {sortsItself(c) && <ContextMenuItem onSelect={() => setRuling(c)}>Folder rule…</ContextMenuItem>}
          <ContextMenuSeparator />
          <ContextMenuItem className="text-red-400" onSelect={() => removeFolder(c)}>
            <Trash2 /> Delete folder
          </ContextMenuItem>
        </>
      )}
    </>
  );
  /** A tab's place: a folder (`id`), or the top with a kind; a tab never keeps the kind or roll picked before */
  const go = (id: string | null, k: AssetKind | "all" = "all", r: Roll | null = null) => {
    setKind(k);
    setRoll(r);
    navigate(id ? folderTo(id) : "/library");
  };
  const rollFolderOf = (r: Roll) => collections.find((c) => rollOfFolder(c) === r);
  const topOpen = open ? trailOf(collections, open, false)[0]?.id : undefined; // the top-level folder the open one is in
  const tabs: Tab[] =
    !library || trash || source
      ? []
      : [
          { id: "all", label: "All", active: !open && kind === "all" && !roll, onOpen: () => go(null), onItems: into && !readOnly ? (ids) => void move(ids, null) : undefined },
          // the A-roll and B-roll folders, under the names they were given; a deleted one has no tab
          ...(["a", "b"] as const).flatMap((r): Tab[] => {
            const f = rollFolderOf(r);
            return f
              ? [
                  {
                    id: r,
                    label: f.name,
                    count: counts.data?.[r],
                    active: viewRoll === r && (!open || !!smart),
                    onOpen: () => go(f.id),
                    onItems: readOnly ? undefined : (ids) => void fileAs(ids, r),
                    menu: folderMenu(f),
                  },
                ]
              : [];
          }),
          // a top-level folder already called Photos or Videos is that tab (owner, 2026-11-19: two Photos tabs, one undeletable)
          ...(
            [
              ["video", "Videos", counts.data?.video],
              ["image", "Photos", counts.data?.image],
            ] as const
          ).flatMap(([k, label, count]): Tab[] =>
            (count ?? 0) > 0 && !collections.some((c) => c.parentId === null && holdsClips(c) && c.name.trim().toLowerCase() === label.toLowerCase())
              ? [{ id: k === "image" ? "photos" : "videos", label, count, active: !open && kind === k && !roll, onOpen: () => go(null, k) }]
              : [],
          ),
          ...collections
            .filter((c) => c.parentId === null && holdsClips(c))
            .map(
              (c): Tab => ({
                id: c.id,
                label: c.name,
                count: c.count,
                active: topOpen === c.id,
                onOpen: () => go(c.id),
                onItems: readOnly ? undefined : (ids) => void move(ids, c.id),
                menu: folderMenu(c),
                movable: !readOnly,
              }),
            ),
        ];
  // the folder tabs dragged into another order: at once on screen, kept by the server for everyone
  const reorderFolders = (ids: string[]) => {
    const before = folderList.data;
    const at = (id: string) => (ids.includes(id) ? ids.indexOf(id) : ids.length);
    folderList.set((all) => all && [...all].sort((a, b) => at(a.id) - at(b.id)));
    orderCollections(libId!, ids).catch((e) => {
      folderList.set(before);
      setError(message(e));
    });
  };
  // a library clip can be dragged onto a folder (not from the Trash, not a plug-in source's item)
  const dragOf = (a: AssetCard) =>
    trash || readOnly || a.id.startsWith("ext_")
      ? undefined
      : {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.setData(DRAG, carried(a).map((x) => x.id).join(","));
            // the same clips for the chat: a drop there makes a chip each (lib/chat-clips.ts)
            const cards: DraggedClip[] = carried(a).flatMap((x) => (x.versionId ? [{ id: x.id, versionId: x.versionId, title: x.title, ...(x.thumbUrl ? { thumbUrl: x.thumbUrl } : {}) }] : []));
            if (cards.length) e.dataTransfer.setData(CLIP_CARDS, JSON.stringify(cards));
            e.dataTransfer.effectAllowed = "copyMove";
          },
        };

  // several clips picked (./library/Selection.tsx): in this view only; a plug-in source's items are not picked
  const pickable = shown.filter((a) => !a.id.startsWith("ext_"));
  const picks = usePicks(`${pageKey}|${words}`, pickable.map((a) => a.id));
  const pickedCards = pickable.filter((a) => picks.picked.has(a.id));
  /** what a clip's menu or drag acts on: every picked clip when it is one of them */
  const carried = (a: AssetCard) => (picks.picked.has(a.id) && pickedCards.length > 1 ? pickedCards : [a]);
  // the picks as they are now, for Select all to see whether they changed while it read the pages
  const pickedNow = useRef(picks.picked);
  pickedNow.current = picks.picked;
  useSelectAll(() => void pickAll());
  /** every clip in this view, the pages not scrolled to yet read first (the largest pages the server gives) */
  const pickAll = async () => {
    if (!libId || !pageKey || !next) return picks.set(pickable.map((a) => a.id));
    if (pickingAll === pageKey) return;
    const mine = ++seq.current; // a page loadMore has on its way is dropped: these pages include it
    const key = pageKey;
    const before = pickedNow.current;
    setPickingAll(key);
    try {
      const got = await listAllAssets(libId, { ...query, cursor: next });
      if (mine !== seq.current) return;
      // added to the list as it is by now, so a clip trashed or moved meanwhile stays off it
      setMore((m) => ({ key, items: [...(m?.key === key ? m.items : []), ...got], next: undefined }));
      // Escape, a click or a move meanwhile is the newer choice: the pages stay loaded, the picks as the person left them
      if (pickedNow.current === before) picks.set([...pickable, ...got].map((a) => a.id).filter((id) => !id.startsWith("ext_")));
    } catch (e) {
      if (mine === seq.current) setError(message(e));
    } finally {
      setPickingAll((k) => (k === key ? null : k));
    }
  };
  // Escape: the clip's window closes itself first, then the picks go, then the search
  useEscapeSteps([() => !!pickedCards.length && (picks.clear(), true), () => !!q && (setQ(""), true)]);
  useEffect(() => {
    if (libId) listTags(libId).then((t) => setTags(t.map((x) => x.tag)), () => setTags([]));
  }, [libId]);
  const plural = (n: number) => (n === 1 ? "1 clip" : `${n} clips`);

  // into the trash or back out; Undo takes it back. A clip the server keeps (it is in Review, or not this person's) stays
  const trashMany = async (cards: AssetCard[], toTrash = true) => {
    if (!libId) return;
    const lib = libId;
    const done = (await Promise.all(cards.map((a) => setTrashed(lib, a.id, toTrash).then(() => a.id, () => null)))).filter((x): x is string => !!x);
    if (done.length < cards.length) setError(`Could not ${toTrash ? "move" : "restore"} ${plural(cards.length - done.length)}${toTrash ? " to the trash" : ""}`);
    if (!done.length) return;
    changeCards((all) => all.filter((x) => !done.includes(x.id)));
    picks.clear();
    if (preview && done.includes(preview.id)) closeClip();
    reload();
    undoable(toTrash ? "moved to the trash" : "restored", () => Promise.all(done.map((id) => setTrashed(lib, id, !toTrash))).then(reload), done.length);
  };
  const tagMany = async (cards: AssetCard[], tag: string) => {
    if (!libId) return;
    const lib = libId;
    const these = cards.filter((a) => !a.tags.includes(tag));
    const done = (await Promise.all(these.map((a) => updateAsset(lib, a.id, { tags: [...a.tags, tag] }).then(() => a, () => null)))).filter((a): a is AssetCard => !!a);
    if (done.length < these.length) setError(`Could not tag ${plural(these.length - done.length)}`);
    picks.clear();
    if (!done.length) return;
    const show = (back: boolean) =>
      changeCards((all) => all.map((x) => ((was) => (was ? { ...x, tags: back ? was.tags : [...was.tags, tag] } : x))(done.find((d) => d.id === x.id))));
    show(false);
    listTags(lib).then((t) => setTags(t.map((x) => x.tag)), () => {});
    undoable("tagged", () => Promise.all(done.map((a) => updateAsset(lib, a.id, { tags: a.tags }))).then(() => show(true)), done.length);
  };
  // one clip downloads as its original, several as one zip of theirs
  const download = (cards: AssetCard[]) =>
    libId && saveFile(cards.length === 1 ? `/api/library/media/${cards[0]!.versionId}/source` : libraryZipUrl(libId, cards.map((a) => a.id)));
  const redo = (cards: AssetCard[], kind: string) => {
    if (!libId || !library) return;
    const label = redoKinds(library.settings).find((r) => r.kind === kind)?.label ?? kind;
    redoMany(libId, [kind], cards.map((a) => a.id)).then(
      (r) => toast(r.clips ? `Redoing ${label.toLowerCase()} for ${plural(r.clips)}` : `Nothing to redo`),
      (e) => setError(message(e)),
    );
    picks.clear();
  };
  // the whole library (the owner's ⋯ menu): how many clips first, then asked once, as Redo all
  const redoLibrary = (kind: string, label: string) => {
    if (!libId) return;
    redoMany(libId, [kind], undefined, true)
      .then(async (r) => {
        if (!r.clips) return toast("Nothing to redo");
        if (!(await confirmDialog({ title: label, body: LIBRARY_WORDS.forClips(r.clips), ok: LIBRARY_WORDS.redoAll }))) return;
        await redoMany(libId, [kind]);
        toast(`Redoing ${label.toLowerCase()} for ${plural(r.clips)}`);
      })
      .catch((e: unknown) => setError(message(e)));
  };
  const copyLink = (a: AssetCard) =>
    navigator.clipboard.writeText(new URL(clipHref(libId === libraries?.[0]?.id ? null : libId, a.id), window.location.origin).href).then(
      () => toast("Link copied"),
      (e) => setError(message(e)),
    );
  // a clip's right-click menu; a plug-in source's item has none
  const menuFor = (a: AssetCard) =>
    a.id.startsWith("ext_") ? undefined : (
      <ClipMenu
        inTrash={trash}
        readOnly={readOnly}
        offline={thisMacDevice() ? { on: offline.versions.includes(a.versionId), set: (on) => void keepOffline({ version: a.versionId }, on) } : undefined}
        moveTo={moveOptions(collections, into)}
        tags={tags}
        on={{
          open: () => openClip(a),
          share: () => setSharing(a),
          download: () => download(carried(a)),
          copyLink: () => void copyLink(a),
          move: (to) => void move(carried(a).map((x) => x.id), to),
          tag: (t) => void tagMany(carried(a), t),
          trash: () => void trashMany(carried(a)),
          restore: () => void trashMany(carried(a), false),
        }}
        extra={
          canReveal() && libId ? <RevealItem libraryId={libId} asset={a} onProblem={setError} /> : undefined
        }
      />
    );
  const pickOf = (a: AssetCard) => (a.id.startsWith("ext_") ? undefined : (range: boolean) => picks.pick(a.id, range));

  // the Upload button's handler: the page's button, its right-click menu and the first screen's second way all call it
  const chooseFiles = () => picker.current?.click();
  const changing = !!library && !readOnly && !trash;
  const mayAdd = !!library && (!readOnly || (!!library.canAdd && (!me || canChange(me, "media")))) && !trash;
  // the Blur faces checkbox beside Upload: only where the library blurs and this person may keep files as filmed
  const blurChoice = mayAdd && !!library.settings.blurFaces && library.mayKeepAsFilmed;
  const keepsAsFilmed = blurChoice && asFilmed === library.id;
  const chooseBlur = async (on: boolean) => {
    if (on || !library) return setAsFilmed(null);
    const ok = await confirmDialog({ title: "Turn off Blur faces?", body: "These files will not be blurred. Faces will show in previews and to your team.", ok: "Turn off" });
    if (ok) setAsFilmed(library.id);
  };
  // Look for new files (the ⋯ menu): the server reads this computer's folders itself (This Mac, the owner), or the Mac
  // app reads its own Source media folders for a server elsewhere (the owner, or a member who may add, on their computer)
  const serverReads = !!watch?.allowed;
  const canLook = !!library && mayAdd && (serverReads ? !!watch : !!thisMacBridge() && !!thisMacDevice());
  const [lookLine, setLookLine] = useState<string | null>(null);
  const lookDone = useRef(0);
  const lookNow = async () => {
    if (!library) return;
    clearTimeout(lookDone.current);
    setLookLine("Looking for new files");
    try {
      const r = serverReads ? { ...(await scanWatchNow(library.id)), reconnected: 0, refused: [] as string[] } : { ...(await lookForNew(library, setLookLine)), settling: 0 };
      const cant = r.refused.length ? ` · can't read ${r.refused.map((f) => f.split("/").pop()).join(", ")}` : "";
      // photos that came in with no picture get it from this Mac now (repairPictures)
      const pictures = macRemote && watch ? await repairPictures(library.id).catch(() => 0) : 0;
      setLookLine(lookedLine(r.added, r.reconnected, r.settling) + (pictures ? ` · pictures for ${pictures.toLocaleString()} ${pictures === 1 ? "photo" : "photos"}` : "") + cant);
      reload();
    } catch (e) {
      setLookLine(message(e));
    }
    lookDone.current = window.setTimeout(() => setLookLine(null), 8000);
  };

  // once per library a session, in the Mac app with the server elsewhere: photos with no picture get theirs from this Mac,
  // then videos whose old strip isn't their shape get a new one (repairStrips), one after the other, never in the view's way
  useEffect(() => {
    if (!library || !watch || !macRemote || picturesRepaired.has(library.id)) return;
    picturesRepaired.add(library.id);
    const id = library.id;
    void repairPictures(id)
      .catch(() => 0)
      .then(async (pictures) => pictures + (await repairStrips(id).catch(() => 0)))
      .then((n) => n && reload(), () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once a library, when the owner's view and the Mac are known
  }, [library?.id, !!watch, macRemote]);

  const sidebar = library && (
    <LibrarySidebar
      libraryId={library.id}
      kind={kind}
      onKind={setKind}
      filters={filters}
      onFilters={setFilters}
      sources={sources}
      source={source}
      onSource={setSource}
      facets={libraryFacets("library")}
      facetValue={facets}
      onFacets={setFacets}
    />
  );
  // the trail back up, where the tabs don't already say it: the Trash, a folder inside another, a saved search
  const trail = trailOf(collections, open, trash);
  // the tabs are the Gallery's way into top-level folders; the folders inside one show as cards
  const tabbed = view === "gallery" && tabs.some((t) => t.active);
  // a drop's files as cards (./library/Placeholders.tsx), first in the folder they were dropped in, until each clip's own card is here
  const onPage = (id: string) => shown.some((a) => a.id === id);
  const pending = trash || narrowed ? [] : uploads.filter((u) => placeholderShown(u, onPage) && (u.folderId ?? null) === (into ?? null));
  // the folders above the clips, where the clips are not in the same grid (the Gallery, photos)
  const folderCards = shownFolders.length > 0 && <FolderGrid size="small" columns={columns}>{shownFolders.map((c) => <FolderCard key={c.id} {...folderProps(c)} covers={(c.covers ?? []).map((src) => ({ src }))} lines={c.sounds} />)}</FolderGrid>;
  const placeholders = pending.map((u) => <PlaceholderTile key={`up-${u.key}`} upload={u} onRetry={() => retryImport(u.key)} onCancel={() => cancelImports([u.key])} />);
  // in the Gallery each takes its clip's cell: the file's own shape once read, the library's usual one before
  const usual = commonAspect(shown);
  const galleryLead = pending.map((u) => {
    const wide = placeholderWide(u, usual);
    return { key: `up-${u.key}`, wide, node: <PlaceholderTile gallery wide={wide} upload={u} onRetry={() => retryImport(u.key)} onCancel={() => cancelImports([u.key])} /> };
  });
  const importLine = summaryLine(uploads, queue.startedAt, Date.now(), queue.usd);
  const tile = (a: AssetCard) => (
    <ClipPick key={a.id} picked={picks.picked.has(a.id)} onPick={pickOf(a)} menu={menuFor(a)}>
      <AssetTile asset={a} onOpen={() => openClip(a)} drag={dragOf(a)} ownShape={kind === "image"} />
    </ClipPick>
  );

  if (needsSetup)
    return (
      <div className="flex min-h-dvh flex-col">
        <AppBar tool="Media Library" trail={library.name}>
          <ProjectSwitcher />
        </AppBar>
        <LibrarySetup inline library={library} watchAllowed={!!watch.allowed} onDone={saved} onClose={() => {}} />
      </div>
    );

  return (
    <div className="flex min-h-dvh flex-col" onContextMenu={noBrowserMenu} {...(mayAdd && !setupOpen ? drop.props : {})}>
      {drop.dialog}
      {/* where you are and in which workspace; what the page does is on the page itself */}
      <AppBar tool="Media Library" trail={library?.name}>
        <ProjectSwitcher />
      </AppBar>
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

      <div className="flex w-full flex-1">
        {sidebar && !firstScreen && (
          // stays put while the grid scrolls, with its own scroll; its scrollbar never moves what is in it
          <aside
            aria-label="Sort and filter"
            className="sticky top-[var(--bar-h)] hidden h-[calc(100dvh-var(--bar-h))] w-60 shrink-0 overflow-y-auto border-r border-zinc-500/15 px-4 py-4 [scrollbar-gutter:stable] lg:block"
          >
            {sidebar}
          </aside>
        )}

        <main className="flex min-w-0 flex-1 flex-col gap-3 px-4 py-4 sm:px-6">
          {libraries === null && !error && <TileFrame />}

          {libraries?.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-sm text-zinc-500">No library</p>
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

          {library && (
            <>
              {(trash || (open && (!tabbed || trail.length > 1))) && (
                <FolderTrail state={{ open: trash ? "trash" : open, trail, to: folderTo }} top={library.name} />
              )}
              {/* none while there is nothing in the library: the drop box is the page */}
              {!bare && (
              <BrowseBar
                search={{ value: q, onChange: setQ, placeholder: "Search clips and transcripts" }}
                tools={
                  <>
                    {canSave && (
                      <Button size="sm" variant="ghost" className="h-8" onClick={() => void saveSearch()}>
                        <Search className="h-4 w-4" />
                        Save as folder
                      </Button>
                    )}
                    {!firstScreen && sidebar && <SidebarSheet picked={sidebarPicked({ kind, filters, facetValue: facets, source })}>{sidebar}</SidebarSheet>}
                    <LibraryViewMenu view={view} onChange={setView} size={cardSize} onSize={setCardSize} />
                    {/* Status is the owner's (its counts are the owner's routes) */}
                    {library && !readOnly && <LibraryHealthButton library={library} open={statusOpen} onOpen={() => setStatusOpen(true)} />}
                    <SortControls sort={sort} onSort={pickSort} />
                    {(watch || (changing && !firstScreen)) && (
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="relative h-8 w-8 p-0"
                            title="More"
                            aria-label={watch && needsAttention(watch) ? "More: a footage folder or clip is not found" : "More"}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                            {watch && needsAttention(watch) && <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-background" />}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          {watch && (
                            <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
                              <Settings2 /> Library settings
                              {needsAttention(watch) && <span aria-hidden className="ml-auto h-2 w-2 rounded-full bg-amber-500" />}
                            </DropdownMenuItem>
                          )}
                          {!readOnly && (
                            <DropdownMenuItem onSelect={() => setStatusOpen(true)}>
                              <Activity /> Library status
                            </DropdownMenuItem>
                          )}
                          {!trash && <SourceMediaItems canLook={canLook} onLook={() => void lookNow()} onError={setError} />}
                          {watch && !readOnly && !trash && library && redoKinds(library.settings).length > 0 && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuLabel>{LIBRARY_WORDS.redo}</DropdownMenuLabel>
                              {redoKinds(library.settings).map((r) => (
                                <DropdownMenuItem key={r.kind} onSelect={() => redoLibrary(r.kind, r.label)}>
                                  <RefreshCw /> {r.label}
                                </DropdownMenuItem>
                              ))}
                            </>
                          )}
                          {changing && !firstScreen && (
                            <DropdownMenuItem asChild>
                              <Link to="/library?trash=1">
                                <Trash2 /> Trash
                              </Link>
                            </DropdownMenuItem>
                          )}
                          {trash && !readOnly && watch && libId && (
                            <DropdownMenuItem
                              onSelect={() =>
                                void confirmDialog({ title: "Empty the trash?", body: "Every clip in the trash is deleted for good.", ok: "Empty trash", danger: true })
                                  .then((ok) => ok && emptyTrash(libId).then(reload))
                                  .catch((e: unknown) => setError(message(e)))
                              }
                            >
                              <Trash2 /> Empty trash
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                    {watch && (
                      <LibrarySettings
                        open={settingsOpen}
                        onOpenChange={setSettingsOpen}
                        library={library}
                        watch={watch}
                        folders={collections.filter(holdsClips)}
                        onChange={(l) => void organize.organized(l).catch((e) => setError(message(e)))}
                        onError={setError}
                      />
                    )}
                  </>
                }
              >
                {changing && !smart && !firstScreen && (
                  <Button size="sm" variant="ghost" className="h-8" onClick={() => setReorganizing(true)}>
                    <CtMark className="h-4 w-4" />
                    Reorganize
                  </Button>
                )}
                {changing && !smart && <NewFolderButton className="h-8" onClick={() => void newFolder()} />}
                {blurChoice && (
                  <label className="flex h-8 items-center gap-1.5 text-sm">
                    <Checkbox checked={!keepsAsFilmed} onCheckedChange={(v) => void chooseBlur(v === true)} />
                    Blur faces
                  </label>
                )}
                {mayAdd && (
                  <Button size="sm" className="h-8" onClick={chooseFiles}>
                    <Upload className="h-4 w-4" />
                    Upload
                  </Button>
                )}
              </BrowseBar>
              )}

              <SpaceMenu
                className="flex flex-1 flex-col gap-4"
                items={
                  mayAdd && (
                    <>
                      {changing && !smart && <ContextMenuItem onSelect={() => void newFolder()}>New folder</ContextMenuItem>}
                      <ContextMenuItem onSelect={chooseFiles}>Upload…</ContextMenuItem>
                    </>
                  )
                }
              >
                {view === "gallery" && tabs.length > 1 && !firstScreen && <LibraryTabs tabs={tabs} onReorder={readOnly ? undefined : reorderFolders} />}

                {/* one line while a drop goes in; the library's own progress line otherwise */}
                {lookLine && !importLine && (
                  <p role="status" className="text-xs text-zinc-500">
                    {lookLine}
                  </p>
                )}
                {importLine ? <ImportSummary line={importLine} onCancelAll={() => cancelImports(uploads.filter(going).map((u) => u.key))} /> : <LibraryProgressBar libraryId={library.id} />}
                {!firstScreen && !settling && <CantRead {...waitingFolders} />}
                {statusOpen && !readOnly && (
                  <LibraryStatusDialog
                    library={library}
                    watch={watch ?? null}
                    onClose={() => setStatusOpen(false)}
                    onSettings={
                      watch
                        ? () => {
                            setStatusOpen(false);
                            setSettingsOpen(true);
                          }
                        : undefined
                    }
                  />
                )}


                {found?.meaningGettingReady && <p className="text-xs text-zinc-500">Preparing search by meaning</p>}

                {said.length > 0 && <FoundInClips hits={said} words={words} onOpen={(h) => openClip(h.asset, h.seconds)} />}

                {(searching ? !found : !first.data) || settling ? (
                  view === "list" ? <RowFrame /> : <TileFrame columns={columns} />
                ) : shown.length > 0 || shownFolders.length > 0 || placeholders.length > 0 ? (
                  view === "list" ? (
                    <div className="flex flex-col gap-1.5" style={LIST_CONTAINER}>
                      {shownFolders.map((c) => (
                        <FolderRow key={c.id} {...folderProps(c)} />
                      ))}
                      {placeholders.length > 0 && <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">{placeholders}</div>}
                      {shown.length > 0 && (
                        <ListHeader sort={sort} onSort={pickSort} />
                      )}
                      {shown.map((a) => (
                        <ClipPick key={a.id} row picked={picks.picked.has(a.id)} onPick={pickOf(a)} menu={menuFor(a)}>
                          <AssetRow asset={a} onOpen={() => openClip(a)} drag={dragOf(a)} />
                        </ClipPick>
                      ))}
                    </div>
                  ) : view === "gallery" ? (
                    <div className="flex flex-col gap-3">
                      {folderCards}
                    <GalleryGrid
                      assets={shown}
                      lead={galleryLead}
                      size={cardSize}
                      tile={(a, ownShape) => (
                        <ClipPick key={a.id} picked={picks.picked.has(a.id)} onPick={pickOf(a)} menu={menuFor(a)}>
                          <GalleryTile asset={a} onOpen={() => openClip(a)} drag={dragOf(a)} ownShape={ownShape} />
                        </ClipPick>
                      )}
                    />
                    </div>
                  ) : kind === "image" ? (
                    // photos in their own proportions, folders above them
                    <div className="flex flex-col gap-3">
                      {folderCards}
                      {placeholders.length > 0 && <FolderGrid size="small" columns={columns}>{placeholders}</FolderGrid>}
                      <PhotoMasonry assets={shown} tile={tile} />
                    </div>
                  ) : (
                    <FolderGrid size="small" columns={columns}>
                      {shownFolders.map((c) => (
                        <FolderCard key={c.id} {...folderProps(c)} covers={(c.covers ?? []).map((src) => ({ src }))} lines={c.sounds} />
                      ))}
                      {placeholders}
                      {shown.map(tile)}
                    </FolderGrid>
                  )
                ) : firstScreen ? null : (
                  libraries !== null && (
                    <p className="py-16 text-center text-sm text-zinc-500">
                      {narrowed
                        ? "No clips found"
                        : adding
                          ? null // the line above the grid says how many are in
                          : trash
                            ? "No clips in the trash"
                            : open
                              ? "No clips in this folder"
                              : "No clips"}
                    </p>
                  )
                )}

                {firstScreen && <EmptyDrop canAdd={mayAdd} onChoose={chooseFiles} waiting={waitingFolders} />}
                {setupOpen && library && <LibrarySetup library={library} watchAllowed={!!watch?.allowed} onDone={(l) => (saved(l), closeSetup())} onClose={closeSetup} />}

                {next &&
                  (watchesEnd() ? (
                    <div ref={endOfList} aria-hidden className="h-px" />
                  ) : (
                    <Button variant="outline" className="self-center" onClick={loadMore}>
                      Load more
                    </Button>
                  ))}
              </SpaceMenu>
            </>
          )}

          {(error ?? ((!libraries && libs.error) || (!first.data && first.error) || null)) && (
            <p className="text-sm text-red-400">{error ?? (libs.error || first.error)}</p>
          )}
        </main>
      </div>

      {library && pickedCards.length > 0 && (
        <PickBar
          count={pickedCards.length}
          all={next || pickedCards.length < pickable.length ? (pickingAll === pageKey ? "busy" : "more") : "all"}
          inTrash={trash}
          readOnly={readOnly}
          moveTo={moveOptions(collections, into)}
          tags={tags}
          redo={redoKinds(library.settings)}
          on={{
            download: () => download(pickedCards),
            move: (to) => void move(pickedCards.map((a) => a.id), to),
            tag: (t) => void tagMany(pickedCards, t),
            trash: () => void trashMany(pickedCards),
            restore: () => void trashMany(pickedCards, false),
            redo: (k) => redo(pickedCards, k),
            clear: picks.clear,
            pickAll: () => void pickAll(),
          }}
        />
      )}
      {sharing && libId && (
        <ClipShare libraryId={libId} assetId={sharing.id} versionId={sharing.versionId} title={sharing.title} open onOpenChange={(o) => !o && setSharing(null)} />
      )}
      {libId && <SmartFolderDialog libraryId={libId} folder={ruling} onClose={() => setRuling(null)} onSaved={reloadFolders} />}
      {libId && <ReorganizeDialog libraryId={libId} open={reorganizing} folders={collections} onClose={() => setReorganizing(false)} onDone={reloadFolders} />}
      {drop.dropping && mayAdd && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center border-4 border-dashed border-violet-500/70 bg-violet-950/30">
          <p className="rounded-xl bg-zinc-950/90 px-5 py-3 text-base font-medium text-zinc-100">Drop to add to {into && openFolder ? openFolder.name : "the library"}</p>
        </div>
      )}

      <ClipView open={preview !== null} onClose={closeClip}>
          {preview && libId && (
            <ClipPanel
              libraryId={libId}
              asset={preview}
              startAt={startAt}
              serverPlays={!library || hostsOriginals(library.settings.upload) || hostsProxies(library.settings.upload) || !!library.shared || !!preview.finished}
              inTrash={trash}
              readOnly={readOnly}
              mayKeepAsFilmed={!!library?.mayKeepAsFilmed}
              moveTo={moveOptions(collections, into)}
              onTrash={(t) => void trashMany([preview], t)}
              onPrev={((i) => (i > 0 ? () => openClip(shown[i - 1]!) : undefined))(shown.findIndex((x) => x.id === preview.id))}
              onNext={((i) => (i >= 0 && i < shown.length - 1 ? () => openClip(shown[i + 1]!) : undefined))(shown.findIndex((x) => x.id === preview.id))}
              onMove={(id) => move([preview.id], id)}
              onSaved={(a) => {
                setPreview(a);
                changeCards((all) => all.map((x) => (x.id === a.id ? { ...x, description: a.description, tags: a.tags, aiTags: a.aiTags } : x)));
              }}
              onError={setError}
            />
          )}
      </ClipView>
    </div>
  );
}
