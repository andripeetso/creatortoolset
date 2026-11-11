import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { AudioLines, Quote, FileText, Image as ImageIcon, Upload, Video } from "lucide-react";
import type { AssetCard, AssetKind, AssetPage, Collection, LibrarySummary, SearchHit, WatchStatus } from "@contracts/library";
import { AppBar } from "@/components/AppBar";
import { FootageFolderCard } from "@/components/FootageFolderCard";
import { BIG_DROP, BigUploadDialog, ClipStage, LibraryProgressBar } from "@/components/LibraryProcessing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  createCollection,
  createLibrary,
  getAsset,
  getWatch,
  isFinals,
  listAssets,
  listCollections,
  listLibraries,
  listSources,
  changeFolderItems,
  searchLibrary,
  setTrashed,
  uploadFile,
  audioOf,
} from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";
import { cn } from "@/lib/utils";
import { LibraryFacetBar } from "@/components/LibraryFacetBar";
import { libraryBadges, libraryFacets } from "@/lib/library-slots";
import { AiBadge, ClipPanel } from "./library/ClipPanel";
import { ClipView } from "./library/ClipView";
import { LibraryFolders } from "./library/LibraryFolders";
import { LibrarySettings } from "./library/LibrarySettings";

/**
 * Media Library (/library): the person's raw materials, one library's footage as a grid of 16:9 cards. An empty library
 * is one screen: what the library is for and the folder to choose (FootageFolderCard), upload as the second way. Above
 * the grid: the search, the kind, the folders and the settings button, then one row to narrow (A-roll and B-roll first),
 * then the progress while there is any. Search runs over titles and tags (FTS5, api/library/query.ts), and over what is
 * said in the clips (api/library/search.ts): a line said opens the preview at its second. A card opens its preview.
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
  status: "uploading" | "added" | "duplicate" | "failed";
  error?: string;
  inPlace?: boolean; // added where it is on this Mac, not uploaded
  final?: boolean; // refused for good (too large for this server): no Retry
}

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
  const [preview, setPreview] = useState<AssetCard | null>(null);
  const [startAt, setStartAt] = useState(0); // the second the preview opens at (a line said in it)
  const [said, setSaid] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState("all"); // "all", "trash", or a collection id
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
  // the footage folders (the owner's view; anyone else gets an error and no settings): an empty grid says whether clips
  // are on their way from one
  const watchLoad = useCachedLoad<WatchStatus>(libId ? `/api/library/${libId}/watch` : null, () => getWatch(libId!));
  const watch = watchLoad.data;
  const adding = !!watch?.folders.some((f) => f.adding > 0);
  const [linked] = useSearchParams(); // ?library=&asset= (the Video Cleaner's duplicate check links here)

  useEffect(() => {
    const lib = linked.get("library");
    const asset = linked.get("asset");
    if (lib) setLibraryId(lib);
    if (lib && asset) getAsset(lib, asset).then((a) => open(a), (e) => setError(message(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked]);

  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  // the first page for the current library, search, kind and folder, kept per view; "Load more" pages add to it
  const folder = scope === "all" ? {} : scope === "trash" ? { trashed: true } : { collectionId: scope };
  const query = { q: term || undefined, kind: kind === "all" ? undefined : [kind], facets, ...folder, source: source || undefined, roll: roll ?? undefined };
  const pageKey = libId ? `/api/library/${libId}/assets?view=${encodeURIComponent(JSON.stringify(query))}` : null;
  const first = useCachedLoad<AssetPage>(pageKey, () => listAssets(libId!, query));
  const reload = () => void first.refresh().catch((e) => setError(message(e)));
  const [more, setMore] = useState<{ key: string; items: AssetCard[]; next?: string } | null>(null);
  const extra = more && more.key === pageKey ? more : null;
  const shownIds = new Set(first.data?.items.map((a) => a.id));
  const items = [...(first.data?.items ?? []), ...(extra?.items.filter((a) => !shownIds.has(a.id)) ?? [])];
  const next = extra ? extra.next : first.data?.next;
  // A-roll / B-roll is the server's filter (the whole library, not only the pages loaded); the row shows once clips are sorted
  const hasRoll = items.some((a) => rollOf(a));
  const shown = items;
  const narrowed = !!term || kind !== "all" || !!roll || Object.values(facets).some((v) => v.length) || !!source;

  // an empty library is one screen (what it is for, the folder to choose): nothing in it, nothing in its trash, no
  // footage folder, no plug-in source, no upload on its way. Until all of that is known the grid's frame stands.
  const emptyView = scope === "all" && !narrowed && first.data?.items.length === 0;
  const trashPeek = useCachedLoad<AssetPage>(emptyView && libId ? `/api/library/${libId}/assets?view=trash-peek` : null, () =>
    listAssets(libId!, { trashed: true, limit: 1 }),
  );
  const watchKnown = watch !== null || !!watchLoad.error;
  const firstScreen =
    emptyView && watchKnown && sourceList?.length === 0 && !watch?.folders.length && !uploads.length && !asking && trashPeek.data?.items.length === 0;
  const settling = emptyView && !firstScreen && (!watchKnown || !trashPeek.data || !sourceList); // still finding out: the frame, not a wrong screen

  // the plug-in sources this account may browse here (none unless a plug-in brings one)
  useEffect(() => {
    if (!libId) return;
    listSources(libId)
      .then(setSources)
      .catch(() => setSources([]));
  }, [libId]);

  // lines said in the clips that match the search
  useEffect(() => {
    if (!libId || !term || scope === "trash") return setSaid([]);
    let live = true;
    searchLibrary(libId, term, facets)
      .then((hits) => live && setSaid(hits.filter((h) => h.seconds !== undefined)))
      .catch(() => live && setSaid([]));
    return () => void (live = false);
  }, [libId, term, scope, facets]);

  const open = (a: AssetCard, at = 0) => {
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
  const addFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const all = Array.from(files);
    if (all.length >= BIG_DROP) setAsking(all);
    else start(all);
  };

  // one file after another: the server's disk and the phone's data are both easier on that
  const start = (files: File[]) => {
    const folderId = collections.find((c) => c.id === scope && c.kind === "manual")?.id;
    const added = files.map((file) => ({ key: ++keys.current, file, sent: 0, folderId, status: "uploading" as const }));
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

  const newFolder = async (name: string) => {
    if (!libId) return;
    try {
      await createCollection(libId, { name: name.slice(0, 80) });
      reloadFolders();
    } catch (e) {
      setError(message(e));
      throw e;
    }
  };

  // the current search and kind, kept as a smart folder that runs them again
  const saveSearch = async () => {
    if (!libId || !term) return;
    try {
      const c = await createCollection(libId, {
        name: term.slice(0, 80),
        kind: "smart",
        query: { q: term, kind: kind === "all" ? undefined : [kind] },
      });
      reloadFolders();
      setScope(c.id);
    } catch (e) {
      setError(message(e));
    }
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

  const addToFolder = async (a: AssetCard, folderId: string) => {
    if (!libId || !folderId) return;
    try {
      await changeFolderItems(libId, folderId, [a.id], true);
      reloadFolders();
    } catch (e) {
      setError(message(e));
    }
  };

  const label = (u: Upload) =>
    u.status === "uploading"
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
        {library && !firstScreen && (
          <Button size="sm" onClick={chooseFiles}>
            <Upload className="h-4 w-4" />
            Upload
          </Button>
        )}
      </AppBar>
      {asking && libId && (
        <BigUploadDialog
          libraryId={libId}
          drop={{ clips: asking.length, bytes: asking.reduce((n, f) => n + f.size, 0), ...audioOf(asking) }}
          title={`Upload ${asking.length.toLocaleString()} clips?`}
          go="Upload"
          onClose={() => setAsking(null)}
          onUpload={() => {
            start(asking);
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
          addFiles(e.target.files);
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
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search titles, tags and what is said"
                aria-label="Search"
                className="min-w-0 flex-1 basis-full sm:basis-72"
              />
              <select
                aria-label="Kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as AssetKind | "all")}
                className="h-8 rounded-md border border-zinc-500/30 bg-transparent px-2 text-sm"
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
              <LibraryFolders
                folders={collections}
                open={scope}
                onOpen={setScope}
                onMake={newFolder}
                onSaveSearch={term ? () => void saveSearch() : undefined}
              />
              {watch && (
                <LibrarySettings
                  library={library}
                  watch={watch}
                  folders={collections.filter((c) => c.kind === "manual")}
                  onChange={(l) => setLibraries((all) => all?.map((x) => (x.id === l.id ? l : x)) ?? all)}
                  onError={setError}
                />
              )}
            </div>

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
                  <span className="font-medium">Uploads</span>
                  <Button variant="ghost" size="sm" onClick={() => setUploads((prev) => prev.filter((u) => u.status === "uploading"))}>
                    Clear finished
                  </Button>
                </div>
                {uploads.map((u) => (
                  <div key={u.key} className="flex flex-col gap-1 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate">{u.file.name}</span>
                      <span className="shrink-0 text-xs text-zinc-500">{label(u)}</span>
                    </div>
                    {u.status === "uploading" && <Progress value={(u.sent / Math.max(1, u.file.size)) * 100} className="h-1.5" />}
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

            {said.length > 0 && (
              <section aria-label="Said in clips" className="flex flex-col gap-1 rounded-xl border border-zinc-500/20 p-3">
                <span className="text-sm font-medium">Said in clips</span>
                {said.slice(0, 12).map((h, i) => (
                  <button
                    key={`${h.asset.versionId}-${i}`}
                    type="button"
                    onClick={() => open(h.asset, h.seconds)}
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

            {!first.data || settling ? (
              <TileFrame />
            ) : shown.length > 0 ? (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {shown.map((a) => (
                  <li key={a.id}>
                    <AssetTile asset={a} onOpen={() => open(a)} />
                  </li>
                ))}
              </ul>
            ) : (
              libraries !== null && (
                <p className="py-16 text-center text-sm text-zinc-500">
                  {narrowed
                    ? "No matches."
                    : adding
                      ? null // the line above the grid says how many are in
                      : scope === "trash"
                        ? "The trash is empty."
                        : scope !== "all"
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
              inTrash={scope === "trash"}
              folders={collections.filter((c) => c.kind === "manual")}
              onTrash={(trash) => void moveAsset(preview, trash)}
              onPrev={((i) => (i > 0 ? () => open(items[i - 1]!) : undefined))(items.findIndex((x) => x.id === preview.id))}
              onNext={((i) => (i >= 0 && i < items.length - 1 ? () => open(items[i + 1]!) : undefined))(items.findIndex((x) => x.id === preview.id))}
              onAddToFolder={(id) => void addToFolder(preview, id)}
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
function AssetTile({ asset: a, onOpen }: { asset: AssetCard; onOpen: () => void }) {
  const Icon = KIND_ICON[a.kind];
  const preparing = a.state === "processing" && !a.thumbUrl;
  return (
    <button type="button" onClick={onOpen} data-state={a.state} className="group flex w-full flex-col gap-1.5 text-left">
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
