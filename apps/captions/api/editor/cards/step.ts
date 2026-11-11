import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CARDS_DRAW_KIND } from "../../../contracts/devices";
import type { Timeline } from "../../../contracts/editor";
import type { AnimationStyle } from "../../../contracts/editor-styles";
import { aiFor, completeWithFallback } from "../../ai-complete";
import { completeVisionWithFallback, type VisionImage } from "../../ai-vision";
import { isOnline, listDevices } from "../../lib/devices";
import { packInstructions } from "../../lib/packs";
import { libraryDb } from "../../library/db";
import { whoFor } from "../../library/describe";
import { enqueueJob } from "../../library/jobs";
import { probe } from "../../library/media/probe";
import { ffmpeg } from "../../library/media/run";
import { Waiting } from "../analyze";
import { findAnimation, fitJpeg, pictureFile } from "../animation-styles";
import type { StepContext } from "../engine";
import { previewSize } from "../preview";
import { readDraft, readStep, saveDraft } from "../store";
import { sourceOf } from "../timeline";
import { cardWindow, placeCards, type CardClip } from "./place";
import { lookPrompt, makePrompt, parseLook, parsePlan, parseScript, planPrompt, type FrameInput, type PlanLine } from "./prompts";
import { cardFile, cardsDir, cardsFolder, clearCards, MAX_CALLS, MAX_DRAWS, readCards, saveCards, scriptFile, STILLS, type CardsState, type PlannedCard } from "./state";

/**
 * The AI Editor's card step, for one version of an edit whose style names an animation style (engine.ts queues it
 * after the B-roll for such an edit and for no other). The person's AI plans a few cards from the lines (one text
 * call), writes one script that paints them from the style's brief and pictures (one call), a Mac of theirs draws
 * them (a `cards-draw` step, contracts/devices.ts), the AI looks at the stills once and may correct the script, which
 * is then drawn once more, and code lays the clips on the cut (place.ts).
 *
 * The script is an AI's output. This file keeps it as text and hands it to the Mac; nothing here runs it.
 *
 * Cards never hold an edit up. No Mac on, a draw that failed for good or that nobody took, an AI that could not answer: the
 * version gets a note and goes on to its preview without them. What was made is kept, so a version cut again places
 * its cards with no AI call.
 */

/** A draw nobody has taken after this long is taken back. */
export const UNTAKEN_MS = 10 * 60_000;
/** A draw not finished after this long is taken back, whoever holds it. */
export const DRAW_MS = 20 * 60_000;
/** While a draw is out the step looks again this often. */
const WAKE_S = 10;
/** Pictures of the style a make call carries at most, and a look call (beside its sheet). */
export const MAKE_PICTURES = 8;
export const LOOK_PICTURES = 4;
/** The sheet of stills the look call gets: a JPEG no longer than this on its long side, no bigger than this. */
export const SHEET_MAX_SIDE = 2048;
export const SHEET_MAX_BYTES = 600_000;
/** Cards are drawn at the preview's size, and at the cut's frame rate up to this. */
const MAX_FPS = 60;
const LABEL = "AI Editor cards";
const NO_MAC = "no Mac with Creator Toolset is on";

/** The time, for the two limits above. A test moves it. */
export const clock = { now: () => Date.now() };

const draw = (db: DatabaseSync, vid: string) =>
  db.prepare("SELECT state, error FROM edit_jobs WHERE version_id = ? AND kind = ?").get(vid, CARDS_DRAW_KIND) as { state: string; error: string | null } | undefined;
/** Takes a draw back: its row goes, so no Mac can claim it or send for it, and the edit page offers no Retry for it. */
export const withdraw = (db: DatabaseSync, vid: string) => void db.prepare("DELETE FROM edit_jobs WHERE version_id = ? AND kind = ?").run(vid, CARDS_DRAW_KIND);

/** A Mac of the account that draws cards (it said so when it last asked for work) and is on. */
const macOn = (actor: string) => listDevices((d) => d.owner === actor && !!d.kinds?.includes(CARDS_DRAW_KIND) && isOnline(d.id)).length > 0;

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 200);
/** Why a draw ended without `done`, in words for the person: the Mac's own sentence, or what the queue recorded. */
const drawFailure = (error: string | null | undefined) =>
  !error ? "the draw failed" : error === "Stopped" ? "the draw was stopped" : /^(device went quiet|lease expired)$/.test(error) ? "your Mac went quiet while it drew" : error;

/**
 * One answer from the person's AI, and nothing but an answer: the route is the editor's own (aiFor), with no tool, no
 * web and no session asked for. With pictures they are the whole of what the call carries besides its text.
 */
export async function answer<T>(actor: string, prompt: { system: string; user: string }, images: VisionImage[], parse: (text: string) => T, signal?: AbortSignal): Promise<T> {
  const who = whoFor(actor);
  if (images.length) return (await completeVisionWithFallback(prompt.system, prompt.user, images, signal, parse, who, { label: LABEL, job: "editor" })).value;
  const route = aiFor(who, "editor", LABEL);
  if (route.off) throw new Error(route.off);
  // one request for one call: an answer that cannot be read is not asked for again
  return completeWithFallback(prompt.system, prompt.user, signal, parse, { ...route, retries: 0 });
}

/** The style's pictures a call carries: the liked stills first, newest first, then the inspirations, `max` in all. */
export async function stylePictures(actor: string, style: AnimationStyle, max: number): Promise<{ images: VisionImage[]; made: number; inspirations: number }> {
  const newest = (kind: "made" | "inspiration") => style.pictures.filter((p) => p.kind === kind).sort((a, b) => b.at - a.at);
  const out = { images: [] as VisionImage[], made: 0, inspirations: 0 };
  for (const p of [...newest("made"), ...newest("inspiration")]) {
    if (out.images.length >= max) break;
    const bytes = await readFile(pictureFile(actor, style.id, p.id) ?? "").catch(() => null);
    if (!bytes) continue;
    out.images.push({ jpegBase64: bytes.toString("base64") });
    if (p.kind === "made") out.made++;
    else out.inspirations++;
  }
  return out;
}

/** The version's lines as spoken, numbered from 1, with whether a card fits over each on this cut. */
function linesOf(editId: string, variant: string, tl: Timeline): (PlanLine & { id: string; first: number; last: number })[] {
  const sentences = readStep(editId, "analysis")?.sentences ?? [];
  const lines = readStep(editId, "plan")?.plans.find((p) => p.name === variant)?.lines ?? [];
  return lines.map((l, k) => ({
    n: k + 1,
    text: sentences.filter((s) => s.n >= l.take.first && s.n <= l.take.last).map((s) => s.text).join(" ").slice(0, 600),
    ok: !!cardWindow(tl, l.line),
    id: l.line,
    first: l.take.first,
    last: l.take.last,
  }));
}

/** One sheet of the cards' stills for the look call: a card in each column when the picture is tall, else in each row. */
export async function lookSheet(editId: string, variant: string, ids: string[], width: number, height: number): Promise<{ image: VisionImage; columns: boolean }> {
  const dir = path.join(cardsDir(editId, variant), "sheet");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  try {
    const columns = height > width;
    // in the order the tile filter lays them, row by row
    const order = columns ? STILLS.flatMap((s) => ids.map((id) => [id, s] as const)) : ids.flatMap((id) => STILLS.map((s) => [id, s] as const));
    for (const [n, [id, s]] of order.entries()) await symlink(cardFile(editId, variant, id, s)!, path.join(dir, `${String(n + 1).padStart(3, "0")}.png`));
    const h = Math.round((height * 540) / width / 2) * 2;
    await ffmpeg(["-framerate", "1", "-i", path.join(dir, "%03d.png"), "-vf", `scale=540:${h},tile=${columns ? ids.length : 3}x${columns ? 3 : ids.length}`, "-frames:v", "1", path.join(dir, "sheet.png")]);
    await fitJpeg(path.join(dir, "sheet.png"), path.join(dir, "sheet.jpg"), SHEET_MAX_SIDE, SHEET_MAX_BYTES);
    return { image: { jpegBase64: (await readFile(path.join(dir, "sheet.jpg"))).toString("base64") }, columns };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Takes up what the Mac sent of the draw that is out: a card with its clip and all three stills replaces what was there. */
async function takeDraw(editId: string, variant: string, cards: PlannedCard[]): Promise<void> {
  for (const c of cards) {
    const names = [undefined, ...STILLS];
    if (!names.every((s) => existsSync(cardFile(editId, variant, c.id, s, true)!))) continue;
    for (const s of names) await rename(cardFile(editId, variant, c.id, s, true)!, cardFile(editId, variant, c.id, s)!);
  }
  await rm(path.join(cardsDir(editId, variant), "draw"), { recursive: true, force: true });
}

/** Plans, makes, draws and looks, as far as it can get now. Throws Waiting while a draw is out. */
async function make({ edit, job, variant, signal }: StepContext, tl: Timeline, from: CardsState): Promise<CardsState> {
  let st = from;
  const actor = job.actor!;
  const db = libraryDb();
  const vid = `${edit.id}:${variant}`;
  const save = async (next: CardsState) => (await saveCards(edit.id, variant, (st = next)), next);
  /** No more to make. With `why` the version gets that note. Once a call was made the cards are settled; before that, the next cut tries again. */
  const end = (why?: string) => {
    withdraw(db, vid);
    return save({ ...st, askedAt: undefined, note: why, done: st.calls > 0 });
  };
  /** An AI call may be made: at most MAX_CALLS for a version, counted before the call. */
  const spend = async () => st.calls < MAX_CALLS && !!(await save({ ...st, calls: st.calls + 1 }));
  /** Asks a Mac to draw the script: a `cards-draw` step, tried again by the queue as any device step is (three attempts in all). */
  const ask = async (script: string) => {
    await mkdir(cardsDir(edit.id, variant), { recursive: true });
    await writeFile(scriptFile(edit.id, variant), script);
    await rm(path.join(cardsDir(edit.id, variant), "draw"), { recursive: true, force: true });
    withdraw(db, vid);
    enqueueJob(db, edit.workspaceId, vid, CARDS_DRAW_KIND, actor, true, "edit_jobs");
    await save({ ...st, draws: st.draws + 1, askedAt: clock.now() });
    return new Waiting(WAKE_S);
  };

  // looked for every time the step wakes, and before any AI call
  const on = macOn(actor);
  if (st.askedAt) {
    const row = draw(db, vid);
    const waited = clock.now() - st.askedAt;
    const out = row?.state === "queued" || row?.state === "running";
    const untaken = row?.state === "queued" && waited > UNTAKEN_MS;
    if (out && on && !untaken && waited <= DRAW_MS) throw new Waiting(WAKE_S);
    const whole = row?.state === "done";
    // a first draw that did not finish keeps the cards that did arrive; a second one leaves the first draw's in place
    if (whole || st.draws === 1) await takeDraw(edit.id, variant, st.cards ?? []);
    const drawn = (st.cards ?? []).filter((c) => existsSync(cardFile(edit.id, variant, c.id)!)).map((c) => c.id);
    withdraw(db, vid);
    await save({ ...st, askedAt: undefined, drawn });
    // the Mac's own words when it said why; else what the wait ran into
    const why = row?.error ? drawFailure(row.error) : !on ? NO_MAC : untaken ? "your Mac did not take the draw in 10 minutes" : out ? "the draw took over 20 minutes" : "the draw failed";
    if (!whole) return end(st.draws > 1 ? `the corrected cards were not drawn (${why})` : why);
    if (!drawn.length) return end("your Mac sent no card");
  }
  if (!on) return end(NO_MAC);
  const style = findAnimation(actor, st.style);
  if (!style) return end("its animation style is gone");
  // only a style the person made reaches an AI call (contracts/editor-styles.ts `from`)
  if (style.from) return end("a style from Community makes no cards yet");

  try {
    if (!st.cards) {
      const lines = linesOf(edit.id, variant, tl);
      if (!lines.some((l) => l.ok)) return end("no line of this cut has room for one");
      if (!(await spend())) return end();
      const picked = await answer(actor, planPrompt({ lines, brief: style.brief, packText: await packInstructions(actor, "editor.cards", null) }), [], (t) => parsePlan(t, lines), signal);
      const { w, h } = previewSize(tl);
      const cards = picked.map((p, k) => {
        const l = lines[p.line - 1]!;
        return { id: `c${k + 1}`, text: p.text, first: l.first, last: l.last, line: l.text, seconds: Math.round((cardWindow(tl, l.id)!.len / tl.fps) * 1000) / 1000 };
      });
      await save({ ...st, cards, width: w, height: h, fps: Math.min(tl.fps, MAX_FPS) });
      if (!cards.length) return end("the AI found no line that needs one");
    }
    const frame: FrameInput = { brief: style.brief, width: st.width!, height: st.height!, fps: st.fps!, cards: st.cards! };
    if (st.draws === 0) {
      if (!(await spend())) return end();
      const pictures = await stylePictures(actor, style, MAKE_PICTURES);
      throw await ask(await answer(actor, makePrompt({ ...frame, made: pictures.made, inspirations: pictures.inspirations }), pictures.images, parseScript, signal));
    }
    if (!st.looked && st.draws < MAX_DRAWS && (await spend())) {
      await save({ ...st, looked: true });
      const shown = frame.cards.filter((c) => st.drawn.includes(c.id));
      const sheet = await lookSheet(edit.id, variant, shown.map((c) => c.id), frame.width, frame.height);
      const pictures = await stylePictures(actor, style, LOOK_PICTURES);
      const script = await readFile(scriptFile(edit.id, variant), "utf8");
      const fixed = await answer(actor, lookPrompt({ ...frame, cards: shown, script, columns: sheet.columns, pictures: pictures.images.length }), [sheet.image, ...pictures.images], parseLook, signal);
      if (fixed && fixed !== script) throw await ask(fixed);
    }
  } catch (e) {
    if (e instanceof Waiting || signal.aborted) throw e;
    return end(reason(e));
  }
  return end();
}

/** Lays the version's cards on its draft as it is now. Nothing to lay and nothing to take off: the draft is not touched. */
async function place(editId: string, variant: string, st: CardsState): Promise<void> {
  const draft = readDraft(editId, variant)!;
  const lines = readStep(editId, "plan")?.plans.find((p) => p.name === variant)?.lines ?? [];
  const clips: CardClip[] = [];
  const left: string[] = [];
  for (const c of (st.cards ?? []).filter((x) => st.drawn.includes(x.id))) {
    const p = await probe(cardFile(editId, variant, c.id)!).catch(() => null);
    if (!p?.width || !p.duration) {
      left.push(`the clip of “${c.text}” could not be read`);
      continue;
    }
    const key = `card-${c.id}`;
    const line = lines.find((l) => l.take.first === c.first && l.take.last === c.last)?.line ?? null;
    clips.push({ key, text: c.text, line, source: { ...sourceOf(key, `Card ${c.id.slice(1)}`, p), file: `${cardsFolder(variant)}/${c.id}.mp4` } });
  }
  const had = Object.values(draft.timeline.sources).some((s) => s.file);
  if (clips.length || had) {
    const laid = placeCards(draft.timeline, clips);
    left.push(...laid.notes);
    await saveDraft(editId, variant, { ...draft, timeline: laid.timeline });
  }
  if (left.join("\n") !== (st.left ?? []).join("\n")) await saveCards(editId, variant, { ...st, left });
}

export async function cardsStep(ctx: StepContext): Promise<void> {
  const { edit, variant, signal } = ctx;
  const styleId = edit.style?.animation;
  if (!variant || !styleId) return; // only a version of an edit whose style names an animation style
  const draft = readDraft(edit.id, variant);
  if (!draft) throw new Error(`No draft ${variant} to put cards on`);
  try {
    let st = readCards(edit.id, variant);
    // the edit was given another style since: its cards are that style's no more
    if (st && st.style !== styleId) await clearCards(edit.id, variant);
    if (!st || st.style !== styleId) st = { style: styleId, calls: 0, draws: 0, drawn: [], liked: [] };
    if (!st.done) st = await make(ctx, draft.timeline, st);
    if (!signal.aborted) await place(edit.id, variant, st);
  } catch (e) {
    if (e instanceof Waiting || signal.aborted) throw e;
    // whatever went wrong, the version goes on to its preview: cards never hold an edit up
    console.error("[editor] cards:", e);
    const st = readCards(edit.id, variant) ?? { style: styleId, calls: 0, draws: 0, drawn: [], liked: [] };
    withdraw(libraryDb(), `${edit.id}:${variant}`);
    await saveCards(edit.id, variant, { ...st, askedAt: undefined, note: reason(e), done: st.calls > 0 }).catch(() => {});
  }
}
