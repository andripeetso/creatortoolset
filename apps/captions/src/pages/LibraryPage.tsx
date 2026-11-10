import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { AudioLines, Captions, MessageSquare, Quote, Share2, FileText, Folder, Image as ImageIcon, Loader2, RotateCcw, Star, Trash2, Upload, Video } from "lucide-react";
import type { AssetCard, AssetDetail, AssetKind, AssetPage, Collection, LibrarySummary, SearchHit } from "@contracts/library";
import { AppBar } from "@/components/AppBar";
import { ToolSetupLine } from "@/components/setup/ToolSetupLine";
import { FootageFolderCard } from "@/components/FootageFolderCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  createCollection,
  createLibrary,
  createShare,
  getAsset,
  listAssets,
  listCollections,
  listLibraries,
  listSources,
  changeFolderItems,
  openInCaptions,
  rerunJobs,
  searchLibrary,
  setTrashed,
  updateAsset,
  updateLibrary,
  uploadFile,
} from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";
import { cn } from "@/lib/utils";
import { LibraryFacetBar } from "@/components/LibraryFacetBar";
import { libraryBadges, libraryFacets } from "@/lib/library-slots";
import { LibraryStorageSettings } from "./LibraryStorage";
import { LibraryWatchFolders } from "./LibraryWatchFolders";

/**
 * Media Library (/library): one library's footage as a grid of 16:9 cards. Search runs over titles and tags
 * (FTS5, api/library/query.ts), and over what is said in the clips (api/library/search.ts): a line said opens the
 * preview at its second. A card opens its preview. Uploads go in one at a time, from the tray. A card being prepared
 * updates when the server finishes it (the change stream), without polling.
 */

const KINDS: { value: AssetKind | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "video", label: "Video" },
  { value: "audio", label: "Audio" },
  { value: "image", label: "Images" },
  { value: "doc", label: "Other" },
];
const KIND_ICON: Record<AssetKind, typeof Video> = { video: Video, audio: AudioLines, image: ImageIcon, doc: FileText };
const STATE_DOT: Partial<Record<AssetCard["state"], string>> = {
  processing: "bg-amber-400 animate-pulse",
  failed: "bg-red-500",
  missing: "bg-zinc-500",
};

interface Upload {
  key: number;
  file: File;
  sent: number;
  /** the manual folder open when the file was dropped: it goes in there */
  folderId?: string;
  status: "uploading" | "added" | "duplicate" | "failed";
  error?: string;
}

/** Finals: a plain manual collection, pinned first in every library and made the first time someone uses it. */
const FINALS = "Finals";
const isFinals = (c: Collection) => c.kind === "manual" && c.parentId === null && c.name === FINALS;

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
  const [facets, setFacets] = useState<Record<string, string[]>>({}); // plug-in sidebar filters picked so far
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [preview, setPreview] = useState<AssetCard | null>(null);
  const [startAt, setStartAt] = useState(0); // the second the preview opens at (a line said in it)
  const [said, setSaid] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState("all"); // "all", "trash", or a collection id
  const [source, setSource] = useState(""); // "" = this library, else a plug-in source's id (its cards only)
  const [sources, setSources] = useState<{ id: string; label: string }[]>([]);
  const [folderName, setFolderName] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const keys = useRef(0);

  const library = libraries?.find((l) => l.id === libraryId) ?? libraries?.[0] ?? null;
  const libId = library?.id;
  const folderList = useCachedLoad<Collection[]>(libId ? `/api/library/${libId}/collections` : null, () => listCollections(libId!));
  const collections = folderList.data ?? [];
  const reloadFolders = () => void folderList.refresh().catch((e) => setError(message(e)));
  const finals = collections.find(isFinals);
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
  const query = { q: term || undefined, kind: kind === "all" ? undefined : [kind], facets, ...folder, source: source || undefined };
  const pageKey = libId ? `/api/library/${libId}/assets?view=${encodeURIComponent(JSON.stringify(query))}` : null;
  const first = useCachedLoad<AssetPage>(pageKey, () => listAssets(libId!, query));
  const reload = () => void first.refresh().catch((e) => setError(message(e)));
  const [more, setMore] = useState<{ key: string; items: AssetCard[]; next?: string } | null>(null);
  const extra = more && more.key === pageKey ? more : null;
  const shownIds = new Set(first.data?.items.map((a) => a.id));
  const items = [...(first.data?.items ?? []), ...(extra?.items.filter((a) => !shownIds.has(a.id)) ?? [])];
  const next = extra ? extra.next : first.data?.next;

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
      const r = await uploadFile(libId, u.file, (sent) => patch(u.key, { sent }), u.folderId);
      patch(u.key, r.duplicateOf ? { status: "duplicate", sent: u.file.size } : { status: "added", sent: u.file.size });
      reload();
      if (u.folderId) reloadFolders(); // the folder's count
    } catch (e) {
      patch(u.key, { status: "failed", error: message(e) });
    }
  };

  // one file after another: the server's disk and the phone's data are both easier on that
  const addFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const folderId = collections.find((c) => c.id === scope && c.kind === "manual")?.id;
    const added = Array.from(files).map((file) => ({ key: ++keys.current, file, sent: 0, folderId, status: "uploading" as const }));
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

  const newFolder = async () => {
    if (!libId || !folderName.trim()) return;
    try {
      await createCollection(libId, { name: folderName.trim().slice(0, 80) });
      setFolderName("");
      reloadFolders();
    } catch (e) {
      setError(message(e));
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

  // ponytail: two people opening Finals at once can make two; the first one made is the one shown
  const finalsId = async (): Promise<string> => {
    if (finals) return finals.id;
    const c = await createCollection(libId!, { name: FINALS });
    reloadFolders();
    return c.id;
  };
  const openFinals = () =>
    finalsId().then(setScope, (e) => setError(message(e)));

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
      ? `Uploading ${Math.round((u.sent / Math.max(1, u.file.size)) * 100)}%`
      : u.status === "added"
        ? "Added"
        : u.status === "duplicate"
          ? "Already in library"
          : "Failed";

  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar tool="Media Library" trail={library?.name}>
        {library && (
          <Button size="sm" onClick={() => picker.current?.click()}>
            <Upload className="h-4 w-4" />
            Upload
          </Button>
        )}
      </AppBar>
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
        <ToolSetupLine tool="media" />
        {library && <FootageFolderCard libraryId={library.id} onUpload={() => picker.current?.click()} />}
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

        {library && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search titles, tags and what is said"
                aria-label="Search"
                className="min-w-0 flex-1 basis-full sm:basis-72 sm:flex-none"
              />
              <div role="group" aria-label="Kind" className="flex flex-wrap gap-1.5">
                {KINDS.map((k) => (
                  <Button
                    key={k.value}
                    size="sm"
                    variant={kind === k.value ? "default" : "outline"}
                    aria-pressed={kind === k.value}
                    onClick={() => setKind(k.value)}
                  >
                    {k.label}
                  </Button>
                ))}
              </div>
              <LibraryFacetBar facets={libraryFacets("library")} value={facets} onChange={setFacets} />
            </div>

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

            <div role="group" aria-label="Folders" className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant={scope === "all" ? "default" : "outline"} aria-pressed={scope === "all"} onClick={() => setScope("all")}>
                All
              </Button>
              <Button size="sm" variant={finals && scope === finals.id ? "default" : "outline"} aria-pressed={!!finals && scope === finals.id} onClick={() => void openFinals()}>
                <Star className="h-3.5 w-3.5" />
                {FINALS}
                {finals?.count ? <span className="text-xs opacity-60">{finals.count}</span> : null}
              </Button>
              {collections.filter((c) => c !== finals).map((c) => (
                <Button key={c.id} size="sm" variant={scope === c.id ? "default" : "outline"} aria-pressed={scope === c.id} onClick={() => setScope(c.id)}>
                  <Folder className="h-3.5 w-3.5" />
                  {c.name}
                </Button>
              ))}
              <Button size="sm" variant={scope === "trash" ? "default" : "outline"} aria-pressed={scope === "trash"} onClick={() => setScope("trash")}>
                <Trash2 className="h-3.5 w-3.5" />
                Trash
              </Button>
              <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void newFolder();
                }}
              >
                <Input value={folderName} onChange={(e) => setFolderName(e.target.value)} placeholder="New folder" aria-label="New folder" className="h-8 w-36" />
                <Button type="submit" size="sm" variant="ghost" disabled={!folderName.trim()}>
                  Add
                </Button>
              </form>
              {term && (
                <Button size="sm" variant="ghost" onClick={() => void saveSearch()}>
                  Save search as folder
                </Button>
              )}
            </div>

            <LibraryWatchFolders libraryId={library.id} folders={collections.filter((c) => c.kind === "manual")} />
            <LibraryStorageSettings
              libraryId={library.id}
              onSaved={(storage) => setLibraries((all) => all?.map((x) => (x.id === library.id ? { ...x, storage } : x)) ?? all)}
            />
            <AiSwitches library={library} onChange={(l) => setLibraries((all) => all?.map((x) => (x.id === l.id ? l : x)) ?? all)} onError={setError} />

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
                        <span className="truncate">{u.error}</span>
                        <Button variant="outline" size="sm" onClick={() => void send(u)}>
                          Retry
                        </Button>
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

            {!first.data ? (
              <TileFrame />
            ) : items.length > 0 ? (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {items.map((a) => (
                  <li key={a.id}>
                    <AssetTile asset={a} onOpen={() => open(a)} />
                  </li>
                ))}
              </ul>
            ) : (
              libraries !== null && (
                <p className="py-16 text-center text-sm text-zinc-500">
                  {term || kind !== "all" || Object.values(facets).some((v) => v.length) ? "No matches." : "Nothing here yet. Upload a file to start."}
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

      <Sheet open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-xl">
          {preview && (
            <div className="flex flex-col gap-3 p-4 pt-12">
              <SheetTitle className="truncate text-base">{preview.title}</SheetTitle>
              <SheetDescription className="text-xs text-zinc-500">
                {[
                  preview.durationS !== undefined && clock(preview.durationS),
                  preview.width && `${preview.width}×${preview.height}`,
                  `version ${preview.versionN}`,
                  preview.state !== "ready" && preview.state,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </SheetDescription>
              <div className="flex flex-wrap items-center gap-2">
                {preview.review ? (
                  // Review owns its versions and its trash (one in Review's trash opens there): the library's trash answers 409 for it
                  <Button size="sm" variant="outline" asChild>
                    <Link to={preview.trashedAt ? "/review?trash=1" : `/review/${preview.id}`}>
                      <MessageSquare className="h-4 w-4" />
                      Open in Review
                    </Link>
                  </Button>
                ) : scope === "trash" ? (
                  <Button size="sm" variant="outline" onClick={() => void moveAsset(preview, false)}>
                    <RotateCcw className="h-4 w-4" />
                    Restore
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => void moveAsset(preview, true)}>
                    <Trash2 className="h-4 w-4" />
                    Move to trash
                  </Button>
                )}
                {scope !== "trash" && (
                  <Button size="sm" variant="outline" onClick={() => void finalsId().then((id) => addToFolder(preview, id), (e) => setError(message(e)))}>
                    <Star className="h-4 w-4" />
                    Add to {FINALS}
                  </Button>
                )}
                {collections.some((c) => c.kind === "manual") && (
                  <select
                    aria-label="Add to folder"
                    value=""
                    onChange={(e) => void addToFolder(preview, e.target.value)}
                    className="h-9 rounded-md border border-zinc-500/30 bg-transparent px-2 text-sm"
                  >
                    <option value="">Add to folder…</option>
                    {collections
                      .filter((c) => c.kind === "manual")
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                )}
              </div>
              {preview.state === "missing" && (
                <p className="text-sm text-zinc-400">
                  The original is gone from its watch folder: moved, renamed, or the drive is unplugged. Nothing was deleted; it comes back
                  when the file does.
                </p>
              )}
              {libId && (
                <DescriptionBox
                  key={preview.versionId}
                  libraryId={libId}
                  asset={preview}
                  readOnly={scope === "trash"}
                  onSaved={(a) => {
                    setPreview(a);
                    const fix = (all: AssetCard[]) => all.map((x) => (x.id === a.id ? { ...x, description: a.description, tags: a.tags, aiTags: a.aiTags } : x));
                    first.set((page) => page && { ...page, items: fix(page.items) });
                    setMore((m) => m && { ...m, items: fix(m.items) });
                  }}
                  onError={setError}
                />
              )}
              {libId && scope !== "trash" && <ShareBox libraryId={libId} assetId={preview.id} />}
              {preview.kind === "image" ? (
                <img src={`/api/library/media/${preview.versionId}/play`} alt={preview.title} className="w-full rounded-lg" />
              ) : (
                libId && <Player libraryId={libId} asset={preview} startAt={startAt} inTrash={scope === "trash"} onError={setError} />
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
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

function AssetTile({ asset: a, onOpen }: { asset: AssetCard; onOpen: () => void }) {
  const Icon = KIND_ICON[a.kind];
  const dot = STATE_DOT[a.state];
  return (
    <button type="button" onClick={onOpen} data-state={a.state} className="group flex w-full flex-col gap-1.5 text-left">
      <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-zinc-900 ring-1 ring-zinc-500/20 transition group-hover:ring-zinc-400/60">
        {a.thumbUrl ? (
          <img src={a.thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-zinc-600">
            <Icon className="h-8 w-8" />
          </div>
        )}
        {a.durationS !== undefined && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-white">
            {clock(a.durationS)}
          </span>
        )}
        {dot && <span title={a.state} className={cn("absolute left-2 top-2 h-2.5 w-2.5 rounded-full ring-2 ring-black/40", dot)} />}
      </div>
      <span className="truncate text-sm font-medium">{a.title}</span>
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

const AiBadge = () => (
  <span title="Written by AI" className="mr-1 rounded bg-zinc-500/20 px-1 py-px text-[10px] font-medium uppercase text-zinc-400">
    AI
  </span>
);

/** The owner's switches: both spend AI on every new upload, so both start off. */
function AiSwitches({ library, onChange, onError }: { library: LibrarySummary; onChange: (l: LibrarySummary) => void; onError: (e: string) => void }) {
  const flip = (key: "describe" | "embed", on: boolean) =>
    updateLibrary(library.id, { settings: { [key]: on } })
      .then(onChange)
      .catch((e) => onError(message(e)));
  const row = (key: "describe" | "embed", text: string) => (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={library.settings[key]} onChange={(e) => void flip(key, e.target.checked)} />
      {text}
    </label>
  );
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-zinc-400">
      {row("describe", "AI describes new videos")}
      {row("embed", "Search by meaning (OpenAI key)")}
    </div>
  );
}

/**
 * The asset's description: a person's text wins over the AI's, which shows (marked AI) until someone writes one.
 * Saving an empty box removes the person's text. "Describe with AI" queues the describe job as the caller.
 */
function DescriptionBox({
  libraryId,
  asset,
  readOnly,
  onSaved,
  onError,
}: {
  libraryId: string;
  asset: AssetCard;
  readOnly: boolean;
  onSaved: (a: AssetCard) => void;
  onError: (e: string) => void;
}) {
  const mine = asset.description?.source === "user" ? asset.description.text : "";
  const [text, setText] = useState(mine);
  const [queued, setQueued] = useState(false);
  const save = () =>
    updateAsset(libraryId, asset.id, { description: text.trim() })
      .then(onSaved)
      .catch((e) => onError(message(e)));
  const describe = () =>
    rerunJobs(libraryId, asset.id, ["describe"])
      .then(() => setQueued(true))
      .catch((e) => onError(message(e)));
  return (
    <section aria-label="Description" className="flex flex-col gap-1.5 text-sm">
      {asset.description?.source === "ai" && (
        <p className="text-zinc-400">
          <AiBadge />
          {asset.description.text}
        </p>
      )}
      {readOnly ? (
        mine && <p>{mine}</p>
      ) : (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder={asset.description ? "Your own description (shown instead of the AI's)" : "Describe this clip"}
            aria-label="Description"
            className="w-full rounded-md border border-zinc-500/30 bg-transparent p-2"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={text.trim() === mine} onClick={() => void save()}>
              Save description
            </Button>
            {(asset.kind === "video" || asset.kind === "image") && (
              <Button size="sm" variant="ghost" disabled={queued} onClick={() => void describe()}>
                {queued ? "Queued: the AI's description shows when it is done" : "Describe with AI"}
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** A share link for one asset: watch only or watch and download, optional password, days to live. The link shows once. */
function ShareBox({ libraryId, assetId }: { libraryId: string; assetId: string }) {
  const [scope, setScope] = useState<"view" | "download">("view");
  const [days, setDays] = useState("7");
  const [password, setPassword] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const make = () => {
    setFailed(null);
    createShare(libraryId, {
      target: { kind: "asset", id: assetId },
      scope,
      expiresInDays: Number(days) || 7,
      ...(password ? { password } : {}),
    })
      .then((s) => setLink(`${location.origin}${s.url}`))
      .catch((e) => setFailed(message(e)));
  };

  return (
    <section aria-label="Share link" className="flex flex-col gap-2 rounded-xl border border-zinc-500/20 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Share2 className="h-4 w-4 text-zinc-500" />
        <select
          aria-label="Link scope"
          value={scope}
          onChange={(e) => setScope(e.target.value as "view" | "download")}
          className="h-9 rounded-md border border-zinc-500/30 bg-transparent px-2"
        >
          <option value="view">Watch only</option>
          <option value="download">Watch and download</option>
        </select>
        <Input type="number" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} aria-label="Days to live" className="h-9 w-20" />
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (optional)" aria-label="Link password" className="h-9 w-44" />
        <Button size="sm" onClick={make}>
          Create link
        </Button>
      </div>
      {link && (
        <div className="flex items-center gap-2">
          <Input readOnly value={link} aria-label="Share link address" onFocus={(e) => e.currentTarget.select()} className="h-9 text-xs" />
          <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(link)}>
            Copy
          </Button>
        </div>
      )}
      {failed && <p className="text-xs text-red-400">{failed}</p>}
    </section>
  );
}

/**
 * The preview's player with what is said in it: the media opens at `startAt` (a #t= media fragment), a transcript line
 * seeks there. Below: the transcript's state (a key missing says so, with Retry) and Open in Caption Studio.
 */
function Player({
  libraryId,
  asset,
  startAt,
  inTrash,
  onError,
}: {
  libraryId: string;
  asset: AssetCard;
  startAt: number;
  inTrash: boolean;
  onError: (e: string) => void;
}) {
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [reread, setReread] = useState(0);
  const [opening, setOpening] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let live = true;
    getAsset(libraryId, asset.id)
      .then((d) => live && setDetail(d))
      .catch(() => live && setDetail(null));
    return () => void (live = false);
  }, [libraryId, asset.id, reread]);

  // a transcript still being made: look again in three seconds
  const job = detail?.jobs.find((j) => j.kind === "transcribe");
  const waiting = job?.state === "queued" || job?.state === "running";
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setReread((n) => n + 1), 3000);
    return () => clearTimeout(t);
  }, [waiting, detail]);

  const seek = (s: number) => {
    if (!media.current) return;
    media.current.currentTime = s;
    void media.current.play().catch(() => {});
  };
  const src = `/api/library/media/${asset.versionId}/play${startAt ? `#t=${startAt}` : ""}`;
  const retry = () =>
    rerunJobs(libraryId, asset.id, ["transcribe"])
      .then(() => setReread((n) => n + 1))
      .catch((e) => onError(message(e)));
  const captions = () => {
    setOpening(true);
    openInCaptions(libraryId, asset.id)
      .then(({ projectId }) => navigate(`/captions?project=${projectId}`))
      .catch((e) => onError(message(e)))
      .finally(() => setOpening(false));
  };

  return (
    <>
      {asset.kind === "video" ? (
        <video key={src} ref={media} src={src} controls playsInline preload="metadata" className="w-full rounded-lg bg-black" />
      ) : (
        <audio key={src} ref={media} src={src} controls preload="metadata" className="w-full" />
      )}
      {asset.kind === "video" && !inTrash && (
        <Button size="sm" variant="outline" className="w-fit" disabled={opening} onClick={captions}>
          {opening ? <Loader2 className="h-4 w-4 animate-spin" /> : <Captions className="h-4 w-4" />}
          Open in Caption Studio
        </Button>
      )}
      {detail?.transcript ? (
        <section aria-label="Transcript" className="flex max-h-80 flex-col gap-0.5 overflow-y-auto rounded-xl border border-zinc-500/20 p-2">
          {detail.transcript.segments.map((seg, i) => (
            <button key={i} type="button" onClick={() => seek(seg.start)} className="flex gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-zinc-500/10">
              <span className="shrink-0 font-mono text-xs leading-5 text-zinc-500">{clock(seg.start)}</span>
              <span>{seg.text}</span>
            </button>
          ))}
        </section>
      ) : (
        job && (
          <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            {waiting ? (job.state === "running" && job.error) || "Transcribing…" : job.state === "done" ? "Nothing is said in this clip." : job.error ?? "The transcript failed."}
            {(job.state === "needs_key" || job.state === "failed") && !inTrash && (
              <Button size="sm" variant="outline" onClick={retry}>
                Retry
              </Button>
            )}
          </p>
        )
      )}
      {detail?.jobs
        .filter((j) => (j.kind === "describe" || j.kind === "embed") && (j.state === "needs_key" || j.state === "failed"))
        .map((j) => (
          <p key={j.kind} className="text-xs text-zinc-500">
            {j.kind === "describe" ? "AI description" : "Search by meaning"}: {j.error ?? "failed"}
          </p>
        ))}
    </>
  );
}
