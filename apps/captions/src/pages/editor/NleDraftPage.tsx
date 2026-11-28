import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { Download, Eye, MoreHorizontal } from "lucide-react";
import type { Draft, Edit, Renders } from "@contracts/editor";
import type { AssetCard, LibrarySummary } from "@contracts/library";
import { AppBar } from "@/components/AppBar";
import { NleEditor, type NleControl, type NleDrop, type NleFile } from "@/components/nle/NleEditor";
import { Picture } from "@/components/Picture";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { canChange, useMe } from "@/lib/auth";
import { promptDialog } from "@/lib/dialogs";
import { clipSource, duplicateVersion, ensureEditProxies, exportUrl, getDraft, getEdit, markVersion, saveTimeline } from "@/lib/editor";
import { listAssets, listLibraries, useLibraryChanges } from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";
import { toNle } from "@/lib/nle/draft";
import type { NleTimeline } from "@/lib/nle/model";
import { usePageNote } from "@/lib/page-context";
import { undoable } from "@/lib/undo";
import { describeChanges } from "@contracts/edit-summary";
import { ChatFoot, RoundBar } from "./DraftChatBars";
import { versionTitle } from "./ProjectView";
import { TakePicker } from "./TakePicker";

/**
 * One version on the timeline (/editor/:id/:draft), in the editor (components/nle): it plays the clips from the Media
 * Library as they are edited, and Save (⌘S) keeps the whole timeline as this version with no AI (PUT …/timeline): it
 * stays the same version, its new render is filed in Review as that video's next version. Clips come from the media
 * bin in the Media Pool. What this server's renders don't draw is greyed (the draft's `renders`). While nothing is
 * unsaved the Viewer can show the render itself (Rendered): a planned edit opens on it, so its texts and effects show.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const BIN_MIME = "application/x-ct-bin-clip";

/** A server from before the editor came here says nothing of its renders: version 1, none of the editor's own fields. */
const OLD_SERVER: Renders = { edj_version: 1, tracks: {} };
/** What the bin's drag carries: the clip's version id. */
type BinClip = { versionId: string };

/** A library clip as the editor lays it, keyed by its version id: its rate, length and size from the server, and a picture
 *  with no sound brings no voice clip. */
async function dropOf(edit: string, clip: string): Promise<NleDrop> {
  const { source, sound } = await clipSource(edit, clip);
  return { path: source.name, name: source.name, seconds: source.dur / source.fps, fps: source.fps, w: source.w, h: source.h, sound, src: clip, source: { ...source } };
}

export function NleDraftPage({ id, name }: { id: string; name: string }) {
  const editable = canChange(useMe(), "editor");
  const navigate = useNavigate();
  const edit = useCachedLoad<Edit>(`/api/editor/${id}`, () => getEdit(id));
  const e = edit.data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const control = useRef<NleControl | null>(null);
  // the Review version that is exactly the saved timeline
  const [filed, setFiled] = useState<Draft["filed"]>(null);
  // clips whose proxy job is queued/running; leaving this set bumps retryRev so NlePlayer reloads /play seamlessly
  const [pendingProxies, setPendingProxies] = useState<ReadonlySet<string>>(() => new Set());
  const [retryRev, setRetryRev] = useState<Record<string, number>>({});
  const pendingRef = useRef(pendingProxies);
  pendingRef.current = pendingProxies;
  const scopeRef = useRef(`${id}/${name}`);
  scopeRef.current = `${id}/${name}`;
  const seenSources = useRef<Set<string>>(new Set());

  const ensureProxies = useCallback((versions: string[], check = false) => {
    if (!editable || !versions.length) return;
    const scope = `${id}/${name}`;
    void ensureEditProxies(id, versions, check ? { check: true } : undefined).then(({ pending }) => {
      if (scopeRef.current !== scope) return;
      const asked = new Set(versions);
      const still = new Set(pending);
      const done = [...pendingRef.current].filter((v) => asked.has(v) && !still.has(v));
      setPendingProxies((prev) => {
        const next = new Set(prev);
        for (const v of asked) {
          if (still.has(v)) next.add(v);
          else next.delete(v);
        }
        return next.size === prev.size && [...next].every((v) => prev.has(v)) ? prev : next;
      });
      if (done.length) {
        setRetryRev((prev) => {
          const next = { ...prev };
          for (const v of done) next[v] = (next[v] ?? 0) + 1;
          return next;
        });
      }
    }, () => {});
  }, [id, name, editable]);

  useEffect(() => {
    let gone = false;
    setDraft(null);
    setPendingProxies(new Set());
    setRetryRev({});
    seenSources.current = new Set();
    getDraft(id, name).then((d) => {
      if (gone) return;
      setDraft(d);
      setFiled(d.filed ?? null);
    }, (x) => !gone && setLoadError(message(x)));
    return () => void (gone = true);
  }, [id, name]);

  useEffect(() => {
    if (!draft || !editable) return;
    const versions = [...new Set(Object.entries(draft.timeline.sources).flatMap(([k, s]) => (s.file ? [] : [String(s.versionId ?? k)])))];
    seenSources.current = new Set(versions);
    ensureProxies(versions);
  }, [draft, editable, ensureProxies]);

  useLibraryChanges(() => {
    if (pendingRef.current.size) ensureProxies([...pendingRef.current], true);
  });

  const initial = useMemo(() => (draft ? toNle(draft.timeline) : null), [draft]);
  const making = e?.jobs.find((j) => j.variant === name && (j.state === "queued" || j.state === "running"));
  // read again when a step of this version ends (its render filed)
  const doneKey = e ? e.jobs.filter((j) => j.variant === name && j.state === "done").length : 0;
  useEffect(() => {
    if (!doneKey) return;
    let gone = false;
    getDraft(id, name).then((d) => !gone && setFiled(d.filed ?? null), () => {});
    return () => void (gone = true);
  }, [id, name, doneKey]);

  // a library clip plays from the server (its proxy, or the original); a card made in the edit's own folder doesn't play here
  const urlOf = useCallback((src: string, tl: NleTimeline): NleFile | null => {
    const s = tl.sources[src];
    if (!s || s.file) return null;
    const ver = String(s.versionId ?? src);
    const rev = retryRev[ver];
    const url = `/api/library/media/${encodeURIComponent(ver)}/play${rev ? `?r=${rev}` : ""}`;
    return pendingProxies.has(ver) ? { url, preparing: true } : { url };
  }, [pendingProxies, retryRev]);
  const save = async (tl: NleTimeline) => {
    setSaving(true);
    setRefused(null);
    try {
      edit.set(await saveTimeline(id, name, tl));
      setFiled(null); // its render is of the timeline before
      toast.success(e?.previews[name] ? "Saved: its render goes to Review as the next version" : "Saved: rendering it");
    } catch (x) {
      setRefused(message(x));
      throw x;
    } finally {
      setSaving(false);
    }
  };

  const title = e ? versionTitle(e, name) : name;
  // the chat knows which version is open here and what the person changed by hand and has not saved yet
  const [unsaved, setUnsaved] = useState("");
  const said = `Editor timeline: ${e?.name ?? id} (edit id ${id}), ${title}. ${unsaved ? `Unsaved edits by hand: ${unsaved}` : "No unsaved edits"}`;
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
        {initial && draft ? (
          <NleEditor initial={initial} resetKey={`${id}/${name}`} urlOf={urlOf} onSave={save} control={control}
            bar={e ? <RoundBar e={e} name={name} /> : <span className="truncate text-[13px] font-medium text-zinc-200">{title}</span>}
            side={e?.lines.length ? (s) => <TakePicker key={name} s={s} e={e} name={name} title={title} /> : undefined}
            foot={e && editable ? (f) => <ChatFoot f={f} e={e} name={name} unsaved={unsaved} filed={filed} busy={saving || !!making} /> : undefined}
            onChange={(now, was) => {
              setUnsaved(now === was ? "" : describeChanges(was, now));
              if (now === was) return;
              const added = [...new Set(Object.entries(now.sources).flatMap(([k, s]) => {
                if (s.file) return [];
                const v = String(s.versionId ?? k);
                return seenSources.current.has(v) ? [] : [v];
              }))];
              if (added.length) {
                for (const v of added) seenSources.current.add(v);
                ensureProxies(added);
              }
            }}
            renders={draft.renders ?? OLD_SERVER}
            rendered={filed ? { url: `/api/review/assets/${filed.assetId}/v/${filed.n}/play`, first: !!draft.timeline.plan || pendingProxies.size > 0 } : null}
            readOnly={!editable}
            saving={saving ? { line: "Saving" } : null}
            bin={editable ? <MediaBin onUse={(clip) => void dropOf(id, clip).then((d) => control.current?.put(d), (x) => toast.error(message(x)))} /> : undefined}
            readDrop={async (dt) => {
              const raw = dt.getData(BIN_MIME);
              return raw ? dropOf(id, (JSON.parse(raw) as BinClip).versionId) : null;
            }}
            status={
              refused ? <span className="min-w-0 truncate text-red-400" title={refused}>{refused}</span>
              : making ? <span className="text-zinc-500">Rendering this version</span>
              : pendingProxies.size ? <span className="text-zinc-400">{pendingProxies.size === 1 ? "Making proxy…" : `Making ${pendingProxies.size} proxies…`}</span>
              : null
            } />
        ) : (
          <p className="px-3 py-2 text-xs text-red-400">{loadError || edit.error}</p>
        )}
      </div>
    </div>
  );
}

/** The Media Library's clips, searched: drag one onto a track, or click a video to put it at the playhead on V1. */
function MediaBin({ onUse }: { onUse: (clip: string) => void }) {
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
              onDragStart={(x) => { x.dataTransfer.setData(BIN_MIME, JSON.stringify({ versionId: a.versionId } satisfies BinClip)); x.dataTransfer.effectAllowed = "copy"; }}
              onClick={a.kind === "video" ? () => onUse(a.versionId) : undefined}
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
