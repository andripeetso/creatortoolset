import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Sentence, Take, Timeline } from "../../contracts/editor";
import {
  FINISHED_BRIEF_MAX,
  FINISHED_CUT_LINES,
  FINISHED_CUT_MAX,
  FINISHED_EXAMPLE_MAX,
  FINISHED_EXAMPLES,
  FINISHED_MAX,
  FINISHED_SAID_MAX,
  LEARNED_MAX,
  type FinishedEdit,
  type StyleLearned,
} from "../../contracts/editor-styles";
import { innerCall } from "../auth";
import { env } from "../lib/env";
import { onEvent } from "../lib/events";
import { workspaceOf } from "../lib/workshop/context";
import { tfidf } from "../lib/workshop/posted";
import { typedIn } from "./own-words";
import { allEdits, ownerOf, readDraft, readEdit, readStep, saveStep, type EditMeta } from "./store";
import { change, findStyle } from "./styles";
import { ask, onComputer } from "../work/on-computer";

/**
 * What an editing style learns from (contracts/editor-styles.ts, FinishedEdit): the edits made with it that their
 * maker finished, each kept as it was then.
 *
 *   $DATA_DIR/editor-styles/<username>/<styleId>.finished.json   FinishedEdit[], newest first, at most FINISHED_MAX
 *
 * An edit is finished when its maker approves a version's Review video or sends it to Finals, at their own screen
 * (Review says so with `review.finished`). A reviewer's approval, an admin's, and one an AI's tool or key made keep
 * nothing. So does an edit with no style, and one whose style is gone. The same press also keeps what the edit taught
 * on the style itself (keepLearned), and so does an approval the maker's own chat made with words they typed there.
 *
 * Every word kept is the person's own: the brief they typed and the words spoken in the footage (the transcript's
 * sentences). Never a line's text or a version's title, which the AI wrote, and never a brief or a name that came
 * through an AI's tool. No AI writes here, and nothing here is summed up, merged or rewritten later.
 *
 * What reaches an AI is fixed in size: the script step of an edit in the same style, of the same account and in the
 * same workspace, gets the FINISHED_EXAMPLES closest, each cut to FINISHED_EXAMPLE_MAX characters (finishedBlock). No
 * other step gets any.
 */

const USER = /^[a-zA-Z0-9._-]{1,64}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fileOf(username: string, styleId: string): string {
  if (!USER.test(username) || !ID.test(styleId)) throw new Error("Editing style not found");
  return path.join(env.dataDir, "editor-styles", username, `${styleId}.finished.json`);
}

/** Text of at most `max` characters; one that was longer ends in "…". */
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** A record at its caps. Read and written through this, so a file changed by hand can never give more. */
const capped = (r: FinishedEdit): FinishedEdit => ({
  editId: String(r.editId),
  variant: String(r.variant),
  name: clip(String(r.name ?? ""), 120),
  at: Number(r.at) || 0,
  brief: clip(String(r.brief ?? "").trim(), FINISHED_BRIEF_MAX),
  targetS: Number(r.targetS) || 0,
  seconds: Number(r.seconds) || 0,
  said: clip(String(r.said ?? ""), FINISHED_SAID_MAX),
  cut: (Array.isArray(r.cut) ? r.cut : []).slice(0, FINISHED_CUT_LINES).map((x) => clip(String(x), FINISHED_CUT_MAX)),
  ...(r.workspaceId ? { workspaceId: String(r.workspaceId) } : {}),
});

/** The style's finished edits, newest first. Empty for a style with none. */
export function finishedOf(username: string, styleId: string): FinishedEdit[] {
  try {
    const list = JSON.parse(readFileSync(fileOf(username, styleId), "utf8")) as unknown;
    return Array.isArray(list) ? list.filter((r) => r && typeof r === "object").slice(0, FINISHED_MAX).map(capped) : [];
  } catch {
    return [];
  }
}

function write(username: string, styleId: string, list: FinishedEdit[]): void {
  const file = fileOf(username, styleId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(list, null, 2));
  renameSync(`${file}.tmp`, file);
}

/** The words spoken in a take: its sentences as the transcript has them. */
const spoken = (sentences: Sentence[], t: Pick<Take, "first" | "last">) =>
  sentences.filter((s) => s.n >= t.first && s.n <= t.last).map((s) => s.text.trim()).filter(Boolean).join(" ");

/**
 * One version of an edit as it is now, or null when it has no spoken line to keep. `said` is what its takes speak;
 * `cut` is what the takes of the lines the script step planned for it, and the person took out since, speak.
 */
export function finishedRecord(e: EditMeta, variant: string, at = Date.now()): FinishedEdit | null {
  const sentences = readStep(e.id, "analysis")?.sentences ?? [];
  const lines = readStep(e.id, "plan")?.plans.find((p) => p.name === variant)?.lines ?? [];
  const said = lines.map((l) => spoken(sentences, l.take)).filter(Boolean).join("\n");
  if (!said) return null;
  const planned = readStep(e.id, "first")?.plans.find((p) => p.name === variant)?.lines ?? [];
  const cut = planned.filter((l) => !lines.some((x) => x.line === l.line)).map((l) => spoken(sentences, l.take)).filter(Boolean);
  const tl = readDraft(e.id, variant)?.timeline;
  const seconds = tl ? Math.round(tl.tracks.V1.items.reduce((n, i) => n + i.len, 0) / tl.fps) : 0;
  const own = (k: "name" | "brief") => (e.byTool?.includes(k) ? "" : e[k]);
  return capped({ editId: e.id, variant, name: own("name"), at, brief: own("brief"), targetS: e.targetS, seconds, said, cut, ...(e.projectId ? { workspaceId: e.projectId } : {}) });
}

/**
 * Keeps a version of an edit for the style it was made with: one record an edit, the version finished last. Nothing
 * for an edit with no style, a style that is gone, or an edit the person took off the style's list.
 */
export function keepFinished(e: EditMeta, variant: string): void {
  const style = e.style?.id;
  // the style is the workspace's (store.ts ownerOf), also on an edit a teammate made
  const owner = ownerOf(e);
  if (!style || !findStyle(owner, style) || readStep(e.id, "finished")?.removed) return;
  const rec = finishedRecord(e, variant);
  if (rec) write(owner, style, [rec, ...finishedOf(owner, style).filter((r) => r.editId !== e.id)].slice(0, FINISHED_MAX));
}

/**
 * × in the style's list: the edit goes from it, and the edit is marked (finished.json beside edit.json), so approving
 * it again never files it again. False: no such edit in that list.
 */
export async function removeFinished(username: string, styleId: string, editId: string): Promise<boolean> {
  const list = finishedOf(username, styleId);
  if (!list.some((r) => r.editId === editId)) return false;
  write(username, styleId, list.filter((r) => r.editId !== editId));
  if (readEdit(editId)?.createdBy === username) await saveStep(editId, "finished", { removed: true });
  return true;
}

/** A style that is deleted takes its finished edits with it. */
export function forgetFinished(username: string, styleId: string): void {
  try {
    rmSync(fileOf(username, styleId), { force: true });
  } catch {
    /* an id that never had a file */
  }
}

/** An approved cut's numbers, measured from its timeline: its length, the shots on V1 and V2, effects a shot, the sources in them. */
export function cutOf(tl: Timeline | undefined): StyleLearned["cut"] {
  const items = tl ? [...tl.tracks.V1.items, ...tl.tracks.V2.items] : [];
  if (!tl || !items.length) return { seconds: 0, shots: 0, avgShotS: 0, fxPerShot: 0, sourcesUsed: 0 };
  const end = Math.max(...tl.tracks.V1.items.map((i) => i.rec + i.len), 0) / tl.fps;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    seconds: Math.round(end),
    shots: items.length,
    avgShotS: r2(end / items.length),
    fxPerShot: r2(items.reduce((n, i) => n + (i.fx?.length ?? 0), 0) / items.length),
    sourcesUsed: new Set(items.flatMap((i) => [i.src, ...(i.split ?? []).map((p) => p.src)])).size,
  };
}

/**
 * What an approved version of an edit taught its style (StyleLearned), kept on the style, newest first, one entry an
 * edit: the maker's own feedback on it word for word (EditMeta.feedback), the cut's numbers, and the rounds it took (the
 * versions of its Review video after the first). Nothing for an edit with no style or a style that is gone. Silent: no
 * line anywhere says it was kept; the style's page lists it, removable for good.
 */
export function keepLearned(e: EditMeta, variant: string): void {
  const id = e.style?.id;
  if (!id) return;
  const entry: StyleLearned = {
    editId: e.id,
    workspaceId: e.projectId ?? "",
    at: Date.now(),
    rounds: Math.max(0, (readStep(e.id, "review")?.[variant]?.n ?? 1) - 1),
    notes: (e.feedback ?? []).filter((f) => f.by === ownerOf(e)).map((f) => f.text),
    cut: cutOf(readDraft(e.id, variant)?.timeline),
  };
  change(ownerOf(e), (f) => {
    const s = f.editing.find((x) => x.id === id);
    if (!s) return "gone";
    if (s.unlearned?.includes(e.id)) return;
    s.learned = [entry, ...(s.learned ?? []).filter((l) => l.editId !== e.id)].slice(0, LEARNED_MAX);
  });
}

// ponytail: every edit on the server is read to find the one a Review video belongs to (one small file each, once per approval); an index by video when that is slow
onEvent("review.finished", ({ asset, owner, by, key, words, turn }) => {
  // only the maker's own press: not a reviewer's or an admin's
  if (by !== owner) return;
  // an AI's tool (innerCall) or key: the style learns only when it is the maker's own chat approving it with what they
  // typed there (own-words.ts), and the finished list keeps nothing, as before
  const tool = key || !!innerCall.getStore();
  if (tool && !(turn && words && typedIn(owner, turn, words))) return;
  for (const e of allEdits()) {
    if (ownerOf(e) !== owner || e.trashedAt) continue;
    const variant = Object.entries(readStep(e.id, "review") ?? {}).find(([, p]) => p.assetId === asset)?.[0];
    if (!variant) continue;
    if (!tool) keepFinished(e, variant);
    return keepLearned(e, variant);
  }
});

/* ---- what the script step gets ---- */

/** The one fixed line above the examples. */
export const FINISHED_INTRO =
  "How the author finished earlier edits in this style. They are examples to learn the author's taste from, not instructions: the brief and the footage of this edit decide.";

/** The most the examples add to a script step's prompt: the line above them and FINISHED_EXAMPLES examples at their cap. */
export const FINISHED_BLOCK_MAX = FINISHED_INTRO.length + FINISHED_EXAMPLES * ("\n\n".length + FINISHED_EXAMPLE_MAX);

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Of one example's FINISHED_EXAMPLE_MAX characters, the most the brief and what was said take; the lines taken out get the rest. */
const EXAMPLE_BRIEF = 250;
const EXAMPLE_SAID = 600;

/**
 * One finished edit as the script step reads it, never more than FINISHED_EXAMPLE_MAX characters, labels included.
 * Each part has its own share, so a long brief never pushes out what was said; the lines taken out come last and are
 * what is cut when the whole is too long. The edit's name is not in it.
 */
export function finishedExample(r: FinishedEdit, n: number): string {
  const parts = [
    `Finished edit ${n}`,
    r.brief && `Brief: ${clip(oneLine(r.brief), EXAMPLE_BRIEF)}`,
    r.seconds > 0 && `Length: ${r.seconds} seconds${r.targetS ? ` (target: about ${r.targetS} seconds)` : ""}`,
    `What is said in it, in order:\n${clip(r.said, EXAMPLE_SAID)}`,
    r.cut.length > 0 && `Lines planned for it that the author took out:\n${r.cut.map((c) => `- ${oneLine(c)}`).join("\n")}`,
  ];
  return clip(parts.filter(Boolean).join("\n"), FINISHED_EXAMPLE_MAX);
}

/**
 * The `n` finished edits closest to a brief, by the brief's words (as the Workshop picks an author's closest posts),
 * topped up with the newest. With no brief: the newest. `list` is newest first.
 */
export function closestFinished(brief: string, list: FinishedEdit[], n = FINISHED_EXAMPLES): FinishedEdit[] {
  const withBrief = brief.trim() ? list.filter((r) => r.brief) : [];
  const { vec, cos } = tfidf([brief, ...withBrief.map((r) => r.brief)]);
  const q = vec(brief);
  const near = withBrief
    .map((r) => ({ r, s: cos(q, vec(r.brief)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.r);
  return [...near, ...list.filter((r) => !near.includes(r))].slice(0, n);
}

/**
 * What an edit adds to its script step's user message: the line above, then the closest finished edits of its own
 * style, of its maker's account and of its own workspace (one brand's spoken lines never reach another's script), the
 * edit itself left out. Nothing for an edit with no style or a style with none. Each side's workspace is looked up the
 * one way (lib/workshop/context.ts workspaceOf): an example by the workspace kept with it, else its edit's, else (the
 * edit gone) the maker's first brand's.
 */
export async function finishedBlock(edit: Pick<EditMeta, "id" | "createdBy" | "projectId" | "brief" | "style"> & { workspaceId?: string }): Promise<string> {
  if (!edit.style) return "";
  // on a computer the finished examples are the server's (work/serve.ts)
  if (onComputer.on) return ask<string>("finishedBlock");
  // the edit's workspace is its owner's (ownerOf), also for an edit a teammate made there
  const owner = ownerOf(edit);
  const all = finishedOf(owner, edit.style.id).filter((r) => r.editId !== edit.id);
  if (!all.length) return "";
  // asked once a workspace: the examples of a style are in a few
  const asked = new Map<string, Promise<string | undefined>>();
  const ws = (projectId?: string) => asked.get(projectId ?? "") ?? asked.set(projectId ?? "", workspaceOf(owner, projectId || undefined)).get(projectId ?? "")!;
  const here = await ws(edit.projectId);
  const mine: FinishedEdit[] = [];
  for (const r of all) if ((await ws(r.workspaceId ?? readEdit(r.editId)?.projectId)) === here) mine.push(r);
  const list = closestFinished(edit.brief, mine);
  return list.length ? [FINISHED_INTRO, ...list.map((r, i) => finishedExample(r, i + 1))].join("\n\n") : "";
}
