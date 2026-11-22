import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { CircleAlert, Copy, Download, Eye, Loader2, MessageSquareText, MonitorPlay, Pencil, Play, RotateCcw, Square, ThumbsUp, Trash2, Upload } from "lucide-react";
import { DEFAULT_EYELINE, type Draft, type Edit, type EditJob, type EditVoice, type Sentence } from "@contracts/editor";
import { STYLE_NAME_MAX, type EditingStylesView } from "@contracts/editor-styles";
import { TIMELINE_ACCEPT } from "@contracts/timeline-import";
import { AppBar } from "@/components/AppBar";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { LanguageSelect } from "@/components/LanguageSelect";
import { aboutTime, gbOf } from "@/components/LibraryProcessing";
import { Picture } from "@/components/Picture";
import { ExportGapsNote, gapsLine } from "@/components/ExportGapsNote";
import { APPROVAL, type Approval, type ReviewView } from "@/lib/review";
import { ENGINES, getAvailability, type EnhanceAvailability } from "@/lib/enhance";
import { canChange, useMe } from "@/lib/auth";
import { promptDialog } from "@/lib/dialogs";
import {
  cardStillUrl, carryOn, createStyle, deleteEdit, duplicateVersion, exportUrl, getEdit, getSentences, goJob, likeCard, sheetUrl, makeCardsAgain, markVersion, reviseDraft, sendBack,
  listStyles, patchEdit, putLines, restoreEdit, retryJob, reviewDraft, runEdit, setEyeline, stopEdit, swapTake, takeSpan,
} from "@/lib/editor";
import { useCachedLoad } from "@/lib/local-cache";
import { confirmHeavy } from "@/lib/setup";
import { useWorkPrefs } from "@/lib/setup";
import { editorsOnMac, openInEditor, takeBackFromEditor, type MacEditor } from "@/lib/thisMac";
import { undoable } from "@/lib/undo";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { Maker, StateBadge, thumb, useProjectEdits } from "../EditorPage";

/**
 * A project (/editor/p/:folder: every edit in that folder of the list, the versions of one video) and a lone edit
 * (/editor/:id), the same page: every version as a card (its preview, name, length, where it is in Review, and Open in
 * Review, Open timeline, Open in the person's editor, Download), newest first; right-click Duplicate, Rename, Delete
 * (Undo). Under them the tabs Script, Media, Brief and Activity of one edit. For looking and reviewing: what runs shows
 * quietly on the card it will change, and there is no feedback box here (the chat and Review take what to change).
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const editUrl = (id: string) => `/api/editor/${id}`;
/** One edit, its saved copy first; every part of the page that shows it reads the same copy and stays current with it. */
const useEdit = (id: string) => useCachedLoad<Edit>(editUrl(id), () => getEdit(id));
const busyJob = (j: EditJob) => j.state === "queued" || j.state === "running";
const STEP_NAME: Record<string, string> = { revise: "Revise from comments", analyze: "Analyze", script: "Script", draft: "Draft", preview: "Preview", critique: "Check the cut", file: "File in Review", broll: "B-roll", cards: "Cards", "cards-draw": "Draw cards", post: "Post-processing", sound: "Sound" };
/** The setting a needs-key message names: a key in API keys, else (a provider, a Mac that is off) AI providers. */
const settingFor = (why: string) => (/Settings → API keys/.test(why) && !/Settings → Providers/.test(why) ? "/settings/keys" : "/settings/providers");

/**
 * The line beside a step: why it waits, or what it does now, led by the computer working on it with the download's bytes
 * and time left ("Mac Studio: downloading proxies, 340 MB of 1.2 GB, about 3 min left").
 */
export function stepLine(j: EditJob): string | undefined {
  const p = j.state === "running" ? j.progress : undefined;
  if (!p) return j.line;
  const bytes = p.total ? `${p.done ? gbOf(p.done) : "0 MB"} of ${gbOf(p.total)}` : "";
  const left = p.leftS != null ? `${aboutTime(p.leftS)} left` : "";
  const what = [j.line, bytes, left].filter(Boolean).join(", ");
  return what ? `${p.device}: ${what}` : p.device;
}

/** /editor/p/<folder>: the edits in that folder of the list, newest change first. */
export function ProjectPage({ folder }: { folder: string }) {
  const project = useProjectEdits(folder);
  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar tool="Editor" to={`/editor?f=${folder}`} trail={project?.name || "Project"} />
      <EditsMain ids={project?.ids ?? []} several empty={!!project && !project.ids.length} />
    </div>
  );
}

/** /editor/<id>: one edit, the same page. */
export function EditProjectPage({ id }: { id: string }) {
  const editable = canChange(useMe(), "editor");
  const navigate = useNavigate();
  const edit = useEdit(id);
  const p = edit.data;
  const remove = async () => {
    try {
      await deleteEdit(id);
      navigate("/editor");
      undoable("edit deleted", () => restoreEdit(id));
    } catch (e) {
      toast.error(message(e));
    }
  };
  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar tool="Editor" to="/editor" trail={p?.name}>
        {editable && p && !p.locked && (
          <Button size="sm" variant="ghost" aria-label="Delete edit" title="Delete edit" onClick={() => void remove()}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </AppBar>
      {!p && edit.error ? <p className="px-4 py-4 text-sm text-red-400">{edit.error}</p> : <EditsMain ids={[id]} />}
    </div>
  );
}

function EditsMain({ ids, several = false, empty }: { ids: string[]; several?: boolean; empty?: boolean }) {
  const [params, setParams] = useSearchParams();
  const asked = params.get("edit");
  const shown = asked && ids.includes(asked) ? asked : ids[0];
  const named = several && ids.length > 1;
  return (
    <main className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-[minmax(0,1fr)] content-start gap-8 px-4 py-5 sm:px-6">
      {empty && <div className="rounded-xl border border-dashed border-zinc-500/30 p-10 text-center text-sm text-zinc-500">No edits</div>}
      {ids.map((id) => <EditVersions key={id} id={id} named={named} />)}
      {shown && (
        <EditTabs key={shown} id={shown} edits={named ? ids : undefined}
          pick={(id) => setParams((cur) => { const n = new URLSearchParams(cur); n.set("edit", id); return n; }, { replace: true })} />
      )}
    </main>
  );
}

/** The version names shown as cards, newest first (a higher number was made later); a deleted one is hidden. */
const versionsOf = (e: Edit) => e.drafts.filter((n) => !e.marks?.[n]?.trashedAt).reverse();
/** What a version is called: the name the person gave it, else what the AI called it, else its own name. */
export const versionTitle = (e: Edit, n: string) => e.marks?.[n]?.label || e.plans.find((p) => p.name === n)?.title || n;

/** Each draft's file (its timeline, notes and checks), read once per change of the edit. */
function useDrafts(e: Edit | null | undefined) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const key = e ? `${e.drafts.join(",")}|${e.updatedAt}|${e.jobs.filter((j) => j.state === "done").length}` : "";
  useEffect(() => {
    if (!e) return;
    let live = true;
    for (const n of e.drafts)
      fetch(`/api/editor/${e.id}/drafts/${n}`)
        .then((r) => (r.ok ? (r.json() as Promise<Draft>) : null))
        .then((d) => live && d && setDrafts((all) => ({ ...all, [n]: d })), () => {});
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return drafts;
}

/** Where each previewed version's Review video stands (its approval), read once per filed version. */
function useReviewStates(e: Edit | null | undefined) {
  const [states, setStates] = useState<Record<string, Approval>>({});
  const key = e ? Object.entries(e.previews).map(([n, p]) => `${n}:${p.assetId}.${p.n}`).join(",") : "";
  useEffect(() => {
    if (!e) return;
    let live = true;
    for (const [n, p] of Object.entries(e.previews))
      fetch(`/api/review/assets/${p.assetId}`)
        .then((r) => (r.ok ? (r.json() as Promise<ReviewView>) : null))
        .then((v) => live && v && setStates((all) => ({ ...all, [n]: v.asset.approval.status })), () => {});
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return states;
}

/** The person's editor (Settings → General's "editor they use") among the ones this Mac has, else the first it has. */
function useEditorHere(): MacEditor | null {
  const [editors, setEditors] = useState<MacEditor[]>([]);
  const prefs = useWorkPrefs((s) => s.prefs);
  useEffect(() => {
    void editorsOnMac().then(setEditors);
    void useWorkPrefs.getState().load();
  }, []);
  const want = prefs?.editor?.split("-")[0];
  return (want && editors.find((x) => `${x.id} ${x.name}`.toLowerCase().includes(want))) || editors[0] || null;
}

function EditVersions({ id, named }: { id: string; named: boolean }) {
  const editable = canChange(useMe(), "editor");
  const edit = useEdit(id);
  const e = edit.data;
  const drafts = useDrafts(e);
  const states = useReviewStates(e);
  const editor = useEditorHere();
  const [error, setError] = useState<string | null>(null);
  if (!e) return <section aria-hidden="true" className="h-[420px] min-w-0 rounded-xl border border-zinc-500/15" />;
  const act = (p: Promise<Edit>) => p.then((x) => { edit.set(x); setError(null); }, (x) => setError(message(x)));
  const versions = versionsOf(e);
  // what runs on the edit as a whole (analyze, a script): one quiet line above the cards; the rest shows on its card
  const loose = e.jobs.filter((j) => busyJob(j) && (!j.variant || !versions.includes(j.variant)));
  return (
    <section aria-label={e.name} className="grid min-w-0 gap-3">
      {named && (
        <h2 className="flex items-baseline gap-2 text-sm font-medium">
          <Link to={`/editor/${e.id}`} className="truncate hover:underline">{e.name}</Link>
          <span className="text-xs font-normal text-zinc-500">{new Date(e.updatedAt).toLocaleDateString()}</span>
          {e.maker && <Maker maker={e.maker} className="text-xs font-normal text-zinc-500" />}
        </h2>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {loose.map((j) => (
        <p key={j.id} className="flex min-w-0 items-center gap-2 text-xs text-zinc-500">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          <span className="min-w-0 truncate">{STEP_NAME[j.kind] ?? j.kind}{stepLine(j) ? ` · ${stepLine(j)}` : j.state === "queued" ? " · queued" : ""}</span>
          {editable && <button type="button" onClick={() => void act(stopEdit(id))} className="shrink-0 rounded px-1.5 hover:bg-zinc-500/15">Stop</button>}
        </p>
      ))}
      {e.passes?.waiting && e.passes.next && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-500/20 px-3 py-2 text-sm">
          <span className="mr-auto">Next pass: {e.passes.next === "broll" ? "B-roll" : "cards"}</span>
          {editable && <Button size="sm" onClick={() => void act(carryOn(id))}>Carry on</Button>}
        </div>
      )}
      {e.jobs.filter((j) => j.sheet).map((j) => <LookSheet key={j.id} e={e} job={j} editable={editable} act={act} />)}
      {versions.length === 0 ? (
        !loose.length && !named && <div className="rounded-xl border border-dashed border-zinc-500/30 p-8 text-center text-sm text-zinc-500">No versions</div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {versions.map((n) => (
            <VersionCard key={n} e={e} n={n} d={drafts[n]} state={states[n]} editor={editor} editable={editable}
              onEdit={(x) => edit.set(x)} refresh={() => void edit.refresh().catch(() => {})} onError={setError} />
          ))}
        </div>
      )}
      {!!e.costUsd && <p className="text-xs text-zinc-500">AI so far: ${e.costUsd.toFixed(2)} at the API's prices</p>}
    </section>
  );
}

/** A version's drawn cards on one sheet, waiting for the person's go, or a note that makes them again (api/editor/cards/step.ts). */
function LookSheet({ e, job, editable, act }: { e: Edit; job: EditJob; editable: boolean; act: (p: Promise<Edit>) => Promise<void> }) {
  const [note, setNote] = useState("");
  const title = versionTitle(e, job.variant);
  return (
    <div className="grid gap-2 rounded-lg border border-zinc-500/20 px-3 py-2 text-sm">
      <span>Look sheet · {title}</span>
      <img src={sheetUrl(e.id, job.id, job.sheet!.at)} alt={`The cards of ${title}`} className="max-h-80 w-full rounded bg-black object-contain" />
      {editable && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(x) => { x.preventDefault(); void act(goJob(e.id, job.id, note.trim() || undefined)); setNote(""); }}>
          <input value={note} onChange={(x) => setNote(x.currentTarget.value)} aria-label="Note on the cards" placeholder="Or a note: the cards are made again"
            className="h-8 min-w-0 flex-1 rounded-md border border-zinc-500/30 bg-transparent px-2 text-sm" />
          <Button size="sm" type="submit">{note.trim() ? "Make again" : "Go"}</Button>
        </form>
      )}
    </div>
  );
}

const cardButton = "inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md border border-zinc-500/25 px-2 text-xs hover:bg-zinc-500/10 disabled:opacity-50 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0";
const EXPORT_LABEL = { otio: "Timeline (.otio)", fcpxml: "Final Cut (.fcpxml)", edl: "Any editor (.edl)", zip: "All of them (.zip)" } as const;

/** One version: its preview playing, its name and length, where it stands in Review, the ways into it. */
function VersionCard({ e, n, d, state, editor, editable, onEdit, refresh, onError }: {
  e: Edit;
  n: string;
  d?: Draft;
  state?: Approval;
  editor: MacEditor | null;
  editable: boolean;
  onEdit: (e: Edit) => void;
  refresh: () => void;
  onError: (e: string | null) => void;
}) {
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [opening, setOpening] = useState(false);
  const pv = e.previews[n];
  const title = versionTitle(e, n);
  const job = e.jobs.find((j) => busyJob(j) && j.variant === n);
  // the last step of this version failed: said on the card, with its reason
  const last = [...e.jobs].reverse().find((j) => j.variant === n);
  const failed = !job && last && (last.state === "failed" || last.state === "needs_key") && last.error !== "Stopped" ? last : undefined;
  // its newest post step not done: the server refuses the export (api/editor/store.ts postUnfinished)
  const post = e.jobs.filter((j) => j.kind === "post" && j.variant === n).at(-1);
  const postHeld = !!post && post.state !== "done";
  const seconds = d ? Math.max(0, ...d.timeline.tracks.V1.items.map((i) => i.rec + i.len)) / d.timeline.fps : null;
  const cards = e.cards?.[n];
  const marks = (m: Edit["marks"]) => onEdit({ ...e, marks: m });
  const run = (f: () => Promise<unknown>) => { onError(null); return f().catch((x) => { onError(message(x)); refresh(); }); };

  const sentBack = useRef<HTMLInputElement>(null);
  const sendFileBack = (f: File | undefined) => f && run(async () => onEdit(await sendBack(e.id, n, f.name, await f.text())));

  const duplicate = () => run(async () => {
    const made = await duplicateVersion(e.id, n);
    refresh();
    undoable("duplicated", () => markVersion(e.id, made.name, { trashed: true }).then(refresh));
  });
  const remove = () => run(async () => {
    marks({ ...e.marks, [n]: { ...e.marks?.[n], trashedAt: Date.now() } });
    marks(await markVersion(e.id, n, { trashed: true }));
    undoable("version deleted", () => markVersion(e.id, n, { trashed: false }).then(marks));
  });
  const rename = (text: string) => {
    setRenaming(false);
    const label = text.trim() === n ? "" : text.trim();
    if (label === (e.marks?.[n]?.label ?? "") || (!e.marks?.[n]?.label && label === title)) return;
    void run(async () => marks(await markVersion(e.id, n, { label })));
  };
  const openIn = () => {
    if (!editor || !d) return;
    setOpening(true);
    const tl = d.timeline;
    void openInEditor({ edit: e.id, draft: n, editor: editor.id, name: `${e.name} ${title}`, project: e.name, fps: tl.fps, width: tl.width, height: tl.height })
      .then((r) => (r.problem ? toast.error(r.problem) : r.note && toast(r.note)))
      .finally(() => setOpening(false));
  };

  // the timeline Open in Resolve made, as the person left it there, is the next version (the same name and project)
  const takeBack = () => editor && run(async () => {
    const r = await takeBackFromEditor({ edit: e.id, draft: n, editor: editor.id, name: `${e.name} ${title}`, project: e.name });
    if (!r.text) throw new Error(r.problem ?? "Could not read the timeline from Resolve");
    onEdit(await sendBack(e.id, n, r.file ?? "Resolve.otio", r.text));
  });

  const card = (
    <article aria-label={title} className="grid min-w-0 content-start gap-2">
      <div className="relative">
        {pv ? (
          <video src={`/api/review/assets/${pv.assetId}/v/${pv.n}/play#t=1`} controls playsInline preload="metadata"
            className="aspect-[9/16] w-full rounded-lg bg-black object-contain" />
        ) : (
          <div className="flex aspect-[9/16] items-center justify-center rounded-lg border border-zinc-500/20 bg-zinc-500/5 px-3 text-center text-xs text-zinc-500">
            {job ? "" : "No preview"}
          </div>
        )}
        {/* what runs on it, quietly on the picture it will change (the card's lines and buttons never move for it) */}
        {job && (
          <div className="absolute inset-x-2 top-2 flex min-w-0 items-center gap-1.5 rounded-md bg-black/70 px-2 py-1 text-[11px] text-white/90 backdrop-blur-sm">
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
            <span className="min-w-0 flex-1 truncate">{STEP_NAME[job.kind] ?? job.kind}{stepLine(job) ? ` · ${stepLine(job)}` : job.state === "queued" ? " · queued" : ""}</span>
          </div>
        )}
      </div>
      <div className="flex min-w-0 items-baseline gap-2">
        {renaming ? (
          <input autoFocus defaultValue={title} aria-label="Version name" onBlur={(x) => rename(x.currentTarget.value)}
            onKeyDown={(x) => { if (x.key === "Enter") x.currentTarget.blur(); if (x.key === "Escape") setRenaming(false); }}
            onFocus={(x) => x.currentTarget.select()}
            className="h-6 min-w-0 flex-1 rounded border border-zinc-500/40 bg-transparent px-1.5 text-sm font-semibold" />
        ) : (
          <h3 className="truncate text-sm font-semibold" title={title === n ? n : `${title} (${n})`}>{title}</h3>
        )}
        {title !== n && !renaming && <span className="shrink-0 text-xs text-zinc-500">{n}</span>}
        {seconds !== null && <span className="shrink-0 text-xs text-zinc-500">{seconds.toFixed(0)} s</span>}
        {d && d.qa.notes.length > 0 && (
          <span className="ml-auto shrink-0" title={d.qa.notes.join("\n")}><CircleAlert className="h-3.5 w-3.5 text-amber-500" /></span>
        )}
      </div>
      {/* one line, always there: a state appearing never moves the buttons under the pointer */}
      <div className="flex h-5 min-w-0 items-center gap-1.5 text-[11px]">
        {failed ? (
          <span className="truncate text-red-500" title={failed.error ?? ""}>
            {STEP_NAME[failed.kind] ?? failed.kind}: {failed.error ?? "Failed"}
            {failed.state === "needs_key" && failed.error && /Settings →/.test(failed.error) && <Link to={settingFor(failed.error)} className="ml-1 underline">Open Settings</Link>}
          </span>
        ) : postHeld && !job ? (
          <span className="truncate text-amber-600">Post-processing did not finish</span>
        ) : pv ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-zinc-500">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", APPROVAL[state ?? "none"].dot)} />
            {state && state !== "none" ? APPROVAL[state].label : "In Review"}
          </span>
        ) : (
          <span className="text-zinc-500">Not in Review</span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {pv ? (
          <Link to={`/review/${pv.assetId}?v=${pv.n}`} className={cardButton}><Eye /> <span className="truncate">Open in Review</span></Link>
        ) : (
          <button type="button" disabled={!editable || !d || !!job} onClick={() => void run(async () => onEdit(await reviewDraft(e.id, n)))} className={cardButton}>
            <Eye /> <span className="truncate">Make the preview</span>
          </button>
        )}
        <Link to={`/editor/${e.id}/${n}`} className={cardButton}><Play /> <span className="truncate">Open timeline</span></Link>
        {pv && (
          <button type="button" disabled={!editable || !d || !!job} onClick={() => void run(async () => onEdit(await reviseDraft(e.id, n)))} className={cardButton}
            title="Make the next version from the open comments in Review: only what each asks for changes, each gets a reply, and the ones it changed are resolved">
            <MessageSquareText /> <span className="truncate">Revise from comments</span>
          </button>
        )}
        {editor && (
          <button type="button" disabled={postHeld || !d || opening} onClick={openIn} className={cardButton}>
            {opening ? <Loader2 className="animate-spin" /> : <MonitorPlay />} <span className="truncate">Open in {editor.name.replace(/^DaVinci /, "")}</span>
          </button>
        )}
        {editor?.id === "resolve-studio" && (
          <button type="button" disabled={!editable || !d || !!job} onClick={() => void takeBack()} className={cardButton}
            title="The timeline Open in Resolve made, as you left it in Resolve: its cuts become the next version">
            <Upload /> <span className="truncate">Take back from Resolve</span>
          </button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={cardButton}><Download /> <span className="truncate">Download</span></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {pv && <DropdownMenuItem asChild><a href={`/api/review/assets/${pv.assetId}/v/${pv.n}/download`} download>Video (.mp4)</a></DropdownMenuItem>}
            {(["otio", "fcpxml", "edl", "zip"] as const).map((f) => (
              <DropdownMenuItem key={f} disabled={postHeld} asChild={!postHeld}>
                {postHeld ? <span>{EXPORT_LABEL[f]}</span> : (
                  <a href={exportUrl(e.id, n, f)} download title={(f === "otio" ? gapsLine(d?.exportGaps, "resolve") : f === "fcpxml" ? gapsLine(d?.exportGaps, "final-cut") : f === "edl" ? "Cuts and timecodes for any editor, with the speaker's voice: no framing, effects or music" : null) ?? undefined}>{EXPORT_LABEL[f]}</a>
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem disabled={!editable || !d || !!job} onSelect={() => sentBack.current?.click()}
              title="A timeline you changed in Resolve, Premiere or Final Cut, exported as OTIO, FCPXML, XML or EDL: its cuts become the next version">
              <Upload className="h-3.5 w-3.5" /> Import a changed timeline…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <input ref={sentBack} type="file" accept={TIMELINE_ACCEPT} hidden onChange={(x) => { sendFileBack(x.target.files?.[0]); x.target.value = ""; }} />
      </div>
      {!postHeld && d && editor && <ExportGapsNote gaps={d.exportGaps} editors={[editor.id]} />}
      {cards && (cards.cards.length > 0 || cards.note) && (
        <details className="text-xs">
          <summary className="cursor-pointer text-zinc-500">{cards.cards.length} {cards.cards.length === 1 ? "card" : "cards"}</summary>
          <ul className="mt-2 flex flex-wrap gap-2">
            {cards.cards.map((c) => (
              <li key={c.id} className="relative w-16">
                <img src={cardStillUrl(e.id, n, c.id)} alt={c.text} title={c.text} className="block w-full rounded-md bg-zinc-800" />
                {editable && (
                  <button type="button" aria-label={`Like the card “${c.text}”`} aria-pressed={c.liked} disabled={c.liked}
                    onClick={() => void run(async () => onEdit(await likeCard(e.id, n, c.id)))}
                    className={cn("absolute bottom-1 right-1 rounded-full p-1 text-white", c.liked ? "bg-violet-500" : "bg-black/70 hover:bg-black")}>
                    <ThumbsUp className="h-3 w-3" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {cards.note && <p className="mt-1 text-zinc-500">{cards.note}</p>}
        </details>
      )}
    </article>
  );
  if (!editable) return card;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!d} onSelect={() => void duplicate()}><Copy /> Duplicate</ContextMenuItem>
        <ContextMenuItem onSelect={() => setRenaming(true)}><Pencil /> Rename</ContextMenuItem>
        <ContextMenuItem onSelect={() => void remove()} className="text-red-500"><Trash2 /> Delete</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!d || !!job} onSelect={() => void run(async () => onEdit(await reviewDraft(e.id, n)))}>Make the preview again</ContextMenuItem>
        {e.style?.animation && <ContextMenuItem disabled={!!job} onSelect={() => void run(async () => onEdit(await makeCardsAgain(e.id, n)))}>Make the cards again</ContextMenuItem>}
        <ContextMenuItem onSelect={() => navigate(`/editor/${e.id}/${n}`)}>Open timeline</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

const TABS = [
  { key: "script", label: "Script" },
  { key: "media", label: "Media" },
  { key: "brief", label: "Brief" },
  { key: "activity", label: "Activity" },
] as const;
type Tab = (typeof TABS)[number]["key"];

/** The tabs under the cards: one edit's script, media, brief and activity (a project's: the edit picked above them). */
function EditTabs({ id, edits, pick }: { id: string; edits?: string[]; pick: (id: string) => void }) {
  const edit = useEdit(id);
  const e = edit.data;
  const [params, setParams] = useSearchParams();
  if (!e) return null;
  const tab = (TABS.find((t) => t.key === params.get("tab"))?.key ?? "script") as Tab;
  return (
    <section className="min-w-0 rounded-xl border border-zinc-500/20">
      {edits && (
        <div className="flex gap-1 overflow-x-auto border-b border-zinc-500/15 px-2 py-1.5 [scrollbar-width:none]">
          {edits.map((x) => <EditChip key={x} id={x} on={x === id} onPick={() => pick(x)} />)}
        </div>
      )}
      <nav className="flex gap-1 overflow-x-auto border-b border-zinc-500/15 px-2 [scrollbar-width:none]">
        {TABS.map((t) => (
          <button key={t.key} type="button" aria-pressed={tab === t.key}
            onClick={() => setParams((cur) => { const n = new URLSearchParams(cur); if (t.key === "script") n.delete("tab"); else n.set("tab", t.key); return n; }, { replace: true })}
            className={cn("relative shrink-0 px-3 py-2.5 text-sm", tab === t.key ? "text-foreground" : "text-zinc-500 hover:text-foreground")}>
            {t.label}
            {tab === t.key && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded bg-violet-500" />}
          </button>
        ))}
      </nav>
      <div className="p-4">
        {tab === "script" && <ScriptTab e={e} onEdit={edit.set} />}
        {tab === "media" && <MediaTab e={e} onEdit={edit.set} />}
        {tab === "brief" && <BriefTab e={e} onEdit={edit.set} />}
        {tab === "activity" && <ActivityTab e={e} onEdit={edit.set} />}
      </div>
    </section>
  );
}

function EditChip({ id, on, onPick }: { id: string; on: boolean; onPick: () => void }) {
  const name = useEdit(id).data?.name ?? "";
  return (
    <button type="button" onClick={onPick} aria-pressed={on}
      className={cn("shrink-0 rounded-md px-2.5 py-1 text-xs", on ? "bg-zinc-500/15 text-foreground" : "text-zinc-500 hover:text-foreground")}>
      {name}
    </button>
  );
}

/** Each version's script: the versions to click through, the picked one's lines and the take each uses (play it, swap it). */
function ScriptTab({ e, onEdit }: { e: Edit; onEdit: (e: Edit) => void }) {
  const editable = canChange(useMe(), "editor");
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (e.sentences) getSentences(e.id).then(setSentences, () => {});
  }, [e.id, e.sentences]);
  const plans = e.plans.filter((p) => !e.marks?.[p.name]?.trashedAt);
  const plan = plans.find((p) => p.name === picked) ?? plans[0];
  const busy = e.jobs.some(busyJob);
  if (!plan) return <p className="text-sm text-zinc-500">No script yet</p>;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-1">
        {plans.map((p) => (
          <button key={p.name} type="button" onClick={() => setPicked(p.name)} aria-pressed={p === plan}
            className={cn("rounded-md px-2.5 py-1 text-xs", p === plan ? "bg-zinc-500/15 text-foreground" : "text-zinc-500 hover:text-foreground")}>
            {versionTitle(e, p.name)}
          </button>
        ))}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {playing && <video key={playing} src={playing} controls autoPlay className="max-h-64 w-fit rounded-lg bg-black" onEnded={() => setPlaying(null)} />}
      <ol className="grid gap-0">
        {plan.lines.map((l, at) => {
          const line = e.lines.find((x) => x.id === l.line);
          const span = takeSpan(l.take, sentences);
          return (
            <li key={`${l.line}-${at}`} className="flex items-start gap-3 border-t border-zinc-500/15 py-2 text-sm first:border-t-0">
              <span className="w-6 shrink-0 pt-0.5 text-xs text-zinc-500">{at + 1}</span>
              <span className="min-w-0 flex-1">{line?.text ?? l.line}</span>
              {span && (
                <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label={`Play take ${l.take.first}-${l.take.last}`}
                  onClick={() => setPlaying(`/api/library/media/${span.src}/play#t=${span.s.toFixed(2)},${span.e.toFixed(2)}`)}>
                  <Play className="h-3.5 w-3.5" />
                </Button>
              )}
              {editable && line && (
                <select aria-label={`Take for ${l.line} in ${versionTitle(e, plan.name)}`} disabled={busy || line.takes.length < 2}
                  value={`${l.take.first}-${l.take.last}`}
                  onChange={(x) => {
                    const t = line.takes.find((y) => `${y.first}-${y.last}` === x.target.value);
                    if (t) putLines(e.id, swapTake(plan, at, t)).then(onEdit, (y) => setError(message(y)));
                  }}
                  className="h-7 shrink-0 rounded-md border border-zinc-500/30 bg-transparent px-1 text-xs">
                  {line.takes.map((t) => (
                    <option key={`${t.first}-${t.last}`} value={`${t.first}-${t.last}`}>
                      {t.first === t.last ? `Sentence ${t.first}` : `Sentences ${t.first}-${t.last}`} · {Math.round(t.score * 100)}
                    </option>
                  ))}
                </select>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The footage: each clip, its eye line (drag it onto the speaker's eyes once: punch-ins keep it in place), the language. */
function MediaTab({ e, onEdit }: { e: Edit; onEdit: (e: Edit) => void }) {
  const editable = canChange(useMe(), "editor");
  const [blind, setBlind] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // an edit with no language of its own is heard in its workspace's (api/lib/video-languages.ts)
  const workspaceLanguages = useWorkspace((s) => s.projects.find((p) => p.id === (e.projectId ?? s.currentProjectId))?.languages);
  const act = (p: Promise<Edit>) => p.then(onEdit, (x) => setError(message(x)));
  const busy = e.jobs.some(busyJob);
  // not before anything has run: the first step finds the eyes itself, and there is no cut yet to keep them level in
  const lines = editable && e.jobs.length > 0 && !e.sources.every((v) => blind.includes(v));
  return (
    <div className="grid gap-4">
      {error && <p className="text-sm text-red-400">{error}</p>}
      {e.sources.length === 0 && <p className="text-sm text-zinc-500">No footage</p>}
      {lines && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-zinc-500">Drag the line onto the speaker's eyes in each clip: the zoom on cuts keeps them at that height.</p>
          {!busy && e.plans.length > 0 && <Button size="sm" variant="outline" onClick={() => void act(runEdit(e.id, "draft"))}>Draft again</Button>}
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        {e.sources.map((v) =>
          lines ? (
            <EyeLine key={v} versionId={v} y={e.eyeline[v] ?? e.eyelineFound?.[v] ?? DEFAULT_EYELINE}
              note={e.eyeline[v] !== undefined ? "Set by hand" : e.eyelineFound?.[v] !== undefined ? "Found" : undefined}
              onSet={(y) => void act(setEyeline(e.id, v, y))} onNoPicture={() => setBlind((b) => (b.includes(v) ? b : [...b, v]))} />
          ) : (
            <span key={v} className="h-24 w-40 overflow-hidden rounded-lg border border-zinc-500/20 bg-zinc-800">
              <Picture src={thumb(v)} alt="" className="h-full w-full object-cover" />
            </span>
          ),
        )}
      </div>
      {editable && (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-zinc-500">Spoken in</span>
          <LanguageSelect fallback={workspaceLanguages} value={e.languages?.[0] ?? ""} onChange={(code) => void act(patchEdit(e.id, { languages: code ? [code] : [] }))}
            className="rounded-md border border-zinc-500/30 bg-transparent px-2 py-1 text-sm" />
        </label>
      )}
      {editable && <VoicePick e={e} act={act} />}
      {e.notes.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-zinc-500">
          {e.notes.map((x, i) => <li key={i}>{x}</li>)}
        </ul>
      )}
    </div>
  );
}

/**
 * The edit's voice: Off (as recorded) until the person picks an enhancer, and with several recordings each one's own
 * pick. A change makes every version's sound again; Review's voice controls then blend it against the original.
 */
function VoicePick({ e, act }: { e: Edit; act: (p: Promise<Edit>) => void }) {
  const [avail, setAvail] = useState<EnhanceAvailability | null>(null);
  useEffect(() => void getAvailability().then(setAvail, () => {}), []);
  const fx = e.voice?.fx ?? "off";
  const usable = ENGINES.filter((x) => avail?.[x.key] === true || x.key === fx || Object.values(e.voice?.per ?? {}).includes(x.key));
  const set = (voice: EditVoice) => act(patchEdit(e.id, { voice }));
  const cls = "rounded-md border border-zinc-500/30 bg-transparent px-2 py-1 text-sm";
  const options = usable.map((x) => <option key={x.key} value={x.key}>{x.label}</option>);
  return (
    <div className="grid gap-2 text-sm">
      <label className="flex flex-wrap items-center gap-2">
        <span className="text-zinc-500">Voice</span>
        <select aria-label="Voice enhancer" value={fx} onChange={(ev) => set({ ...e.voice, fx: ev.target.value })} className={cls}>
          <option value="off">As recorded</option>
          {options}
        </select>
        {avail && !usable.length && <span className="text-xs text-zinc-500">Add an Audio Enhancer key in Settings to enhance the voice</span>}
      </label>
      {fx !== "off" && e.sources.length > 1 && e.sources.map((v, k) => (
        <label key={v} className="flex flex-wrap items-center gap-2 pl-4 text-xs">
          <span className="text-zinc-500">Clip {k + 1}</span>
          <select aria-label={`Voice of clip ${k + 1}`} value={e.voice?.per?.[v] ?? ""} className={cls}
            onChange={(ev) => {
              const { [v]: _, ...per } = e.voice?.per ?? {};
              set({ ...e.voice!, per: ev.target.value ? { ...per, [v]: ev.target.value } : per });
            }}>
            <option value="">Same as the edit</option>
            <option value="off">As recorded</option>
            {options}
          </select>
        </label>
      ))}
    </div>
  );
}

/** What was asked for: the description and the script, the style it was made with (and Save as style), the flags. */
function BriefTab({ e, onEdit }: { e: Edit; onEdit: (e: Edit) => void }) {
  const editable = canChange(useMe(), "editor");
  const [brief, setBrief] = useState(e.brief);
  const [script, setScript] = useState(e.script);
  const [error, setError] = useState<string | null>(null);
  const act = (p: Promise<Edit>) => p.then(onEdit, (x) => setError(message(x)));
  // the style selector: the workspace's styles; picking one puts its choices on the edit (a cut already made stays as it is)
  const styleList = useCachedLoad<EditingStylesView>("/api/editor/styles", listStyles, { own: true });
  const styles = styleList.data?.styles ?? [];
  const pickStyle = (id: string) =>
    act(patchEdit(e.id, { style: id || null }).then((x) => {
      if (x.drafts.length) toast("Run again to cut it in this style");
      return x;
    }));
  /** This edit's choices under a name, as a new editing style (its brief, script and footage stay here). */
  const saveAsStyle = async () => {
    const name = (await promptDialog({ title: "Save as style", ok: "Save", value: (e.style?.name ?? e.name).slice(0, STYLE_NAME_MAX) }))?.trim();
    if (!name) return;
    try {
      const s = await createStyle({ fromEdit: e.id, name });
      toast.success(`Saved “${s.name}” in Editing styles`);
    } catch (x) {
      setError(message(x));
    }
  };
  const field = "rounded-md border border-zinc-500/30 bg-transparent px-2 py-2 text-sm";
  return (
    <div className="grid max-w-3xl gap-5 text-sm">
      {error && <p className="text-red-400">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="edit-style" className="text-zinc-500">Editing style</label>
        {editable && (styles.length > 0 || e.style) ? (
          <select id="edit-style" value={e.style?.id ?? ""} onChange={(x) => void pickStyle(x.target.value)} className="h-8 rounded-md border border-zinc-500/30 bg-transparent px-2 text-sm">
            <option value="">None</option>
            {e.style && !styles.some((s) => s.id === e.style!.id) && <option value={e.style.id}>{e.style.name}</option>}
            {styles.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : (
          <span id="edit-style">{e.style?.name ?? "None"}</span>
        )}
        {e.versions > 1 && <span className="text-zinc-500">· {e.versions} versions</span>}
        {e.targetS > 0 && <span className="text-zinc-500">· {e.targetS} s</span>}
        {editable && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void saveAsStyle()}>Save as style</Button>}
      </div>
      {e.flagDefs.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {e.flagDefs.map((f) => {
            const on = !!e.flags[f.id];
            return (
              <Button key={f.id} size="sm" variant={on ? "default" : "outline"} aria-pressed={on} disabled={!editable}
                onClick={() => void act(patchEdit(e.id, { flags: { [f.id]: !on } }))}>
                {f.label}
              </Button>
            );
          })}
        </div>
      )}
      <label className="grid gap-1.5">
        <span className="text-zinc-500">What the video should be</span>
        <textarea value={brief} onChange={(x) => setBrief(x.target.value)} rows={4} readOnly={!editable} className={field} />
      </label>
      <label className="grid gap-1.5">
        <span className="text-zinc-500">Script</span>
        <textarea value={script} onChange={(x) => setScript(x.target.value)} rows={4} readOnly={!editable} className={field} placeholder="The text the takes were read from" />
      </label>
      {editable && (brief !== e.brief || script !== e.script) && (
        <Button size="sm" className="w-fit" onClick={() => void act(patchEdit(e.id, { brief, script }))}>Save</Button>
      )}
    </div>
  );
}

/** Every step, newest last, with its state; Retry a failed one, Stop what runs, Run again from the start. */
function ActivityTab({ e, onEdit }: { e: Edit; onEdit: (e: Edit) => void }) {
  const editable = canChange(useMe(), "editor");
  const [error, setError] = useState<string | null>(null);
  const act = (p: Promise<Edit>) => p.then(onEdit, (x) => setError(message(x)));
  const busy = e.jobs.some(busyJob);
  return (
    <div className="grid gap-3">
      {error && <p className="text-sm text-red-400">{error}</p>}
      {editable && (
        <div className="flex gap-2">
          {busy ? (
            <Button size="sm" variant="outline" onClick={() => void act(stopEdit(e.id))}><Square className="h-3.5 w-3.5" /> Stop</Button>
          ) : (
            <Button size="sm" variant="outline" disabled={!e.sources.length} onClick={() => void confirmHeavy("editor").then((go) => { if (go) void act(runEdit(e.id)); })}>
              <RotateCcw className="h-3.5 w-3.5" /> Run again
            </Button>
          )}
        </div>
      )}
      {e.jobs.length === 0 ? (
        <p className="text-sm text-zinc-500">No activity</p>
      ) : (
        <ul className="flex flex-col divide-y divide-zinc-500/15 rounded-xl border border-zinc-500/20">
          {e.jobs.map((j) => (
            <li key={j.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className="font-medium">{STEP_NAME[j.kind] ?? j.kind}</span>
              {j.variant && <span className="text-xs text-zinc-500">{versionTitle(e, j.variant)}</span>}
              <StateBadge state={j.error === "Stopped" ? "stopped" : j.state} />
              {j.state === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />}
              {busyJob(j) && stepLine(j) && <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">{stepLine(j)}</span>}
              {j.error && j.error !== "Stopped" && (
                <span className="min-w-0 flex-1 text-xs text-zinc-500">
                  {j.error}
                  {j.state === "needs_key" && /Settings →/.test(j.error) && <> <Link to={settingFor(j.error)} className="underline">Open Settings</Link></>}
                </span>
              )}
              {editable && (j.state === "failed" || j.state === "needs_key") && (
                <Button size="sm" variant="outline" className="ml-auto" onClick={() => void act(retryJob(e.id, j.id))}>Retry</Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A clip's frame with its eye line: drag (or click) to move it; it is saved when let go. */
function EyeLine({ versionId, y, note, onSet, onNoPicture }: { versionId: string; y: number; note?: string; onSet: (y: number) => void; onNoPicture: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [gone, setGone] = useState(false);
  const at = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  };
  const shown = drag ?? y;
  if (gone) return null;
  return (
    <div
      ref={box}
      role="slider"
      aria-label="Eye line"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(shown * 100)}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        onSet(Math.min(1, Math.max(0, y + (e.key === "ArrowUp" ? -0.01 : 0.01))));
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(at(e));
      }}
      onPointerMove={(e) => drag !== null && setDrag(at(e))}
      onPointerUp={(e) => {
        if (drag === null) return;
        onSet(at(e));
        setDrag(null);
      }}
      className="relative w-40 cursor-ns-resize touch-none select-none overflow-hidden rounded-lg bg-zinc-800"
    >
      <img src={thumb(versionId)} alt="" draggable={false} className="block min-h-16 w-full" onError={() => { setGone(true); onNoPicture(); }} />
      <div className="pointer-events-none absolute inset-x-0 border-t-2 border-violet-400 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]" style={{ top: `${shown * 100}%` }} />
      {note && <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/60 px-1.5 text-[11px] text-white">{note}</span>}
    </div>
  );
}
