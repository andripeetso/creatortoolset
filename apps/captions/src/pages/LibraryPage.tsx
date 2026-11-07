import { useEffect, useRef, useState } from "react";
import { AudioLines, Share2, FileText, Folder, Image as ImageIcon, Loader2, RotateCcw, Trash2, Upload, Video } from "lucide-react";
import type { AssetCard, AssetKind, Collection, LibrarySummary } from "@contracts/library";
import { AppBar } from "@/components/AppBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  createCollection,
  createLibrary,
  createShare,
  listAssets,
  listCollections,
  listLibraries,
  changeFolderItems,
  setTrashed,
  uploadFile,
} from "@/lib/library";
import { cn } from "@/lib/utils";
import { LibraryWatchFolders } from "./LibraryWatchFolders";

/**
 * Media Library (/library): one library's footage as a grid of 16:9 cards. Search runs over titles and tags
 * (FTS5, api/library/query.ts); a card opens its preview. Uploads go in one at a time, from the tray. Cards that are
 * still being prepared poll every two seconds until they are ready.
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

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function LibraryPage() {
  const [libraries, setLibraries] = useState<LibrarySummary[] | null>(null);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [kind, setKind] = useState<AssetKind | "all">("all");
  const [items, setItems] = useState<AssetCard[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [preview, setPreview] = useState<AssetCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [scope, setScope] = useState("all"); // "all", "trash", or a collection id
  const [collections, setCollections] = useState<Collection[]>([]);
  const [folders, setFolders] = useState(0); // counts folder changes, so the list is read again
  const [folderName, setFolderName] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const keys = useRef(0);

  const library = libraries?.find((l) => l.id === libraryId) ?? libraries?.[0] ?? null;
  const libId = library?.id;

  useEffect(() => {
    listLibraries()
      .then(setLibraries)
      .catch((e) => setError(message(e)));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  // the first page for the current library, search and kind; `refresh` counts re-reads (uploads, cards in progress)
  const folder = scope === "all" ? {} : scope === "trash" ? { trashed: true } : { collectionId: scope };

  useEffect(() => {
    if (!libId) return;
    const mine = ++seq.current;
    listAssets(libId, { q: term || undefined, kind: kind === "all" ? undefined : [kind], ...folder })
      .then((page) => {
        if (mine !== seq.current) return;
        setItems(page.items);
        setNext(page.next);
        setError(null);
      })
      .catch((e) => {
        if (mine === seq.current) setError(message(e));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libId, term, kind, scope, refresh]);

  useEffect(() => {
    if (!libId) return;
    listCollections(libId)
      .then(setCollections)
      .catch((e) => setError(message(e)));
  }, [libId, folders]);

  const loadMore = () => {
    if (!libId || !next) return;
    const mine = ++seq.current;
    listAssets(libId, { q: term || undefined, kind: kind === "all" ? undefined : [kind], ...folder, cursor: next })
      .then((page) => {
        if (mine !== seq.current) return;
        setItems((prev) => [...prev, ...page.items]);
        setNext(page.next);
      })
      .catch((e) => {
        if (mine === seq.current) setError(message(e));
      });
  };

  // cards still being prepared: look again in two seconds
  const preparing = items.some((a) => a.state === "processing");
  useEffect(() => {
    if (!preparing) return;
    const t = setTimeout(() => setRefresh((n) => n + 1), 2000);
    return () => clearTimeout(t);
  }, [preparing, items]);

  const patch = (key: number, change: Partial<Upload>) =>
    setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, ...change } : u)));

  const send = async (u: Upload) => {
    if (!libId) return;
    patch(u.key, { status: "uploading", sent: 0, error: undefined });
    try {
      const r = await uploadFile(libId, u.file, (sent) => patch(u.key, { sent }), u.folderId);
      patch(u.key, r.duplicateOf ? { status: "duplicate", sent: u.file.size } : { status: "added", sent: u.file.size });
      setRefresh((n) => n + 1);
      if (u.folderId) setFolders((n) => n + 1); // the folder's count
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
      setFolders((n) => n + 1);
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
      setFolders((n) => n + 1);
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
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(message(e));
    }
  };

  const addToFolder = async (a: AssetCard, folderId: string) => {
    if (!libId || !folderId) return;
    try {
      await changeFolderItems(libId, folderId, [a.id], true);
      setFolders((n) => n + 1);
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
        {libraries === null && !error && (
          <div className="flex justify-center py-16 text-zinc-500">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}

        {libraries?.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-sm text-zinc-500">No library yet. The workspace owner creates one.</p>
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
                placeholder="Search titles and tags"
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
            </div>

            <div role="group" aria-label="Folders" className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant={scope === "all" ? "default" : "outline"} aria-pressed={scope === "all"} onClick={() => setScope("all")}>
                All
              </Button>
              {collections.map((c) => (
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

            {library.canManage && <LibraryWatchFolders libraryId={library.id} folders={collections.filter((c) => c.kind === "manual")} />}

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

            {items.length > 0 ? (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {items.map((a) => (
                  <li key={a.id}>
                    <AssetTile asset={a} onOpen={() => setPreview(a)} />
                  </li>
                ))}
              </ul>
            ) : (
              libraries !== null && (
                <p className="py-16 text-center text-sm text-zinc-500">
                  {term || kind !== "all" ? "No matches." : "Nothing here yet. Upload a file to start."}
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

        {error && <p className="text-sm text-red-400">{error}</p>}
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
                {scope === "trash" ? (
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
              {libId && scope !== "trash" && <ShareBox libraryId={libId} assetId={preview.id} />}
              {preview.kind === "video" && (
                <video
                  key={preview.versionId}
                  src={`/api/library/media/${preview.versionId}/play`}
                  controls
                  playsInline
                  preload="metadata"
                  className="w-full rounded-lg bg-black"
                />
              )}
              {preview.kind === "audio" && (
                <audio key={preview.versionId} src={`/api/library/media/${preview.versionId}/play`} controls preload="metadata" className="w-full" />
              )}
              {preview.kind === "image" && (
                <img src={`/api/library/media/${preview.versionId}/play`} alt={preview.title} className="w-full rounded-lg" />
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
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
    </button>
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
