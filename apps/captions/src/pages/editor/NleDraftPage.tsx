import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { Download, Eye, MoreHorizontal } from "lucide-react";
import type { Draft, Edit } from "@contracts/editor";
import type { AssetCard, LibrarySummary } from "@contracts/library";
import { AppBar } from "@/components/AppBar";
import { NleEditor, type NleControl, type NleDrop, type NleFile } from "@/components/nle/NleEditor";
import { Picture } from "@/components/Picture";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { canChange, useMe } from "@/lib/auth";
import { promptDialog } from "@/lib/dialogs";
import { duplicateVersion, exportUrl, getDraft, getEdit, markVersion, rendersVersion, saveTimeline } from "@/lib/editor";
import { listAssets, listLibraries } from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";
import { toNle } from "@/lib/nle/draft";
import type { NleTimeline } from "@/lib/nle/model";
import { usePageNote } from "@/lib/page-context";
import { undoable } from "@/lib/undo";
import { versionTitle } from "./ProjectView";

/**
 * One version on the timeline (/editor/:id/:draft), in the editor (components/nle): it plays the clips from the Media
 * Library as they are edited, and Save (⌘S) keeps the whole timeline as this version with no AI (PUT …/timeline): it
 * stays the same version, its new render is filed in Review as that video's next version. Clips come from the media
 * bin in the Media Pool. Edits that this server's renders don't take yet are greyed (GET /api/editor/renders).
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const BIN_MIME = "application/x-ct-bin-clip";

/** A library clip as the editor lays it: keyed by its version id; the server fills in its rate, length and size on Save. */
const dropOf = (a: AssetCard): NleDrop => ({
  path: a.title, name: a.title, seconds: a.durationS, w: a.width ?? 0, h: a.height ?? 0, sound: true,
  src: a.versionId, source: { versionId: a.versionId, name: a.title, tc: 0 },
});

export function NleDraftPage({ id, name }: { id: string; name: string }) {
  const editable = canChange(useMe(), "editor");
  const navigate = useNavigate();
  const edit = useCachedLoad<Edit>(`/api/editor/${id}`, () => getEdit(id));
  const e = edit.data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [renders, setRenders] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const control = useRef<NleControl | null>(null);

  useEffect(() => {
    let gone = false;
    setDraft(null);
    getDraft(id, name).then((d) => !gone && setDraft(d), (x) => !gone && setLoadError(message(x)));
    return () => void (gone = true);
  }, [id, name]);
  // a server that can't say renders version 1, as every server before the editor came here
  useEffect(() => void rendersVersion().then((r) => setRenders(r.edj_version), () => setRenders(1)), []);
  const initial = useMemo(() => (draft ? toNle(draft.timeline) : null), [draft]);
  const making = e?.jobs.find((j) => j.variant === name && (j.state === "queued" || j.state === "running"));

  // a library clip plays from the server (its proxy, or the original); a card made in the edit's own folder doesn't play here
  const urlOf = useCallback((src: string, tl: NleTimeline): NleFile | null => {
    const s = tl.sources[src];
    return !s || s.file ? null : { url: `/api/library/media/${encodeURIComponent(String(s.versionId ?? src))}/play` };
  }, []);
  const save = async (tl: NleTimeline) => {
    setSaving(true);
    setRefused(null);
    try {
      edit.set(await saveTimeline(id, name, tl));
      toast.success(e?.previews[name] ? "Saved: its render goes to Review as the next version" : "Saved: rendering it");
    } catch (x) {
      setRefused(message(x));
      throw x;
    } finally {
      setSaving(false);
    }
  };

  const title = e ? versionTitle(e, name) : name;
  // the chat knows which version is open here
  const said = `Editor timeline: ${e?.name ?? id}, ${title}`;
  useEffect(() => usePageNote.setState({ note: said }), [said]);
  useEffect(() => () => usePageNote.setState({ note: null }), []);
  const run = (f: () => Promise<unknown>) => void f().catch((x) => toast.error(message(x)));
  const duplicate = () => run(async () => {
    const made = await duplicateVersion(id, name);
    navigate(`/editor/${id}/${made.name}`);
    undoable("duplicated", () => markVersion(id, made.name, { trashed: true }));
  });
  const rename = () => run(async () => {
    const to = await promptDialog({ title: `Rename ${title}`, value: title, ok: "Rename" });
    if (to === null) return;
    const marks = await markVersion(id, name, { label: to.trim() === name ? "" : to.trim() });
    if (e) edit.set({ ...e, marks });
  });
  const remove = () => run(async () => {
    await markVersion(id, name, { trashed: true });
    navigate(`/editor/${id}`);
    undoable("version deleted", () => markVersion(id, name, { trashed: false }));
  });
  const filed = draft?.filed ?? null;

  return (
    <div className="flex h-dvh flex-col">
      <AppBar tool="Editor" to={`/editor/${id}`} trail={title}>
        <a href={exportUrl(id, name, "otio")} download className="hidden items-center gap-1 rounded-md px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-500/10 hover:text-foreground sm:inline-flex">
          <Download className="h-3.5 w-3.5" /> .otio
        </a>
        {filed && (
          <Button asChild size="sm" variant="outline">
            <Link to={`/review/${filed.assetId}?v=${filed.n}`}><Eye className="h-4 w-4" /> <span className="hidden md:inline">In Review</span></Link>
          </Button>
        )}
        {editable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" aria-label="More" className="px-2"><MoreHorizontal className="h-4 w-4" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={duplicate}>Duplicate</DropdownMenuItem>
              <DropdownMenuItem onSelect={rename}>Rename</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-red-500" onSelect={remove}>Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </AppBar>
      <div className="flex min-h-0 flex-1 flex-col">
        {initial && renders !== null ? (
          <NleEditor initial={initial} resetKey={`${id}/${name}`} urlOf={urlOf} onSave={save} renders={renders} control={control}
            readOnly={!editable}
            saving={saving ? { line: "Saving" } : null}
            bin={editable ? <MediaBin onUse={(d) => control.current?.put(d)} /> : undefined}
            readDrop={async (dt) => {
              const raw = dt.getData(BIN_MIME);
              return raw ? (JSON.parse(raw) as NleDrop) : null;
            }}
            status={refused ? <span className="min-w-0 truncate text-red-400" title={refused}>{refused}</span> : making ? <span className="text-zinc-500">Rendering this version</span> : null} />
        ) : (
          <p className="px-3 py-2 text-xs text-red-400">{loadError || edit.error}</p>
        )}
      </div>
    </div>
  );
}

/** The Media Library's clips, searched: drag one onto a track, or click a video to put it at the playhead on V1. */
function MediaBin({ onUse }: { onUse: (d: NleDrop) => void }) {
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<AssetCard[] | null>(null);
  const lib = libraries[0]?.id;
  useEffect(() => void listLibraries().then(setLibraries, () => setItems([])), []);
  useEffect(() => {
    if (!lib) return;
    let live = true;
    const t = setTimeout(() => {
      listAssets(lib, { q: q.trim() || undefined, kind: ["video", "audio"] }).then((p) => live && setItems(p.items), () => live && setItems([]));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [lib, q]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="p-2">
        <Input type="search" value={q} onChange={(x) => setQ(x.target.value)} placeholder="Search media" aria-label="Search media" className="h-7 text-xs" />
      </div>
      <ul className="grid flex-1 grid-cols-2 content-start gap-2 overflow-y-auto p-2">
        {items?.length === 0 && <li className="col-span-2 py-6 text-center text-xs text-zinc-500">No clips</li>}
        {items?.filter((a) => a.state === "ready").map((a) => (
          <li key={a.id}>
            <button type="button" draggable title={a.title}
              onDragStart={(x) => { x.dataTransfer.setData(BIN_MIME, JSON.stringify(dropOf(a))); x.dataTransfer.effectAllowed = "copy"; }}
              onClick={a.kind === "video" ? () => onUse(dropOf(a)) : undefined}
              className="flex w-full flex-col overflow-hidden rounded-md border border-zinc-500/20 text-left hover:border-zinc-500/50">
              <span className="relative block aspect-video w-full overflow-hidden bg-zinc-800">
                <Picture src={a.thumbUrl ?? `/api/library/media/${a.versionId}/thumb`} alt="" className="absolute inset-0 h-full w-full object-cover" />
              </span>
              <span className="truncate px-1.5 py-1 text-[11px]">{a.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
