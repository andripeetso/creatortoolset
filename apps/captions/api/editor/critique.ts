import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Critique, EditPlan, IndexShot } from "../../contracts/edit-plan";
import type { EditFeedback, Timeline } from "../../contracts/editor";
import { isLimitLine } from "../../contracts/plans";
import { aiFor } from "../ai-complete";
import { completeVisionWithFallback } from "../ai-vision";
import { parseJsonObject } from "../lib/instagram/vision";
import { libraryDb } from "../library/db";
import { whoFor } from "../library/describe";
import { enqueueJob, MAX_ATTEMPTS } from "../library/jobs";
import { clock, COLS, ROWS, RULE } from "../library/look";
import { ffmpeg, ffmpegSlot } from "../library/media/run";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { NeedsKey, wordsOf } from "../library/transcribe";
import { ask, onComputer } from "../work/on-computer";
import { blackAtEnd, cutsOf, oddAt, TAIL_S, TH, TW, wordSlips, withFound, type Found } from "./checks";
import { Waiting } from "./analyze";
import type { StepContext } from "./engine";
import { knownShots } from "./index";
import { noteLines, sourceSpan, workspaceSetup } from "./plan";
import { fileInReview, previewFile, saidOf } from "./preview";
import { saidUnder } from "./broll";
import { macAway } from "./script";
import { editDir, markDraft, readDraft, readStep, type DraftFile, type EditMeta } from "./store";
import { styleBlock } from "./styles";

/**
 * The look at a planned cut before the person sees it (tasks/flywheel/PLAN.md stage 4). Two frames of every shot, from
 * the rendered preview, on numbered sheets go to the person's own AI with the brief, their notes word for word, the
 * editing style and each shot's line, for one judgement of the whole cut: the shots that don't hold up, and why (a shot
 * whose footage is measured as blurry, too dark or shaky fails for that too: withFlaws). The cut it looked at goes to
 * Review with the shots that don't hold up named on it, and no other cut is made: a new draft only when the person or
 * their chat asks for one (owner, 2026-11-19, on the fix round that made a second draft by itself: "He never wants a
 * draft he didn't ask for"). A cut is never held back (PLAN.md D7): a look that can't be made (the plan's usage limit,
 * no AI connected, footage still being read, or a failure after its last try) files the cut as it is, at once, with one
 * line on its Review version saying it was not looked at, and why.
 */

const LABEL = "Editor check";
/** Shots on one sheet: two tiles each */
const PER_SHEET = (COLS * ROWS) / 2;
/** A failing shot's reason, in characters */
const WHY_MAX = 120;
/** What a shot's footage is described as, in characters (as the plan reads it) */
const LINE_TEXT = 100;
/** Why a look or a fix could not be made, in characters */
const CANT_MAX = 200;

/** Two frames of each shot of the cut (frame numbers): a little after it starts and a little before it ends, always increasing. */
export function shotFrames(plan: { fps: number; shots: { at: number; dur: number }[] }): number[] {
  const out: number[] = [];
  for (const s of plan.shots) {
    const a = Math.round(s.at * plan.fps);
    const len = Math.max(1, Math.round((s.at + s.dur) * plan.fps) - a);
    const inset = Math.min(Math.round(len / 4), Math.round(plan.fps), Math.floor((len - 1) / 2));
    for (const f of [a + inset, a + len - 1 - inset]) out.push(Math.max(f, (out.at(-1) ?? -1) + 1));
  }
  return out;
}

/**
 * Contact sheets of a video at these frames, COLS across in reading order, PER_SHEET shots a sheet (the last one padded
 * white), as JPEGs in `dir`: one pass over the video, so a whole cut costs one ffmpeg run. Returns the sheets in order.
 */
export async function cutSheets(file: string, frames: number[], landscape: boolean, dir: string): Promise<string[]> {
  const [w, h] = landscape ? [256, 144] : [144, 256];
  await mkdir(dir, { recursive: true });
  // ponytail: one select over every frame number; a cut of a few hundred shots makes a long expression, fine for ffmpeg
  const cell = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w + 8}:${h + 8}:(ow-iw)/2:(oh-ih)/2:white,setsar=1`;
  await ffmpeg(["-i", file, "-vf", `select='${frames.map((f) => `eq(n,${f})`).join("+")}',${cell},tile=${COLS}x${ROWS}:color=white`, "-fps_mode", "vfr", "-q:v", "4", path.join(dir, "%d.jpg")]);
  return Array.from({ length: Math.ceil(frames.length / (COLS * ROWS)) }, (_, k) => path.join(dir, `${k + 1}.jpg`));
}

/** The shot description a stretch of footage has, as a line's tail: ` · a4 clear · blurry · fight, boss · what happens`. */
export const described = (x: Pick<IndexShot, "desc" | "action" | "clear" | "tags" | "flaws">): string => {
  const text = (x.desc ?? "").replace(/\s+/g, " ").trim().slice(0, LINE_TEXT);
  return `${x.action !== undefined ? ` · a${x.action}${x.clear ? " clear" : ""}` : ""}${x.flaws?.length ? ` · ${x.flaws.join(", ")}` : ""}${x.tags?.length ? ` · ${x.tags.join(", ")}` : ""}${text ? ` · ${text}` : ""}`;
};

/** The stretch of footage each shot of the cut shows at its middle, by its place in the cut; none for a made clip or footage not indexed. */
export async function shownStretches(plan: EditPlan): Promise<(IndexShot | undefined)[]> {
  const known = new Map<string, IndexShot[]>();
  const out: (IndexShot | undefined)[] = [];
  for (const s of plan.shots) {
    if ("generate" in s.src) {
      out.push(undefined);
      continue;
    }
    const id = s.src.source;
    if (!known.has(id)) known.set(id, await knownShots(id));
    const mid = s.src.inS + sourceSpan(s.dur, s.speed, s.ramp) / 2;
    out.push(known.get(id)!.find((y) => y.a <= mid && mid < y.b));
  }
  return out;
}

/**
 * Each shot's line for the look, by its place in the cut from 1: when it plays, which footage and where in it, what that
 * stretch is described as (the library's shot description, else the AI Editor's own) and why it was picked.
 */
export function cutLines(plan: EditPlan, titles: Record<string, string>, shown: (IndexShot | undefined)[]): string[] {
  return plan.shots.map((s, k) => {
    const x = shown[k];
    const from = "generate" in s.src ? `a clip made from nothing (${s.src.generate.style})` : `${JSON.stringify(titles[s.src.source] ?? s.src.source)} at ${clock(s.src.inS)}${x ? described(x) : ""}`;
    return `${k + 1}. ${s.at.toFixed(2)}–${(s.at + s.dur).toFixed(2)} s · ${from}${s.why ? ` · picked: ${s.why}` : ""}`;
  });
}

/**
 * The look's verdict with every shot whose footage is measured as badly taken (look.ts qualityOf) failing for that, its
 * flaws the reason and its place in the cut (`shots`) with it, when the AI did not name it already.
 */
export function withFlaws(c: Critique, shown: (IndexShot | undefined)[], shots: { at: number; dur: number }[] = []): Critique {
  const fails = [...c.fails];
  shown.forEach((x, k) => {
    if (!x?.flaws?.length || fails.some((f) => f.n === k + 1)) return;
    const s = shots[k];
    fails.push({ n: k + 1, why: x.flaws.join(", "), ...(s ? { at: s.at, dur: s.dur } : {}) });
  });
  return { ...c, ok: !fails.length, fails: fails.sort((a, b) => a.n - b.n) };
}

/** ffmpeg's output, read through the server's ffmpeg limit. */
function ffmpegOut(args: string[], signal?: AbortSignal): Promise<{ out: Buffer; err: string }> {
  return ffmpegSlot(
    () =>
      new Promise((resolve, reject) => {
        const p = spawn(ffmpegCommand(), ["-nostdin", ...args], { signal });
        const out: Buffer[] = [];
        let err = "";
        p.stdout.on("data", (d: Buffer) => out.push(d));
        p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-20000)));
        p.on("error", reject);
        p.on("close", (code) => (code === 0 ? resolve({ out: Buffer.concat(out), err }) : reject(new Error(err.trim().slice(-400) || `ffmpeg exited ${code}`))));
      }),
  );
}

/** Flash frames of the rendered `file` at the cut's own cuts (one decode of a 27×48 copy). */
export async function flashFrames(file: string, cuts: number[], fps: number, signal?: AbortSignal): Promise<Found[]> {
  if (!cuts.length) return [];
  const { out } = await ffmpegOut(["-v", "error", "-i", file, "-an", "-vf", `fps=${fps},scale=${TW}:${TH}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], signal);
  const size = TW * TH * 3;
  const frames = Array.from({ length: Math.floor(out.length / size) }, (_, k) => new Uint8Array(out.buffer, out.byteOffset + k * size, size));
  return [...new Set(cuts.flatMap((c) => oddAt(frames, c)))].map((f) => ({ rec: f, why: `a frame that belongs to neither shot at ${(f / fps).toFixed(2)} s` }));
}

/** Whether the rendered `file` ends on black (its last frame is no picture). */
export async function endsOnBlack(file: string, duration: number, signal?: AbortSignal): Promise<boolean> {
  const { err } = await ffmpegOut(["-v", "info", "-sseof", `-${TAIL_S}`, "-i", file, "-an", "-vf", "blackdetect=d=0.04:pix_th=0.08", "-f", "null", "-"], signal);
  return blackAtEnd(err, duration);
}

/** Every check on the rendered `file` of cut `tl`; `words`: each take's transcript, for the word checks. */
export async function renderChecks(tl: Timeline, file: string, words: Record<string, { w: string; s: number; e: number }[]>, signal?: AbortSignal): Promise<Found[]> {
  const end = Math.max(0, ...(["V1", "V2", "A1", "A2", "A3"] as const).flatMap((t) => tl.tracks[t].items.map((i) => i.rec + i.len)));
  const flashes = await flashFrames(file, cutsOf(tl), tl.fps, signal);
  const black = (await endsOnBlack(file, end / tl.fps, signal)) ? [{ rec: Math.max(0, end - 1), why: "the video ends on black" }] : [];
  return [...flashes, ...(tl.plan ? [] : wordSlips(tl, words)), ...black].sort((a, b) => a.rec - b.rec);
}

/** One shot of a cut as the picture shows it: when it plays (seconds), which footage and where in it, and whether it is a cutaway. */
export interface PictureShot {
  at: number;
  dur: number;
  src: string;
  inS: number;
  cutaway: boolean;
}

/** The shots a cut's picture shows, in order: a cutaway (V2) over the speaker (V1) is what plays where it lies. */
export function pictureShots(tl: Timeline): PictureShot[] {
  const top = [...tl.tracks.V2.items, ...tl.tracks.V1.items];
  const edges = [...new Set(top.flatMap((i) => [i.rec, i.rec + i.len]))].sort((a, b) => a - b);
  const out: (PictureShot & { item: object })[] = [];
  for (let k = 0; k + 1 < edges.length; k++) {
    const [a, b] = [edges[k]!, edges[k + 1]!];
    const item = top.find((i) => i.rec <= a && a < i.rec + i.len);
    if (!item) continue;
    const prev = out.at(-1);
    if (prev?.item === item) {
      prev.dur = b / tl.fps - prev.at;
      continue;
    }
    const sfps = tl.sources[item.src]?.fps || tl.fps;
    out.push({ item, at: a / tl.fps, dur: (b - a) / tl.fps, src: item.src, inS: item.in / sfps + (a - item.rec) / tl.fps, cutaway: tl.tracks.V2.items.includes(item) });
  }
  return out.map(({ item: _, ...s }) => s);
}

/** Each shot's line for the look at a cut around speech: when it plays, which footage and where, and what is said under it. */
export function talkLines(shots: PictureShot[], titles: Record<string, string>, said: (at: number, dur: number) => string): string[] {
  return shots.map((s, k) => {
    const words = said(s.at, s.dur).trim().slice(0, LINE_TEXT * 2);
    return `${k + 1}. ${s.at.toFixed(2)}–${(s.at + s.dur).toFixed(2)} s · ${s.cutaway ? "cutaway" : "speaker"} · ${JSON.stringify(titles[s.src] ?? s.src)} at ${clock(s.inS)}${words ? ` · says: ${JSON.stringify(words)}` : ""}`;
  });
}

/** The words of each take a cut plays, from the library (on a computer: asked of the server). */
const spokenOf = async (tl: Timeline): Promise<Record<string, { w: string; s: number; e: number }[]>> =>
  onComputer.on
    ? ask("editorWords")
    : Object.fromEntries([...new Set([...tl.tracks.A1.items, ...tl.tracks.V1.items].map((i) => i.src))].filter((id) => !tl.sources[id]?.file).map((id) => [id, wordsOf(libraryDb(), id) ?? []]));

export const CRITIQUE_SYSTEM = `You watch a cut of a video before the person who asked for it does. You get what they asked for (the brief), their own words on earlier versions when there are any, the editing style, a line for each shot (when it plays, which footage it is and where in it, what that stretch of footage is described as, and why it was picked), and pictures of the cut: two frames of every shot, one just after it starts and one just before it ends.

Judge the whole cut against all of that at once, the way the person will when they watch it. A shot fails when it doesn't hold up in this cut: watching it, the person would want it out or changed (a stretch where nothing happens in a cut that asks for action, say, a picture you can't make out, or something already shown: the same picture, or the same action again from another stretch). Name only the shots that fail, by number, each with one short reason in plain words, under ten words, about what is seen ("walking through town, nothing happens"). When every shot holds up, name none.

${RULE}

Answer with JSON only: {"ok": true, "fails": []}, or {"ok": false, "fails": [{"n": 7, "why": "walking through town, nothing happens"}]}`;

export interface CritiqueInput {
  brief: string;
  /** the workspace the edit is for: its instructions and what each context file is (plan.ts workspaceSetup); none adds nothing */
  workspace?: string;
  /** the person's notes on the edit, oldest first (EditMeta.feedback) */
  notes: EditFeedback[];
  /** the editing style's block (styles.ts styleBlock) */
  style: string;
  /** one line a shot (cutLines) */
  shots: string[];
  sheets: number;
  seconds: number;
  song: boolean;
}

export function critiquePrompt(i: CritiqueInput): { system: string; user: string } {
  const parts = [`Brief:\n${i.brief.trim() || "(none: a good edit of this footage)"}`];
  if (i.workspace?.trim()) parts.push(`The workspace's setup:\n${i.workspace.trim()}`);
  if (i.notes.length) parts.push(`The person's own words on earlier versions, word for word, oldest first (the newest says what they want now):\n${noteLines(i.notes).join("\n")}`);
  if (i.style.trim()) parts.push(i.style.trim());
  parts.push(`The cut: ${i.seconds.toFixed(1)} s, ${i.shots.length} shots, ${i.song ? "cut to a song" : "with the footage's own sound"}. Its shots, by number:\n${i.shots.join("\n")}`);
  const sheets = Array.from({ length: i.sheets }, (_, k) => {
    const [a, b] = [k * PER_SHEET + 1, Math.min(i.shots.length, (k + 1) * PER_SHEET)];
    return `picture ${k + 1} holds ${a === b ? `shot ${a}` : `shots ${a}–${b}`}`;
  });
  parts.push(`The pictures, in order: ${sheets.join(", ")}. Each row is two shots, each shot two tiles side by side: just after it starts, then just before it ends.`);
  return { system: CRITIQUE_SYSTEM, user: parts.join("\n\n") };
}

/**
 * The AI's answer as a Critique: shots that exist, each named once with a reason, in order; it passes when none is named.
 * `shots`: the cut's shots in order (each named one keeps its place, `at` and `dur`), or only how many there are.
 */
export function parseCritique(text: string, shots: number | { at: number; dur: number }[], round: number): Critique {
  const count = typeof shots === "number" ? shots : shots.length;
  const o = parseJsonObject(text);
  const fails: Critique["fails"] = [];
  for (const f of Array.isArray(o.fails) ? (o.fails as Record<string, unknown>[]) : []) {
    const n = Math.round(Number(f?.n));
    const why = typeof f?.why === "string" ? f.why.replace(/\s+/g, " ").trim().slice(0, WHY_MAX) : "";
    if (!(n >= 1 && n <= count && why && !fails.some((x) => x.n === n))) continue;
    const s = typeof shots === "number" ? undefined : shots[n - 1];
    fails.push(s ? { n, why, at: s.at, dur: s.dur } : { n, why });
  }
  return { ok: !fails.length, fails: fails.sort((a, b) => a.n - b.n), round };
}

/** A cut as the look reads it: its shots in order (seconds), a line for each, and what its shots show when known. */
interface LookCut {
  fps: number;
  landscape: boolean;
  shots: { at: number; dur: number }[];
  lines: string[];
  song: boolean;
  shown?: (IndexShot | undefined)[];
}

/** A planned cut as the look reads it. */
async function plannedCut(plan: EditPlan, d: DraftFile): Promise<LookCut> {
  const titles = Object.fromEntries(Object.entries(d.timeline.sources).map(([id, s]) => [id, s.name]));
  const shown = await shownStretches(plan);
  return { fps: plan.fps, landscape: plan.w >= plan.h, shots: plan.shots, lines: cutLines(plan, titles, shown), song: plan.lead.type === "song", shown };
}

/** A cut around speech as the look reads it: the shots its picture shows, with what is said under each. */
function talkingCut(tl: Timeline, words: Record<string, { w: string; s: number; e: number }[]>): LookCut {
  const titles = Object.fromEntries(Object.entries(tl.sources).map(([id, s]) => [id, s.name]));
  const shots = pictureShots(tl);
  const said = saidUnder(tl, words);
  return { fps: tl.fps, landscape: tl.width >= tl.height, shots, lines: talkLines(shots, titles, (at, dur) => said(Math.round(at * tl.fps), Math.round(dur * tl.fps))), song: false };
}

/** The look at one version's rendered cut. */
async function look(edit: EditMeta, actor: string, variant: string, cut: LookCut, round: number, signal: AbortSignal): Promise<Critique> {
  const who = whoFor(actor);
  const route = aiFor(who, "editor", LABEL);
  if (route.off) throw new NeedsKey(route.off);
  const dir = path.join(editDir(edit.id), "previews", `${variant}.sheets`);
  try {
    const sheets = await cutSheets(previewFile(edit.id, variant), shotFrames(cut), cut.landscape, dir);
    const images = await Promise.all(sheets.map(async (f) => ({ jpegBase64: (await readFile(f)).toString("base64") })));
    const { system, user } = critiquePrompt({
      brief: edit.brief,
      workspace: await workspaceSetup(edit, 6000),
      notes: edit.feedback ?? [],
      style: await styleBlock(edit.style, edit),
      shots: cut.lines,
      sheets: sheets.length,
      seconds: cut.shots.reduce((t, s) => Math.max(t, s.at + s.dur), 0),
      song: cut.song,
    });
    const c = (await completeVisionWithFallback(system, user, images, signal, (t) => parseCritique(t, cut.shots, round), who, { label: LABEL, job: "editor" })).value;
    return cut.shown ? withFlaws(c, cut.shown, cut.shots) : c;
  } catch (e) {
    const away = macAway(e);
    if (away) throw new NeedsKey(away.message);
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The critique step (one version), after its preview: a cut the AI made (DraftFile.due), planned or around speech, is
 * looked at and checked (checks.ts) and filed in Review here, with any failing shots named on it; any other cut (one the
 * person saved) is filed as it is. A look that can't be made files
 * the cut it has, and says so on it.
 */
export async function critiqueStep({ edit, job, variant, signal }: StepContext): Promise<void> {
  const d = readDraft(edit.id, variant);
  if (!d || !existsSync(previewFile(edit.id, variant))) throw new Error(`Make ${variant || "the"} preview first`);
  const { due, ...looked } = d;
  // `skipped`: the look or the fix that could not be made, said on the Review version and kept with the draft
  const file = async (c: Critique | undefined, skipped?: string) => {
    const kept = { ...looked, ...(c ? { critique: c } : {}), ...(skipped ? { unchecked: skipped } : {}) };
    await markDraft(edit.id, variant, kept);
    await fileInReview(edit, variant, d.timeline, saidOf(kept), job.actor);
    enqueueJob(libraryDb(), edit.workspaceId, `${edit.id}:${variant}`, "file", job.actor, true, "edit_jobs");
  };
  // Why a look or a fix can't be made, in the person's words, or null while it is to be tried again. A rendered cut
  // never waits on its check: the plan's limit (days, on a weekly one), an AI that isn't connected and footage still
  // being read say so at once, any other failure after its last try. The worker is read when it's needed, as it
  // registers this step
  const cant = async (e: unknown): Promise<string | null> => {
    if (signal.aborted) return null;
    const limit = (await import("./worker")).limitWait(e);
    if (!limit && !(e instanceof NeedsKey) && !(e instanceof Waiting) && job.attempts < MAX_ATTEMPTS) return null;
    const why = limit ? (isLimitLine(limit.line) ? limit.line : "The AI's usage limit is reached") : e instanceof Waiting ? (e.line ?? "The footage is still being read") : e instanceof Error ? e.message : String(e);
    return why.replace(/\s+/g, " ").trim().replace(/\.$/, "").slice(0, CANT_MAX);
  };
  if (!due) return file(d.critique);
  // a planned cut is read as its plan; any other cut the AI made (around speech) as the shots its picture shows
  const saved = readStep(edit.id, "shots")?.[variant];
  // words for the checks: none when they can't be read (a server too old to give them a computer)
  const words = saved ? {} : await spokenOf(d.timeline).catch(() => ({}));
  let cut: LookCut;
  try {
    cut = saved ? await plannedCut(saved.plan, d) : talkingCut(d.timeline, words);
  } catch (e) {
    const why = await cant(e);
    if (why) return file(d.critique, `Not checked before Review: ${why}`);
    throw e;
  }
  // the checks on the render itself: named on the cut, never a reason to hold it (a check that fails to run is skipped)
  const found = await renderChecks(d.timeline, previewFile(edit.id, variant), words, signal).catch((e: Error) => {
    if (!signal.aborted) console.warn("[editor] render checks:", e.message);
    return [];
  });
  if (signal.aborted) return;
  const checked = (c: Critique | undefined) => (found.length ? withFound(c ?? { ok: true, fails: [], round: 1 }, found, cut.shots, cut.fps) : c);
  // looked at already by a try that stopped after it: not asked again
  let c = d.critique;
  if (!c) {
    try {
      c = await look(edit, job.actor!, variant, cut, 1, signal);
    } catch (e) {
      const why = await cant(e);
      if (why) return file(checked(undefined), `Not checked before Review: ${why}`);
      throw e;
    }
    if (signal.aborted) return;
    await markDraft(edit.id, variant, { ...d, critique: c });
  }
  return file(checked(c));
}
