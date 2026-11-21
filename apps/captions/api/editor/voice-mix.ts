import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EditVoice, Item, Timeline } from "../../contracts/editor";
import { sessionOf } from "../auth";
import { enhanceFile, enhanceResult, usableEngines } from "../enhance";
import { NeedsKey } from "../library/transcribe";
import { attachStems, type StemSet } from "../review";
import { findUser } from "../users";
import type { StemClip, StemsInput } from "../work/tasks/enhance";
import { dropTask, startTask, taskFor, taskWaitLine } from "../work/tasks";
import { Waiting } from "./analyze";
import { asksMusic, cutEnd, laySound } from "./bed";
import type { StepContext } from "./engine";
import { localFiles } from "./preview";
import { editDir, readDraft, readEdit, readStep, saveDraft, saveStep, type EditMeta } from "./store";

/**
 * The sound step (one version, on the server, after post-processing): the cut's music bed and sound effects (bed.ts), then
 * its voice. Nothing is done to a voice until the person picks an enhancer (EditVoice); each recording of the cut then goes
 * through the Audio Enhancer as a session of its own (api/enhance.ts: NVIDIA, ElevenLabs, or a plug-in's engine such as
 * Adobe Enhance Speech on the person's own sign-in), made once per recording and enhancer and kept for every later cut.
 *
 * Once every recording of the cut has an enhanced voice, its sound is made in parts (stems) for Review's voice controls,
 * by a computer task (work/tasks/enhance.ts STEMS_TASK: it decodes, so it runs where the person's computers or the
 * server's video work allow): per recording its voice as recorded and through each enhancer made, all at the Enhancer's
 * one loudness, and the rest (music, sound effects), with their mix. The preview then plays that mix (preview.ts), so
 * Review's controls start from exactly what the cut sounds like, and "Off" is the recording as it is.
 */

/** Notes this file writes start with this, so a rerun replaces them. */
export const VOICE_NOTE = "Voice: ";
/** work/tasks/enhance.ts STEMS_TASK (a task module is imported only by work/task-kinds.ts). */
const STEMS_TASK = "editor-stems";
/** How long a picked voice is waited for before the cut goes on without it. */
const VOICE_WAIT_MS = 6 * 3600_000;

const NAMES: Record<string, string> = { nvidia: "NVIDIA", elevenlabs: "ElevenLabs", adobespeech: "Adobe Enhance Speech" };
export const fxName = (fx: string) => NAMES[fx] ?? fx;

/** A voice group's key in the stem file names (review.ts STEM_FILE). */
export const stemKey = (src: string) => createHash("sha1").update(src).digest("hex").slice(0, 8);

/** The recordings the cut's voice track plays (none when it is muted, or on a planned cut: its own render mixes its sound), in the order they first play. */
export function voiceGroups(tl: Timeline): string[] {
  if (tl.tracks.A1.mute || tl.plan) return [];
  const on = tl.tracks.A1.items.filter((i) => i.enabled !== false && !tl.sources[i.src]?.file).sort((a, b) => a.rec - b.rec);
  return [...new Set(on.map((i) => i.src))];
}

/** The enhancer a recording plays: its own pick, else the edit's; "off" while the edit has none. */
export const pickOf = (voice: EditVoice | undefined, src: string): string => (!voice || voice.fx === "off" ? "off" : (voice.per?.[src] ?? voice.fx));
/** A recording's share of its enhanced voice: 0 while it plays as recorded. */
export const shareOf = (voice: EditVoice | undefined, src: string): number => (pickOf(voice, src) === "off" ? 0 : (voice?.mix?.[src] ?? 1));

/** The parts each voice group plays in a stem set: as recorded, then each enhancer in `fx`. */
export const stemFiles = (s: StemSet) => ["rest.m4a", ...s.groups.flatMap((g) => ["original", ...s.fx].map((f) => `${g.key}.${f}.m4a`))];

/** What makes a version's stems: its sound tracks and the edit's voice. A cut filed with another key gets none (preview.ts). */
export const stemsKey = (tl: Timeline, voice: EditVoice | undefined) =>
  createHash("sha1").update(JSON.stringify([tl.fps, tl.tracks.A1, tl.tracks.A2, tl.tracks.A3, voice ?? null])).digest("hex");

export const stemsDir = (editId: string, variant: string) => path.join(editDir(editId), "stems", variant || "_");

/** One edit's session bookkeeping at a time: two versions never start two sessions for the same recording. */
const chains = new Map<string, Promise<unknown>>();
function oneAtATime<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(id) ?? Promise.resolve()).then(fn, fn);
  chains.set(id, next.catch(() => {}));
  return next;
}

type Made = { original: string; enhanced: string };

/**
 * The enhancer each recording's session is made with: its own pick, and for one that plays as recorded the edit's (its
 * levelled original is what Review's Off plays). shortcut: that spends one enhancer run on a recording heard as recorded;
 * level it on a computer instead if that costs too much. None while the edit has no enhancer.
 */
const sessionFx = (voice: EditVoice | undefined, src: string) => (!voice || voice.fx === "off" ? null : pickOf(voice, src) === "off" ? voice.fx : pickOf(voice, src));

/**
 * Each recording's session, started where it has none (or its old one was cancelled, refused or deleted): the enhanced
 * voices that are done, by recording and enhancer (every one made for it, picked or not, so Review can offer them), and
 * the notes of any that failed. Throws NeedsKey when a picked enhancer can't run for the person (its key, its sign-in),
 * Waiting while one is being made.
 */
async function enhanced(edit: EditMeta, actor: string, tl: Timeline, groups: string[]): Promise<{ made: Record<string, Record<string, Made>>; notes: string[] }> {
  const want = groups.flatMap((src) => (sessionFx(edit.voice, src) ? [[src, sessionFx(edit.voice, src)!] as const] : []));
  const sessions = await oneAtATime(edit.id, async () => {
    const all = readStep(edit.id, "voice") ?? {};
    const missing = [];
    for (const [src, fx] of want) {
      const id = all[src]?.[fx];
      const st = id ? (await enhanceResult(id)).status : "gone";
      if (st === "gone" || st === "ready" || st === "needs_key") missing.push([src, fx] as const);
    }
    if (!missing.length) return all;
    const rec = findUser(actor);
    if (!rec) throw new Error("The account that asked for this cut is gone");
    const user = sessionOf(rec);
    const can = usableEngines(user);
    const no = missing.find(([, fx]) => !can.includes(fx));
    if (no) throw new NeedsKey(`${fxName(no[1])} can't run for you yet: set it up in Settings, or pick another voice for this edit`);
    const files = await localFiles({ ...tl, sources: Object.fromEntries(missing.map(([src]) => [src, tl.sources[src]!])) }, undefined, true);
    // shortcut: a session enhances the whole recording, even when the cut uses a minute of an hour (and Adobe's plan may refuse
    // the length); cut the span the edit uses first, on a computer, when moments of long recordings get a voice
    for (const [src, fx] of missing) {
      const id = await enhanceFile(user, `${edit.name} · ${tl.sources[src]!.name}`, files[src]!, fx, edit.projectId);
      all[src] = { ...all[src], [fx]: id };
    }
    await saveStep(edit.id, "voice", all);
    return all;
  });
  const made: Record<string, Record<string, Made>> = {};
  const notes: string[] = [];
  let waiting = 0;
  for (const src of groups) {
    for (const [fx, id] of Object.entries(sessions[src] ?? {})) {
      const r = await enhanceResult(id);
      const wanted = sessionFx(edit.voice, src) === fx;
      if (r.original && r.enhanced) (made[src] ??= {})[fx] = { original: r.original, enhanced: r.enhanced };
      else if ((r.status === "queued" || r.status === "running") && wanted) {
        if (Date.now() - (r.createdAt ?? 0) < VOICE_WAIT_MS) waiting++;
        else notes.push(`${VOICE_NOTE}${fxName(fx)} has not finished ${tl.sources[src]!.name} after hours, so it plays as recorded (the Audio Enhancer goes on with it)`);
      } else if (wanted && r.status === "error") notes.push(`${VOICE_NOTE}${fxName(fx)} could not enhance ${tl.sources[src]!.name}${r.error ? ` (${r.error})` : ""}, so it plays as recorded: pick the voice again to try again`);
    }
  }
  if (waiting) throw new Waiting(20, `Enhancing the voice: ${waiting} recording${waiting === 1 ? "" : "s"} left`);
  return { made, notes };
}

/** The sessions of an edit's voices that failed, forgotten: picking a voice again makes them anew. */
export async function forgetFailed(editId: string): Promise<void> {
  await oneAtATime(editId, async () => {
    const all = readStep(editId, "voice");
    if (!all) return;
    for (const fxs of Object.values(all)) for (const [fx, id] of Object.entries(fxs)) if ((await enhanceResult(id)).status === "error") delete fxs[fx];
    await saveStep(editId, "voice", all);
  });
}

/** A clip of a sound track as a part lays it: in seconds, from `file`. */
const clipOf = (tl: Timeline, i: Item, file: string): StemClip => ({
  file,
  at: i.rec / tl.fps,
  from: i.in / tl.sources[i.src]!.fps,
  dur: i.len / tl.fps,
  ...(i.gainDb ? { gainDb: i.gainDb } : {}),
  ...(i.fade_in ? { fadeIn: i.fade_in / tl.fps } : {}),
  ...(i.fade_out ? { fadeOut: i.fade_out / tl.fps } : {}),
});

/**
 * What the stems task makes for this cut: per recording a part as recorded and one per enhancer made (the edit's slot
 * plays the recording's own pick), the rest (music and sound effects), and the mix the cut plays. Null when a recording
 * of the cut has no enhanced voice yet (nothing to choose between).
 */
export async function stemsPlan(edit: EditMeta, variant: string, tl: Timeline, groups: string[], made: Record<string, Record<string, Made>>): Promise<StemsInput | null> {
  if (!groups.length || groups.some((src) => !made[src])) return null;
  const voice = edit.voice?.fx && edit.voice.fx !== "off" ? edit.voice.fx : "off";
  const fx = [...new Set(groups.flatMap((src) => Object.keys(made[src]!)))].sort((a, b) => Number(b === voice) - Number(a === voice) || a.localeCompare(b));
  const files: Record<string, string> = {};
  const name = (p: string) => Object.keys(files).find((k) => files[k] === p) ?? ((files[`f${Object.keys(files).length}`] = p), `f${Object.keys(files).length - 1}`);
  const on = (i: Item) => i.enabled !== false;
  const parts: StemsInput["parts"] = [];
  const mix: StemsInput["mix"] = {};
  for (const src of groups) {
    const key = stemKey(src);
    const original = Object.values(made[src]!)[0]!.original;
    const pick = pickOf(edit.voice, src);
    const items = tl.tracks.A1.items.filter((i) => on(i) && i.src === src);
    for (const f of ["original", ...fx]) {
      // the edit's slot plays what this recording itself picked; an enhancer it has none of is the recording as it is
      const which = f === voice ? pick : f;
      const file = f === "original" || which === "off" ? original : (made[src]![which]?.enhanced ?? original);
      parts.push({ name: `${key}.${f}.m4a`, clips: items.map((i) => clipOf(tl, i, name(file))) });
    }
    mix[`${key}.original.m4a`] = 1 - shareOf(edit.voice, src);
    if (voice !== "off") mix[`${key}.${voice}.m4a`] = shareOf(edit.voice, src);
  }
  const rest = (["A2", "A3"] as const).filter((t) => !tl.tracks[t].mute).flatMap((t) => tl.tracks[t].items.filter(on));
  const local = rest.length ? await localFiles({ ...tl, sources: Object.fromEntries(rest.map((i) => [i.src, tl.sources[i.src]!])) }, edit.id, true) : {};
  parts.push({ name: "rest.m4a", clips: rest.map((i) => clipOf(tl, i, name(local[i.src]!))) });
  mix["rest.m4a"] = 1;
  const secs = cutEnd(tl) / tl.fps;
  // shortcut: the mix stays at the Enhancer's -15 LUFS (with a limiter), not the -14 every other preview is levelled to, so
  // Review's controls play exactly what the cut does; level both parts and mix together if the 1 LU step is noticed
  const set: StemSet = { groups: groups.map((src) => ({ key: stemKey(src), label: tl.sources[src]!.name, mix: shareOf(edit.voice, src) })), fx, voice, duration: secs };
  return { edit: edit.id, variant, key: stemsKey(tl, edit.voice), secs, parts, mix, files, set };
}

/** The stems task's files, on the server: the version's stems folder replaced whole, its manifest (stems.json) written last. */
export async function keepStems(input: StemsInput, files: Record<string, string>): Promise<void> {
  const dir = stemsDir(input.edit, input.variant);
  const tmp = `${dir}.tmp-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  await (await import("node:fs/promises")).mkdir(tmp, { recursive: true });
  for (const [name, at] of Object.entries(files)) await rename(at, path.join(tmp, name));
  await writeFile(path.join(tmp, "stems.json"), JSON.stringify({ set: input.set, key: input.key }));
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
}

/** The version's stems when they were made from this cut and the edit's voice now, else null. */
export async function stemsFor(edit: Pick<EditMeta, "id" | "voice">, variant: string, tl: Timeline): Promise<{ dir: string; set: StemSet } | null> {
  const dir = stemsDir(edit.id, variant);
  const got = JSON.parse(await readFile(path.join(dir, "stems.json"), "utf8").catch(() => "null")) as { set: StemSet; key: string } | null;
  return got && got.key === stemsKey(tl, edit.voice) ? { dir, set: got.set } : null;
}

/** Review's stems folder filled from the version's own (linked where the disk allows, else copied). */
export async function fileStems(edit: EditMeta, variant: string, tl: Timeline, assetId: string, n: number): Promise<void> {
  const stems = await stemsFor(edit, variant, tl);
  if (!stems) return;
  const { copyFile, link } = await import("node:fs/promises");
  await attachStems(assetId, n, stems.set, async (dir) => {
    for (const f of stemFiles(stems.set)) await link(path.join(stems.dir, f), path.join(dir, f)).catch(() => copyFile(path.join(stems.dir, f), path.join(dir, f)));
  });
}

/**
 * The parts made, or being made: done when the version's stems are this cut's; else the task is started (or one under way
 * for this cut waited for: Waiting), and a failed one is said in a note, the cut going on with the sound it renders.
 */
async function stems(edit: EditMeta, variant: string, tl: Timeline, plan: StemsInput | null, actor: string): Promise<string[]> {
  const ref = `${edit.id}:${variant}`;
  if (!plan) {
    await rm(stemsDir(edit.id, variant), { recursive: true, force: true });
    return [];
  }
  if (await stemsFor(edit, variant, tl)) return [];
  const t = taskFor(STEMS_TASK, ref);
  const same = (t?.input as StemsInput | null)?.key === plan.key;
  if (t && same && (t.state === "queued" || t.state === "running")) throw new Waiting(20, taskWaitLine(t) ?? t.line ?? "Making the voice parts");
  if (t && same && t.state === "failed") {
    dropTask(STEMS_TASK, ref);
    return [`${VOICE_NOTE}its parts for Review's voice controls could not be made (${t.error ?? "unknown error"}), so it plays as rendered`];
  }
  if (t) dropTask(STEMS_TASK, ref);
  const got = await startTask<StemsInput, null>(STEMS_TASK, ref, actor, edit.workspaceId, plan);
  if (got.state === "queued") throw new Waiting(20, got.line ?? "Making the voice parts");
  return [];
}

/**
 * The edit has something for the sound step: a voice picked, voices made before (Review offers them), a bed asked for
 * (bed.ts), or the library's sound effects. Any other edit goes from post straight to its preview, as it always did.
 */
export function soundDue(e: Partial<Pick<EditMeta, "id" | "voice" | "song" | "brief" | "bundle" | "plan">>): boolean {
  if ((e.voice && (e.voice.fx !== "off" || Object.keys(e.voice.per ?? {}).length)) || (e.id && Object.keys(readStep(e.id, "voice") ?? {}).length)) return true;
  return !e.plan && (!!e.song || asksMusic(e.brief ?? "") || e.bundle?.sfxSet === "library");
}

export async function soundStep({ edit, job, variant, signal }: StepContext): Promise<void> {
  if (!variant) return;
  let d = readDraft(edit.id, variant);
  if (!d) throw new Error(`Draft ${variant} first`);
  const laid = laySound(edit, d);
  if (laid !== d) await saveDraft(edit.id, variant, (d = { ...d, ...laid }));
  const tl = d.timeline;
  const groups = voiceGroups(tl);
  const { made, notes } = groups.length ? await enhanced(edit, job.actor!, tl, groups) : { made: {}, notes: [] };
  if (signal.aborted) return;
  notes.push(...(await stems(edit, variant, tl, await stemsPlan(edit, variant, tl, groups, made), job.actor!)));
  // the app's own Voice step cleaned the recording; an enhancer picked works from the recording itself
  if (pickOf(edit.voice, groups[0] ?? "") !== "off" && edit.steps?.some((s) => s.id === "voice")) notes.push(`${VOICE_NOTE}${fxName(edit.voice!.fx)} works from the recording itself, in place of the Voice step's clean-up`);
  const next = [...d.notes.filter((n) => !n.startsWith(VOICE_NOTE)), ...notes];
  if (next.join("\n") !== d.notes.join("\n")) await saveDraft(edit.id, variant, { ...d, notes: next });
  // the voice was changed while this ran: make it again with the new one (the queue keeps no second job of a running one)
  const now = readEdit(edit.id);
  if (now && JSON.stringify(now.voice ?? null) !== JSON.stringify(edit.voice ?? null)) throw new Waiting(1, "The voice changed: making it again");
}
