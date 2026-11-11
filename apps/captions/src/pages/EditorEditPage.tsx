import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Download, ExternalLink, Loader2, Play, RotateCcw, Square, ThumbsUp, Trash2 } from "lucide-react";
import { DEFAULT_EYELINE, type Draft, type Edit, type Sentence } from "@contracts/editor";
import { AppBar } from "@/components/AppBar";
import { Button } from "@/components/ui/button";
import { cardStillUrl, createStyle, deleteEdit, exportUrl, getEdit, getSentences, likeCard, makeCardsAgain, patchEdit, putLines, retryJob, reviewDraft, runEdit, setEyeline, stopEdit, swapTake, takeSpan } from "@/lib/editor";
import { useCachedLoad } from "@/lib/local-cache";
import { cn } from "@/lib/utils";
import { confirmHeavy } from "@/lib/setup";
import { StateBadge, thumb } from "./EditorPage";
import { confirmDialog, promptDialog } from "@/lib/dialogs";
import { toast } from "sonner";
import { STYLE_NAME_MAX } from "@contracts/editor-styles";

/**
 * One edit (/editor/:id): its steps (a step that needs a key or provider links to the setting), an eye line per source
 * (drag it onto the speaker's eyes once: punch-ins keep it in place), the script table (lines × versions, each cell the
 * take that version uses: play it, swap it among the line's takes), and per version its preview, checks and downloads.
 * It polls while a step is queued or running.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const STEP_NAME: Record<string, string> = { analyze: "Analyze", script: "Script", draft: "Draft", preview: "Preview", file: "File in Review", broll: "B-roll", cards: "Cards", "cards-draw": "Draw cards" };
/** The setting a needs-key message names: a key in API keys, else (a provider, a Mac that is off) AI providers. */
const settingFor = (why: string) => (/Settings → API keys/.test(why) && !/Settings → Providers/.test(why) ? "/settings/keys" : "/settings/providers");

export default function EditorEditPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  // the saved copy paints at once; the server says when a step moved (lib/local-cache), so nothing polls
  const live = useCachedLoad<Edit>(`/api/editor/${id}`, () => getEdit(id));
  const edit = live.data;
  const setEdit = live.set;
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null); // a take's play URL
  const busy = !!edit?.jobs.some((j) => j.state === "queued" || j.state === "running");

  const act = (p: Promise<Edit>) =>
    p.then((e) => {
      setEdit(e);
      setError(null);
    }, (e) => setError(message(e)));


  const sentenceCount = edit?.sentences ?? 0;
  useEffect(() => {
    if (sentenceCount) getSentences(id).then(setSentences, () => {});
  }, [id, sentenceCount]);

  const draftKey = edit ? `${edit.drafts.join(",")}|${edit.updatedAt}|${edit.jobs.filter((j) => j.kind === "draft" && j.state === "done").length}` : "";
  useEffect(() => {
    if (!edit) return;
    for (const n of edit.drafts) {
      fetch(`/api/editor/${id}/drafts/${n}`)
        .then((r) => (r.ok ? (r.json() as Promise<Draft>) : null))
        .then((d) => d && setDrafts((all) => ({ ...all, [n]: d })), () => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, draftKey]);

  if (!edit) {
    return (
      <div className="flex min-h-dvh flex-col">
        <AppBar tool="AI Editor" to="/editor" />
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-4 sm:px-6">
          {error || live.error ? <p className="text-sm text-red-400">{error || live.error}</p> : <div aria-hidden="true" className="h-[420px] rounded-xl border border-zinc-500/20" />}
        </main>
      </div>
    );
  }

  const remove = async () => {
    if (!(await confirmDialog({ title: `Move “${edit.name}” to the trash?`, ok: "Move to trash", danger: true, deleting: true }))) return;
    try {
      await deleteEdit(id);
      navigate("/editor");
    } catch (e) {
      setError(message(e));
    }
  };

  /** This edit's choices under a name, as a new editing style (its brief, script and footage stay here). */
  const saveAsStyle = async () => {
    const name = (await promptDialog({ title: "Save as style", ok: "Save", value: (edit.style?.name ?? edit.name).slice(0, STYLE_NAME_MAX) }))?.trim();
    if (!name) return;
    try {
      const s = await createStyle({ fromEdit: id, name });
      toast.success(`Saved “${s.name}” in Editing styles`);
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar tool="AI Editor" to="/editor" trail={edit.name}>
        <Button size="sm" variant="outline" onClick={() => void saveAsStyle()}>
          Save as style
        </Button>
        {busy && (
          <Button size="sm" variant="outline" onClick={() => void act(stopEdit(id))}>
            <Square className="h-3.5 w-3.5" />
            Stop
          </Button>
        )}
        {!busy && (
          <Button size="sm" variant="outline" onClick={() => void confirmHeavy("editor").then((go) => { if (go) void act(runEdit(id)); })}>
            <RotateCcw className="h-3.5 w-3.5" />
            Run again
          </Button>
        )}
        <Button size="sm" variant="ghost" aria-label="Move to the trash" onClick={() => void remove()}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </AppBar>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-4 sm:px-6">
        {error && <p className="text-sm text-red-400">{error}</p>}

        {edit.flagDefs.length > 0 && (
          <section aria-label="Flags" className="flex flex-wrap items-center gap-2">
            {edit.flagDefs.map((f) => {
              const on = !!edit.flags[f.id];
              return (
                <Button key={f.id} size="sm" variant={on ? "default" : "outline"} aria-pressed={on} onClick={() => void act(patchEdit(id, { flags: { [f.id]: !on } }))}>
                  {f.label}
                </Button>
              );
            })}
          </section>
        )}

        <section aria-label="Steps" className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Steps</h2>
          {edit.jobs.length === 0 && <p className="text-sm text-zinc-500">Nothing has run yet.</p>}
          <ul className="flex flex-col divide-y divide-zinc-500/15 rounded-xl border border-zinc-500/20">
            {edit.jobs.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="font-medium">{STEP_NAME[j.kind] ?? j.kind}</span>
                {j.variant && <span className="text-xs text-zinc-500">{edit.plans.find((p) => p.name === j.variant)?.title ?? j.variant}</span>}
                <StateBadge state={j.state} />
                {j.state === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />}
                {j.error && (
                  <span className="min-w-0 flex-1 text-xs text-zinc-500">
                    {j.error}
                    {j.state === "needs_key" && (
                      <>
                        {" "}
                        <Link to={settingFor(j.error)} className="underline">
                          Open Settings
                        </Link>
                      </>
                    )}
                  </span>
                )}
                {(j.state === "failed" || j.state === "needs_key") && (
                  <Button size="sm" variant="outline" className="ml-auto" onClick={() => void act(retryJob(id, j.id))}>
                    Retry
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {edit.notes.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-zinc-500">
              {edit.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Eye line" className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Eye line</h2>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-zinc-500">Drag the line onto the speaker's eyes in each clip. Punch-ins keep the eyes at that height. Change it, then draft again (no AI).</p>
            {!busy && edit.plans.length > 0 && (
              <Button size="sm" variant="outline" onClick={() => void act(runEdit(id, "draft"))}>
                Draft again
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-3">
            {edit.sources.map((v) => (
              <EyeLine key={v} versionId={v} y={edit.eyeline[v] ?? DEFAULT_EYELINE} onSet={(y) => void act(setEyeline(id, v, y))} />
            ))}
          </div>
        </section>

        {edit.plans.length > 0 && (
          <section aria-label="Script" className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">Script</h2>
            {playing && (
              <video key={playing} src={playing} controls autoPlay className="max-h-64 w-fit rounded-lg bg-black" onEnded={() => setPlaying(null)} />
            )}
            <div className="overflow-x-auto rounded-xl border border-zinc-500/20">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-500/20 text-left text-xs text-zinc-500">
                    <th className="px-3 py-2 font-medium">Line</th>
                    {edit.plans.map((p) => (
                      <th key={p.name} className="px-3 py-2 font-medium">
                        {p.title || p.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {edit.lines.map((line) => (
                    <tr key={line.id} className="border-b border-zinc-500/10 align-top last:border-0">
                      <td className="max-w-xs px-3 py-2">{line.text}</td>
                      {edit.plans.map((p) => {
                        const at = p.lines.findIndex((l) => l.line === line.id);
                        const take = at >= 0 ? p.lines[at]!.take : null;
                        const span = take && takeSpan(take, sentences);
                        return (
                          <td key={p.name} className="px-3 py-2">
                            {take ? (
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs text-zinc-500">#{at + 1}</span>
                                {span && (
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7"
                                    aria-label={`Play take ${take.first}-${take.last}`}
                                    onClick={() => setPlaying(`/api/library/media/${span.src}/play#t=${span.s.toFixed(2)},${span.e.toFixed(2)}`)}
                                  >
                                    <Play className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                                <select
                                  aria-label={`Take for ${line.id} in ${p.title || p.name}`}
                                  disabled={busy || line.takes.length < 2}
                                  value={`${take.first}-${take.last}`}
                                  onChange={(e) => {
                                    const t = line.takes.find((x) => `${x.first}-${x.last}` === e.target.value);
                                    if (t) void act(putLines(id, swapTake(p, at, t)));
                                  }}
                                  className="h-7 rounded-md border border-zinc-500/30 bg-transparent px-1 text-xs"
                                >
                                  {line.takes.map((t) => (
                                    <option key={`${t.first}-${t.last}`} value={`${t.first}-${t.last}`}>
                                      {t.first === t.last ? `Sentence ${t.first}` : `Sentences ${t.first}-${t.last}`} · {Math.round(t.score * 100)}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            ) : (
                              <span className="text-xs text-zinc-500">–</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {edit.drafts.length > 0 && (
          <section aria-label="Versions" className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">Versions</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {edit.drafts.map((n) => {
                const pv = edit.previews[n];
                const d = drafts[n];
                const title = edit.plans.find((p) => p.name === n)?.title ?? n;
                const cards = edit.cards?.[n];
                return (
                  <article key={n} aria-label={title} className="flex flex-col gap-2 rounded-xl border border-zinc-500/20 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="truncate text-sm font-medium">{title}</h3>
                      {d && <span className="shrink-0 text-xs text-zinc-500">{(Math.max(0, ...d.timeline.tracks.V1.items.map((i) => i.rec + i.len)) / d.timeline.fps).toFixed(1)} s</span>}
                    </div>
                    {pv ? (
                      <video src={`/api/review/assets/${pv.assetId}/v/${pv.n}/play`} controls preload="metadata" className="max-h-80 w-full rounded-lg bg-black" />
                    ) : (
                      <p className="rounded-lg bg-zinc-500/10 py-8 text-center text-xs text-zinc-500">No preview yet</p>
                    )}
                    {d && d.qa.notes.length > 0 && (
                      <ul className="list-disc pl-5 text-xs text-amber-600">
                        {d.qa.notes.map((x, i) => (
                          <li key={i}>{x}</li>
                        ))}
                      </ul>
                    )}
                    {cards && (
                      <section aria-label={`Cards of ${title}`} className="flex flex-col gap-1.5">
                        {cards.cards.length > 0 && (
                          <ul className="flex flex-wrap gap-2">
                            {cards.cards.map((card) => (
                              <li key={card.id} className="relative w-20">
                                <img src={cardStillUrl(id, n, card.id)} alt={card.text} title={card.text} className="block w-full rounded-md bg-zinc-800" />
                                <button
                                  type="button"
                                  aria-label={`Like the card “${card.text}”`}
                                  aria-pressed={card.liked}
                                  disabled={card.liked}
                                  onClick={() => void act(likeCard(id, n, card.id))}
                                  className={cn("absolute bottom-1 right-1 rounded-full p-1.5 text-white", card.liked ? "bg-violet-500" : "bg-black/70 hover:bg-black")}
                                >
                                  <ThumbsUp className="h-3 w-3" />
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        {cards.note && <p className="text-xs text-zinc-500">{cards.note}</p>}
                      </section>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                      {(["otio", "fcpxml", "zip"] as const).map((f) => (
                        <Button key={f} asChild size="sm" variant="outline">
                          <a href={exportUrl(id, n, f)} download>
                            <Download className="h-3.5 w-3.5" />
                            {f === "otio" ? "OTIO" : f === "fcpxml" ? "FCPXML" : "ZIP"}
                          </a>
                        </Button>
                      ))}
                      {pv && (
                        <Button asChild size="sm" variant="ghost">
                          <Link to={`/review/${pv.assetId}?v=${pv.n}`}>
                            <ExternalLink className="h-3.5 w-3.5" />
                            Open in Review
                          </Link>
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(reviewDraft(id, n))}>
                        Render preview again
                      </Button>
                      {edit.style?.animation && (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(makeCardsAgain(id, n))}>
                          Make cards again
                        </Button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

/** A clip's frame with its eye line: drag (or click) to move it; it is saved when let go. */
function EyeLine({ versionId, y, onSet }: { versionId: string; y: number; onSet: (y: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const at = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  };
  const shown = drag ?? y;
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
      <img src={thumb(versionId)} alt="" draggable={false} className="block min-h-16 w-full" />
      <div className="pointer-events-none absolute inset-x-0 border-t-2 border-violet-400 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]" style={{ top: `${shown * 100}%` }} />
    </div>
  );
}
