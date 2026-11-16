import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Critique, EditPlan, IndexShot } from "../../contracts/edit-plan";
import type { EditFeedback } from "../../contracts/editor";
import { isLimitLine } from "../../contracts/plans";
import { aiFor } from "../ai-complete";
import { completeVisionWithFallback } from "../ai-vision";
import { parseJsonObject } from "../lib/instagram/vision";
import { libraryDb } from "../library/db";
import { whoFor } from "../library/describe";
import { enqueueJob, MAX_ATTEMPTS } from "../library/jobs";
import { clock, COLS, ROWS, RULE } from "../library/look";
import { ffmpeg } from "../library/media/run";
import { NeedsKey } from "../library/transcribe";
import { Waiting } from "./analyze";
import type { StepContext } from "./engine";
import { knownShots } from "./index";
import { fixPlan, noteLines, sourceSpan, workspaceSetup } from "./plan";
import { fileInReview, previewFile, saidOf } from "./preview";
import { macAway } from "./script";
import { editDir, markDraft, readDraft, readStep, saveStep, type DraftFile, type EditMeta } from "./store";
import { styleBlock } from "./styles";

/**
 * The look at a planned cut before the person sees it (tasks/flywheel/PLAN.md stage 4). Two frames of every shot, from
 * the rendered preview, on numbered sheets go to the person's own AI with the brief, their notes word for word, the
 * editing style and each shot's line, for one judgement of the whole cut: the shots that don't hold up, and why. When
 * some don't, the one fix round (plan.ts fixPlan) replaces those shots, and the new cut is drafted, post-processed,
 * rendered and looked at once more. The person then gets one version in Review: the fixed one when it has fewer failing
 * shots, else the first, with the shots still failing named on it. A cut is never held back (PLAN.md D7): a look or a
 * fix that can't be made (the plan's usage limit, no AI connected, footage still being read, or a failure after its
 * last try) files the cut as it is, at once, with one line on its Review version saying it was not looked at, or not
 * fixed, and why.
 */

const LABEL = "AI Editor check";
/** Shots on one sheet: two tiles each */
const PER_SHEET = (COLS * ROWS) / 2;
/** A failing shot's reason, in characters */
const WHY_MAX = 120;
/** What a shot's footage is described as, in characters (as the plan reads it) */
const LINE_TEXT = 100;
/** Why a look or a fix could not be made, in characters */
const CANT_MAX = 200;

/** Two frames of each shot of the cut (frame numbers): a little after it starts and a little before it ends, always increasing. */
export function shotFrames(plan: Pick<EditPlan, "fps" | "shots">): number[] {
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

/** The shot description a stretch of footage has, as a line's tail: ` · a4 clear · fight, boss · what happens`. */
export const described = (x: Pick<IndexShot, "desc" | "action" | "clear" | "tags">): string => {
  const text = (x.desc ?? "").replace(/\s+/g, " ").trim().slice(0, LINE_TEXT);
  return `${x.action !== undefined ? ` · a${x.action}${x.clear ? " clear" : ""}` : ""}${x.tags?.length ? ` · ${x.tags.join(", ")}` : ""}${text ? ` · ${text}` : ""}`;
};

/**
 * Each shot's line for the look, by its place in the cut from 1: when it plays, which footage and where in it, what that
 * stretch is described as (the library's shot description, else the AI Editor's own) and why it was picked.
 */
export async function cutLines(plan: EditPlan, titles: Record<string, string>): Promise<string[]> {
  const known = new Map<string, IndexShot[]>();
  const out: string[] = [];
  for (const [k, s] of plan.shots.entries()) {
    let from: string;
    if ("generate" in s.src) from = `a clip made from nothing (${s.src.generate.style})`;
    else {
      const id = s.src.source;
      if (!known.has(id)) known.set(id, await knownShots(id));
      const mid = s.src.inS + sourceSpan(s.dur, s.speed, s.ramp) / 2;
      const x = known.get(id)!.find((y) => y.a <= mid && mid < y.b);
      from = `${JSON.stringify(titles[id] ?? id)} at ${clock(s.src.inS)}${x ? described(x) : ""}`;
    }
    out.push(`${k + 1}. ${s.at.toFixed(2)}–${(s.at + s.dur).toFixed(2)} s · ${from}${s.why ? ` · picked: ${s.why}` : ""}`);
  }
  return out;
}

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

/** The AI's answer as a Critique: shots that exist, each named once with a reason, in order; it passes when none is named. */
export function parseCritique(text: string, shots: number, round: number): Critique {
  const o = parseJsonObject(text);
  const fails: Critique["fails"] = [];
  for (const f of Array.isArray(o.fails) ? (o.fails as Record<string, unknown>[]) : []) {
    const n = Math.round(Number(f?.n));
    const why = typeof f?.why === "string" ? f.why.replace(/\s+/g, " ").trim().slice(0, WHY_MAX) : "";
    if (n >= 1 && n <= shots && why && !fails.some((x) => x.n === n)) fails.push({ n, why });
  }
  return { ok: !fails.length, fails: fails.sort((a, b) => a.n - b.n), round };
}

/** The look at one version's rendered cut. */
async function look(edit: EditMeta, actor: string, variant: string, plan: EditPlan, d: DraftFile, round: number, signal: AbortSignal): Promise<Critique> {
  const who = whoFor(actor);
  const route = aiFor(who, "editor", LABEL);
  if (route.off) throw new NeedsKey(route.off);
  const dir = path.join(editDir(edit.id), "previews", `${variant}.sheets`);
  try {
    const sheets = await cutSheets(previewFile(edit.id, variant), shotFrames(plan), plan.w >= plan.h, dir);
    const images = await Promise.all(sheets.map(async (f) => ({ jpegBase64: (await readFile(f)).toString("base64") })));
    const titles = Object.fromEntries(Object.entries(d.timeline.sources).map(([id, s]) => [id, s.name]));
    const { system, user } = critiquePrompt({
      brief: edit.brief,
      workspace: await workspaceSetup(edit, 6000),
      notes: edit.feedback ?? [],
      style: await styleBlock(edit.style, edit),
      shots: await cutLines(plan, titles),
      sheets: sheets.length,
      seconds: plan.shots.reduce((t, s) => Math.max(t, s.at + s.dur), 0),
      song: plan.lead.type === "song",
    });
    return (await completeVisionWithFallback(system, user, images, signal, (t) => parseCritique(t, plan.shots.length, round), who, { label: LABEL, job: "editor" })).value;
  } catch (e) {
    const away = macAway(e);
    if (away) throw new NeedsKey(away.message);
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The critique step (one planned version), after its preview: a cut the AI made (DraftFile.due) is looked at, round 1
 * or the fix's round 2, and filed in Review here; any other cut is filed as it is. Round 1 passing files the cut. Round 1
 * failing writes the fix round's plan and queues its draft. Round 2 files the fixed cut when it has fewer failing shots,
 * else puts the first plan back with its look and queues its draft again, filed then by the preview (the copies its
 * post-processing made went with the fix's). A look or a fix that can't be made files the cut it has, and says so on it.
 */
export async function critiqueStep({ edit, job, variant, signal }: StepContext): Promise<void> {
  const d = readDraft(edit.id, variant);
  if (!d || !existsSync(previewFile(edit.id, variant))) throw new Error(`Render ${variant || "the"} preview first`);
  const then = (kind: "file" | "draft") => enqueueJob(libraryDb(), edit.workspaceId, `${edit.id}:${variant}`, kind, job.actor, true, "edit_jobs");
  const { due, ...looked } = d;
  // `skipped`: the look or the fix that could not be made, said on the Review version and kept with the draft
  const file = async (c: Critique | undefined, skipped?: string) => {
    const kept = { ...looked, ...(c ? { critique: c } : {}), ...(skipped ? { unchecked: skipped } : {}) };
    await markDraft(edit.id, variant, kept);
    await fileInReview(edit, variant, d.timeline, saidOf(kept), job.actor);
    then("file");
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
  const shots = readStep(edit.id, "shots");
  const saved = shots?.[variant];
  if (!due || !saved) return file(d.critique);
  const round = due === 2 && saved.fix ? 2 : 1;
  // looked at already by a try that stopped after it (the fix failed or waited): not asked again
  let c = d.critique?.round === round ? d.critique : undefined;
  if (!c) {
    try {
      c = await look(edit, job.actor!, variant, saved.plan, d, round, signal);
    } catch (e) {
      const why = await cant(e);
      if (why) return file(undefined, `Not checked before Review: ${why}`);
      throw e;
    }
    if (signal.aborted) return;
    await markDraft(edit.id, variant, { ...d, critique: c });
  }
  if (round === 2) {
    const first = saved.fix!.first;
    if (c.fails.length < first.fails.length) return file(c);
    await saveStep(edit.id, "shots", { ...shots, [variant]: { ...saved.fix!.was, critique: first } });
    return void then("draft");
  }
  if (c.ok) return file(c);
  let fixed: Awaited<ReturnType<typeof fixPlan>> = null;
  try {
    fixed = await fixPlan(edit, job.actor!, variant, saved.plan, c.fails, signal);
  } catch (e) {
    const why = await cant(e);
    if (!why) throw e;
    // looked at, and its failing shots are named: the fix is what was skipped
    return file(c, `Not fixed before Review: ${why}`);
  }
  if (signal.aborted) return;
  if (!fixed) return file(c);
  await saveStep(edit.id, "shots", { ...shots, [variant]: { plan: fixed.plan, notes: [...saved.notes, ...fixed.notes], fix: { first: c, was: { plan: saved.plan, notes: saved.notes } } } });
  then("draft");
}
