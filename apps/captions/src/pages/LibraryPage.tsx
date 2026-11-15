import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Quote, Search, Upload } from "lucide-react";
import type { AssetCard, AssetKind, AssetPage, Collection, LibrarySummary, SearchHit, WatchStatus } from "@contracts/library";
import { AppBar } from "@/components/AppBar";
import { BrowseBar, NewFolderButton, TrashLink } from "@/components/browse/Bar";
import { askFolderName, askRename } from "@/components/browse/browse";
import { FolderCard, FolderRow, type FolderProps } from "@/components/browse/Folder";
import { FolderGrid } from "@/components/browse/Grid";
import { FolderTrail } from "@/components/browse/ToolFolders";
import { persistSort, storedSort, useBrowseView } from "@/components/browse/views";
import { FootageFolderCard } from "@/components/FootageFolderCard";
import { BIG_DROP, BigUploadDialog, LibraryProgressBar } from "@/components/LibraryProcessing";
import { Button } from "@/components/ui/button";
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
  libraryZipUrl,
  listTags,
  redoMany,
  updateAsset,
} from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";
import { droppedOnMac, pathOnMac } from "@/lib/thisMac";
import { undoable } from "@/lib/undo";
import { droppedFiles } from "@/components/assistant/draft";
import { LibraryFacetBar } from "@/components/LibraryFacetBar";
import { libraryFacets } from "@/lib/library-slots";
import { ClipPanel } from "./library/ClipPanel";
import { AssetRow, AssetTile, clock, RowFrame, TileFrame } from "./library/ClipCards";
import { alreadyThere, UploadTray, type Upload as UploadItem } from "./library/Uploads";
import { ClipView } from "./library/ClipView";
import { clipHref, folderTo, foldersAt, holdsClips, moveOptions, moveSteps, trailOf } from "./library/folders";
import { ClipShare } from "./library/ClipShare";
import { macPaths, useEndOfList, useEscapeSteps, useSelectAll, watchesEnd } from "./library/grid";
import { ClipMenu, ClipPick, PickBar, redoKinds, saveFile, usePicks } from "./library/Selection";
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

/** A-roll or B-roll, as the server sorted the clip (api/library/roll.ts); finished work and unsorted clips have none. */
type Roll = "a" | "b";
const rollOf = (a: AssetCard) => a.roll;
const ROLLS: { value: Roll | null; label: string }[] = [
  { value: null, label: "All" },
  { value: "a", label: "A-roll" },
  { value: "b", label: "B-roll" },
];


/** what a clip carries when it is dragged onto a folder */
const DRAG = "application/x-ct-media-item";
const SORTS = ["new", "old", "name", "longest", "shortest", "filmed"] as const;
const SORT_KEY = "library:sort";

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
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [asking, setAsking] = useState<File[] | null>(null); // a big upload, waiting for its go after the estimate
  const askingPaths = useRef<Map<File, string> | undefined>(undefined); // those files' places on this Mac (a Finder drop)
  const [dropping, setDropping] = useState(false); // files held over the page
  const [sharing, setSharing] = useState<AssetCard | null>(null); // the clip whose share box is open (right-click Share…)
  const [tags, setTags] = useState<string[]>([]); // the library's tags, most used first (Add tag)
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
  const loading = useRef<string | null>(null); // the cursor of the page on its way
  const loc = useLocation();
  const keys = useRef(0);

  const library = libraries?.find((l) => l.id === libraryId) ?? libraries?.[0] ?? null;
  const libId = library?.id;
  const folderList = useCachedLoad<Collection[]>(libId ? `/api/library/${libId}/collections` : null, () => listCollections(libId!));
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
  const adding = !!watch?.folders.some((f) => f.adding > 0);

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
  const picked = kind !== "all" || !!roll || Object.values(facets).some((v) => v.length);
  const folder = trash ? { trashed: true } : open ? { collectionId: open } : picked ? {} : { unfiled: true };
  const query = { q: term || undefined, kind: kind === "all" ? undefined : [kind], facets, ...folder, source: source || undefined, roll: roll ?? undefined, sort };
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
  // in the sort picked, by the server (api/library/query.ts) across every page; a search keeps its own order, best first
  const shown = items;
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
    const p = new URLSearchParams(linked);
    p.delete("asset");
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
    navigate({ search: p.size ? `?${p}` : "" }, { replace: true });
  };
  useEffect(() => {
    if (!clipId) return setPreview(null);
    const lib = linkedLib ?? libId;
    if (!lib || preview?.id === clipId) return;
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
    if (!libId || !next || !pageKey || loading.current === next) return;
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

  const patch = (key: number, change: Partial<UploadItem>) =>
    setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, ...change } : u)));

  const send = async (u: UploadItem) => {
    if (!libId) return;
    try {
      const here = u.path ?? (await pathOnMac(u.file));
      // a file that is in the library already never goes, nor is taken in where it is (a failed check: the server checks too)
      const dup = await alreadyThere(libId, u.file, () => patch(u.key, { status: "checking", error: undefined })).catch(() => null);
      if (dup) return patch(u.key, { status: "duplicate", sent: u.file.size, error: undefined });
      patch(u.key, { status: "uploading", sent: 0, error: undefined });
      const r = await uploadFile(libId, u.file, (sent, inPlace) => patch(u.key, { sent, inPlace }), u.folderId, here);
      patch(u.key, r.duplicateOf ? { status: "duplicate", sent: u.file.size } : { status: "added", sent: u.file.size });
      reload();
      if (u.folderId) reloadFolders(); // the folder's count
    } catch (e) {
      patch(u.key, { status: "failed", error: message(e), final: (e as { code?: string }).code === "too_large" });
    }
  };

  // a big upload says first what preparing it takes (time, and money on whose AI and keys)
  const addFiles = async (files: FileList | File[] | null, paths?: Map<File, string>) => {
    if (!files?.length) return;
    const all = Array.from(files); // before the picker is cleared
    // picked or dropped in the Mac app on its own server: they are added where they are (lib/library.ts uploadFile)
    const here = paths ? paths.size === all.length : !!(await pathOnMac(all[0]!));
    if (all.length >= BIG_DROP) {
      askingPaths.current = paths;
      setAskingHere(here);
      setAsking(all);
    } else start(all, here, paths);
  };

  // files and folders dropped on the page: each folder's files (with the folders in it), into the open folder; in the
  // Mac app each file is added where it is on this Mac (the drop's Finder items say where)
  const holdsFiles = (e: React.DragEvent) => !!libId && e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes(DRAG);
  const dropFiles = (dt: DataTransfer) => {
    const reading = droppedFiles(dt); // takes the drop's items now: they are gone after the event
    void Promise.all([reading, droppedOnMac()]).then(
      ([got, items]) => addFiles(got.files, items?.length ? macPaths(got.files, items) : undefined),
      (e) => setError(message(e)),
    );
  };

  // one file after another: the server's disk and the phone's data are both easier on that
  const start = (files: File[], here = false, paths?: Map<File, string>) => {
    const folderId = into ?? undefined;
    const added = files.map((file) => ({ key: ++keys.current, file, sent: 0, folderId, status: "waiting" as const, inPlace: paths ? paths.has(file) : here, path: paths?.get(file) }));
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

  /** The cards the page holds, changed where they are: the first page and the pages loaded after it. */
  const changeCards = (fix: (all: AssetCard[]) => AssetCard[]) => {
    first.set((p) => p && { ...p, items: fix(p.items) });
    setMore((m) => m && { ...m, items: fix(m.items) });
  };

  // clips dragged onto a folder, moved from their window, the bar or their menu: into that folder, out of the one open
  // (`from`); Undo moves them back
  const move = async (ids: string[], to: string | null, from: string | null = into, undo = true) => {
    if (!libId) return;
    const step = moveSteps(from, to);
    try {
      if (step.add) await changeFolderItems(libId, step.add, ids, true);
      if (step.remove) await changeFolderItems(libId, step.remove, ids, false);
    } catch (e) {
      setError(message(e));
      undo = false;
    }
    // gone from this view: the folder open, or the top level's clips in no folder (a page loaded later is not read again)
    if (undo && from === into && (into || (!open && !trash && !picked))) changeCards((all) => all.filter((x) => !ids.includes(x.id)));
    reload();
    reloadFolders();
    if (undo) {
      picks.clear();
      undoable("moved", () => move(ids, from, to, false), ids.length);
    }
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
            e.dataTransfer.setData(DRAG, carried(a).map((x) => x.id).join(","));
            e.dataTransfer.effectAllowed = "move";
          },
        };

  // several clips picked (./library/Selection.tsx): in this view only; a plug-in source's items are not picked
  const pickable = shown.filter((a) => !a.id.startsWith("ext_"));
  const picks = usePicks(`${pageKey}|${words}`, pickable.map((a) => a.id));
  const pickedCards = pickable.filter((a) => picks.picked.has(a.id));
  /** what a clip's menu or drag acts on: every picked clip when it is one of them */
  const carried = (a: AssetCard) => (picks.picked.has(a.id) && pickedCards.length > 1 ? pickedCards : [a]);
  useSelectAll(() => picks.set(pickable.map((a) => a.id)));
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
    if (done.length < cards.length) setError(`${plural(cards.length - done.length)} couldn't be ${toTrash ? "moved to the trash" : "restored"}`);
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
    if (done.length < these.length) setError(`${plural(these.length - done.length)} couldn't be tagged`);
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
      (r) => toast(r.clips ? `${label} are made again for ${plural(r.clips)}` : `Nothing to redo`),
      (e) => setError(message(e)),
    );
    picks.clear();
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
      />
    );
  const pickOf = (a: AssetCard) => (a.id.startsWith("ext_") ? undefined : (range: boolean) => picks.pick(a.id, range));

  // the Upload button's handler: the top bar's button and the first screen's second way both call it
  const chooseFiles = () => picker.current?.click();

  return (
    <div
      className="flex min-h-dvh flex-col"
      onDragOver={(e) => {
        if (!holdsFiles(e)) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        if (!holdsFiles(e)) return;
        e.preventDefault();
        dropFiles(e.dataTransfer);
      }}
    >
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
            start(asking, askingHere, askingPaths.current);
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
                  { id: "old", label: "Oldest" },
                  { id: "name", label: "Name" },
                  { id: "longest", label: "Longest" },
                  { id: "shortest", label: "Shortest" },
                  { id: "filmed", label: "Date filmed" },
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
              {/* a plug-in's facets narrow its source's items: with no source of it here (another workspace's library), none */}
              {sources.length > 0 && <LibraryFacetBar facets={libraryFacets("library")} value={facets} onChange={setFacets} />}
            </div>

            <LibraryProgressBar libraryId={library.id} />

            <UploadTray uploads={uploads} onRetry={(u) => void send(u)} onClear={() => setUploads((prev) => prev.filter((u) => u.status === "uploading" || u.status === "waiting"))} />

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
                    <ClipPick key={a.id} row picked={picks.picked.has(a.id)} onPick={pickOf(a)} menu={menuFor(a)}>
                      <AssetRow asset={a} onOpen={() => openClip(a)} drag={dragOf(a)} />
                    </ClipPick>
                  ))}
                </div>
              ) : (
                <FolderGrid size="small">
                  {shownFolders.map((c) => (
                    <FolderCard key={c.id} {...folderProps(c)} covers={(c.covers ?? []).map((src) => ({ src }))} />
                  ))}
                  {shown.map((a) => (
                    <ClipPick key={a.id} picked={picks.picked.has(a.id)} onPick={pickOf(a)} menu={menuFor(a)}>
                      <AssetTile asset={a} onOpen={() => openClip(a)} drag={dragOf(a)} />
                    </ClipPick>
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

            {next &&
              (watchesEnd() ? (
                <div ref={endOfList} aria-hidden className="h-px" />
              ) : (
                <Button variant="outline" className="self-center" onClick={loadMore}>
                  Load more
                </Button>
              ))}
          </>
        )}

        {(error ?? ((!libraries && libs.error) || (!first.data && first.error) || null)) && (
          <p className="text-sm text-red-400">{error ?? (libs.error || first.error)}</p>
        )}
      </main>

      {library && pickedCards.length > 0 && (
        <PickBar
          count={pickedCards.length}
          inTrash={trash}
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
          }}
        />
      )}
      {sharing && libId && (
        <ClipShare libraryId={libId} assetId={sharing.id} versionId={sharing.versionId} title={sharing.title} open onOpenChange={(o) => !o && setSharing(null)} />
      )}
      {dropping && (
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
              inTrash={trash}
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
