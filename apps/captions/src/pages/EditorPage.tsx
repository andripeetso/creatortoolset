import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Check, Folder, Loader2, Plus } from "lucide-react";
import type { EditSummary } from "@contracts/editor";
import { MAX_VERSIONS } from "@contracts/editor";
import type { AssetCard, Collection, LibrarySummary } from "@contracts/library";
import { AppBar } from "@/components/AppBar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { createEdit, footageTarget, listEdits, runEdit } from "@/lib/editor";
import { changeFolderItems, getAsset, listAssets, listCollections, listLibraries, uploadFile } from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";
import { cn } from "@/lib/utils";
import { confirmHeavy, openToolSetup } from "@/lib/setup";
import { ToolSetupLine } from "@/components/setup/ToolSetupLine";
import { EditorDefaultsButton } from "@/components/settings/EditorDefaultsDialog";
import { FootageFolderCard } from "@/components/FootageFolderCard";

/**
 * AI Editor (/editor): the edits I made (a workspace owner: the members' too), and New edit: footage picked from the
 * Media Library, what the video is, how many versions. Create runs it; the edit page (/editor/:id) follows the steps.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const thumb = (versionId: string) => `/api/library/media/${versionId}/thumb`;

const STATE_TONE: Record<string, string> = {
  queued: "bg-zinc-500/15 text-zinc-500",
  running: "bg-sky-500/15 text-sky-500",
  done: "bg-emerald-500/15 text-emerald-500",
  failed: "bg-red-500/15 text-red-500",
  needs_key: "bg-amber-500/15 text-amber-600",
};
export const STATE_LABEL: Record<string, string> = { queued: "Queued", running: "Running", done: "Done", failed: "Failed", needs_key: "Needs setup" };

export function StateBadge({ state }: { state: string }) {
  return <Badge className={cn("border-transparent", STATE_TONE[state])}>{STATE_LABEL[state] ?? state}</Badge>;
}

export default function EditorPage() {
  // the saved list paints at once; a step that moves (the server's worker, a device) reads it again: lib/local-cache
  const list = useCachedLoad<EditSummary[]>("/api/editor", listEdits);
  const edits = list.data;
  const error = edits ? null : list.error || null;
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar tool="AI Editor">
        <EditorDefaultsButton />
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          New edit
        </Button>
      </AppBar>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-3 px-4 py-4 sm:px-6">
        <ToolSetupLine tool="editor" />
        {edits === null && !error && <div aria-hidden="true" className="h-[184px] rounded-xl border border-zinc-500/20" />}
        {edits?.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="max-w-md text-sm text-zinc-500">
              Pick raw takes from your Media Library and say what the video is. The AI picks the best take of each line, cuts the restarts and
              pauses, and you get draft timelines for your own editor, with a preview in Review.
            </p>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              New edit
            </Button>
          </div>
        )}
        {edits && edits.length > 0 && (
          <ul className="flex flex-col divide-y divide-zinc-500/15 rounded-xl border border-zinc-500/20">
            {edits.map((e) => (
              <li key={e.id}>
                <Link to={`/editor/${e.id}`} className="flex items-center gap-3 px-3 py-2.5 hover:bg-zinc-500/10">
                  <div className="flex shrink-0 -space-x-3">
                    {e.sources.slice(0, 3).map((v) => (
                      <img key={v} src={thumb(v)} alt="" className="h-10 w-16 rounded-md border border-zinc-500/30 bg-zinc-800 object-cover" />
                    ))}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{e.name}</div>
                    <div className="truncate text-xs text-zinc-500">
                      {e.sources.length} {e.sources.length === 1 ? "clip" : "clips"} · {new Date(e.updatedAt).toLocaleString()}
                      {e.last && ` · ${e.last.kind}`}
                    </div>
                  </div>
                  {e.last && <StateBadge state={e.last.state} />}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
      </main>
      <NewEditSheet open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

/** The New edit sheet: footage from the library (search, a folder, several at once or the whole folder), then the brief. */
function NewEditSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [libId, setLibId] = useState("");
  const [folders, setFolders] = useState<Collection[]>([]);
  const [folder, setFolder] = useState("");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [items, setItems] = useState<AssetCard[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [picked, setPicked] = useState<Map<string, string>>(new Map()); // version id → title, in the order picked
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [script, setScript] = useState("");
  const [versions, setVersions] = useState(1);
  const [targetS, setTargetS] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    listLibraries().then((l) => {
      setLibraries(l);
      setLibId((id) => id || l[0]?.id || "");
    }, (e) => setError(message(e)));
  }, [open]);

  useEffect(() => {
    if (!libId) return;
    listCollections(libId).then(setFolders, () => setFolders([]));
  }, [libId]);

  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const query = { q: term || undefined, kind: ["video" as const], collectionId: folder || undefined };
  useEffect(() => {
    if (!libId || !open) return;
    let live = true;
    listAssets(libId, query).then(
      (p) => {
        if (!live) return;
        setItems(p.items);
        setNext(p.next);
      },
      (e) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libId, term, folder, open]);

  const ready = (a: AssetCard) => a.state === "ready";
  const toggle = (a: AssetCard) =>
    setPicked((m) => {
      const out = new Map(m);
      if (out.has(a.versionId)) out.delete(a.versionId);
      else out.set(a.versionId, a.title);
      return out;
    });

  /** Every ready video the search and folder show, all pages. */
  const pickAll = async () => {
    let all = items;
    let cursor = next;
    try {
      while (cursor) {
        const p = await listAssets(libId, { ...query, cursor });
        all = [...all, ...p.items];
        cursor = p.next;
      }
      setItems(all);
      setNext(undefined);
      setPicked((m) => {
        const out = new Map(m);
        for (const a of all.filter(ready)) out.set(a.versionId, a.title);
        return out;
      });
    } catch (e) {
      setError(message(e));
    }
  };

  /** Files from this computer: filed in the library (the A-roll folder, or a plug-in\'s), then picked for this edit. */
  const fromComputer = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      const target = await footageTarget();
      for (const file of Array.from(files)) {
        const up = await uploadFile(target.libraryId, file, () => {}, target.collectionId);
        const assetId = up.assetId ?? up.duplicateOf;
        if (!assetId) throw new Error(`${file.name} was not filed in the library`);
        await changeFolderItems(target.libraryId, target.collectionId, [assetId], true);
        const asset = await getAsset(target.libraryId, assetId);
        setPicked((m) => new Map(m).set(asset.versionId, asset.title));
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!(await confirmHeavy("editor"))) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await createEdit({
        sources: [...picked.keys()],
        name: name.trim() || undefined,
        brief,
        script,
        versions,
        targetS: Number(targetS) || 0,
      });
      await runEdit(id);
      navigate(`/editor/${id}`);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-scroll p-0 sm:max-w-2xl">
        <form
          className="flex flex-col gap-4 p-4 pt-12"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div>
            <SheetTitle className="text-base">New edit</SheetTitle>
            <SheetDescription className="text-xs text-zinc-500">
              Pick the takes from your Media Library. Their transcripts and the AI run on your own keys and your own AI.
            </SheetDescription>
          </div>

          <section aria-label="Footage" className="flex flex-col gap-2">
            {libId && items.length === 0 && !term && !folder && <FootageFolderCard libraryId={libId} />}
            <div className="flex flex-wrap items-center gap-2">
              {libraries.length > 1 && (
                <select
                  aria-label="Library"
                  value={libId}
                  onChange={(e) => {
                    setLibId(e.target.value);
                    setFolder("");
                  }}
                  className="h-9 rounded-md border border-zinc-500/30 bg-transparent px-2 text-sm"
                >
                  {libraries.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              )}
              <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the library" aria-label="Search footage" className="min-w-0 flex-1" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                multiple
                accept="video/*,audio/*"
                className="hidden"
                aria-label="Footage files from this computer"
                onChange={(e) => {
                  void fromComputer(e.target.files);
                  e.target.value = "";
                }}
              />
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
                <Plus className="h-3.5 w-3.5" />
                Add files from this computer
              </Button>
              <span className="text-xs text-zinc-500">Filed in your Media Library as A-roll</span>
            </div>
            {folders.length > 0 && (
              <div role="group" aria-label="Folders" className="flex flex-wrap gap-1.5">
                <Button type="button" size="sm" variant={folder ? "outline" : "default"} onClick={() => setFolder("")}>
                  All
                </Button>
                {folders.map((c) => (
                  <Button key={c.id} type="button" size="sm" variant={folder === c.id ? "default" : "outline"} onClick={() => setFolder(c.id)}>
                    <Folder className="h-3.5 w-3.5" />
                    {c.name}
                  </Button>
                ))}
              </div>
            )}
            {items.length > 0 ? (
              <ul className="grid max-h-80 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
                {items.map((a) => {
                  const on = picked.has(a.versionId);
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        disabled={!ready(a)}
                        aria-pressed={on}
                        onClick={() => toggle(a)}
                        className={cn(
                          "relative flex w-full flex-col overflow-hidden rounded-lg border text-left disabled:opacity-40",
                          on ? "border-violet-500 ring-2 ring-violet-500/40" : "border-zinc-500/20 hover:border-zinc-500/50",
                        )}
                      >
                        <img src={a.thumbUrl ?? thumb(a.versionId)} alt="" className="aspect-video w-full bg-zinc-800 object-cover" />
                        <span className="truncate px-2 py-1 text-xs">{a.title}</span>
                        {on && (
                          <span className="absolute right-1.5 top-1.5 rounded-full bg-violet-500 p-0.5 text-white">
                            <Check className="h-3 w-3" />
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="py-6 text-center text-sm text-zinc-500">
                {libId ? (
                  "No videos here."
                ) : (
                  <>
                    No Media Library yet.{" "}
                    <button type="button" className="underline underline-offset-2" onClick={() => openToolSetup("media")}>
                      Set up
                    </button>
                  </>
                )}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span>{picked.size} picked</span>
              {items.length > 0 && (
                <Button type="button" size="sm" variant="ghost" onClick={() => void pickAll()}>
                  {folder ? "Pick the whole folder" : "Pick all shown"}
                </Button>
              )}
              {picked.size > 0 && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setPicked(new Map())}>
                  Clear
                </Button>
              )}
              {next && (
                <Button type="button" size="sm" variant="ghost" onClick={() => void listAssets(libId, { ...query, cursor: next }).then((p) => (setItems((x) => [...x, ...p.items]), setNext(p.next)))}>
                  Load more
                </Button>
              )}
            </div>
          </section>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-name">Name</Label>
            <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Untitled edit" maxLength={120} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-brief">What is the video?</Label>
            <Textarea id="edit-brief" value={brief} onChange={(e) => setBrief(e.target.value)} rows={3} placeholder="A 45-second reel for new parents: the hook, three tips, the call to action." />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-script">Script (optional)</Label>
            <Textarea id="edit-script" value={script} onChange={(e) => setScript(e.target.value)} rows={3} placeholder="The text the takes were read from" />
          </div>
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-versions">Versions</Label>
              <select id="edit-versions" value={versions} onChange={(e) => setVersions(Number(e.target.value))} className="h-9 w-24 rounded-md border border-zinc-500/30 bg-transparent px-2 text-sm">
                {Array.from({ length: MAX_VERSIONS }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-target">Target length (s)</Label>
              <Input id="edit-target" type="number" min={0} max={3600} value={targetS} onChange={(e) => setTargetS(e.target.value)} placeholder="Any" className="w-28" />
            </div>
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <Button type="submit" disabled={busy || picked.size === 0} className="self-start">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Create and run
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
