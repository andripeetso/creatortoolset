import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EditVoice, Timeline } from "../../contracts/editor";
import { sessionOf } from "../auth";
import { enhanceFile, enhanceResult, LOUDNESS, usableEngines } from "../enhance";
import { ffmpegTo } from "../library/media/run";
import { NeedsKey } from "../library/transcribe";
import type { StemSet } from "../review";
import { findUser } from "../users";
import { Waiting } from "./analyze";
import { ASKS_MUSIC, cutEnd, laySound } from "./bed";
import type { StepContext } from "./engine";
import { sfxMix } from "./plan-render";
import { localFiles } from "./preview";
import { editDir, readDraft, readStep, saveDraft, saveStep, type EditMeta } from "./store";

/**
 * The sound step (one version, on the server, after post-processing): the cut's music bed and sound effects (bed.ts), then
 * its voice. Nothing is done to a voice until the person picks an enhancer (EditVoice); each recording picked goes through
 * the Audio Enhancer as a session of its own (api/enhance.ts: NVIDIA, ElevenLabs, or a plug-in's engine such as Adobe
 * Enhance Speech on the person's own sign-in), made once per recording and enhancer and kept for every later cut.
 *
 * Once a recording of the cut has an enhanced voice, the cut's sound is filed in parts (stems) for Review's voice
 * controls: per recording its voice as recorded and through each enhancer made, all at one loudness, and the rest (music,
 * sound effects). The cut plays the sum of those parts at the person's picks, so Review's controls start from exactly what
 * the cut sounds like, and "Off" is the recording as it is.
 */

/** Notes this file writes start with this, so a rerun replaces them. */
export const VOICE_NOTE = "Voice: ";

const NAMES: Record<string, string> = { nvidia: "NVIDIA", elevenlabs: "ElevenLabs", adobespeech: "Adobe Enhance Speech" };
export const fxName = (fx: string) => NAMES[fx] ?? fx;

/** A voice group's key in the stem file names (review.ts STEM_FILE). */
export const stemKey = (src: string) => createHash("sha1").update(src).digest("hex").slice(0, 8);

/** The recordings the cut's voice track plays (none when it is muted), in the order they first play. */
export function voiceGroups(tl: Timeline): string[] {
  if (tl.tracks.A1.mute) return [];
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
 * Each picked recording's session, started where it has none: the enhanced voices that are done, by recording and
 * enhancer (every one made for it, picked or not, so Review can offer them), and the notes of any that failed. Throws
 * NeedsKey when a picked enhancer can't run for the person (its key, its sign-in), Waiting while one is being made.
 */
async function enhanced(edit: EditMeta, actor: string, tl: Timeline, groups: string[]): Promise<{ made: Record<string, Record<string, Made>>; notes: string[] }> {
  const want = groups.flatMap((src) => (pickOf(edit.voice, src) === "off" ? [] : [[src, pickOf(edit.voice, src)] as const]));
  const sessions = await oneAtATime(edit.id, async () => {
    const all = readStep(edit.id, "voice") ?? {};
    const missing = [];
    for (const [src, fx] of want) {
      const id = all[src]?.[fx];
      if (!id || (await enhanceResult(id)).status === "gone") missing.push([src, fx] as const);
    }
    if (!missing.length) return all;
    const rec = findUser(actor);
    if (!rec) throw new Error("The account that asked for this cut is gone");
    const user = sessionOf(rec);
    const can = usableEngines(user);
    const no = missing.find(([, fx]) => !can.includes(fx));
    if (no) throw new NeedsKey(`${fxName(no[1])} can't run for you yet: set it up in Settings, or pick another voice for this edit`);
    const files = await localFiles({ ...tl, sources: Object.fromEntries(missing.map(([src]) => [src, tl.sources[src]!])) }, undefined, true);
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
      const picked = pickOf(edit.voice, src) === fx;
      if (r.original && r.enhanced) (made[src] ??= {})[fx] = { original: r.original, enhanced: r.enhanced };
      else if (r.status === "queued" || r.status === "running") waiting += picked ? 1 : 0;
      else if (picked) notes.push(`${VOICE_NOTE}${fxName(fx)} could not enhance ${tl.sources[src]!.name}${r.error ? ` (${r.error})` : ""}, so it plays as recorded`);
    }
  }
  if (waiting) throw new Waiting(20, `Enhancing the voice: ${waiting} recording${waiting === 1 ? "" : "s"} left`);
  return { made, notes };
}

/** One voice group's part: each of its clips on the voice track laid at its place from `file`, silence elsewhere, `secs` long. */
async function part(tl: Timeline, src: string | null, files: Record<string, string>, secs: number, out: string): Promise<void> {
  const tracks = src ? (["A1"] as const) : (["A2", "A3"] as const);
  const only = src ? { ...tl, tracks: { ...tl.tracks, A1: { ...tl.tracks.A1, items: tl.tracks.A1.items.filter((i) => i.src === src) } } } : tl;
  const mix = sfxMix(only, files, 1, "[0:a]", [...tracks]);
  await ffmpegTo(out, [
    "-f", "lavfi", "-t", secs.toFixed(6), "-i", "anullsrc=r=48000:cl=stereo",
    ...(mix ? [...mix.inputs, "-filter_complex", `${mix.filter};[sfxm]anull[a]`, "-map", "[a]"] : ["-map", "0:a"]),
    "-c:a", "aac", "-b:a", "192k", "-f", "mp4",
  ]);
}

/**
 * The version's stems and its mix (mix.m4a: what the cut plays), made into stemsDir with their manifest (stems.json) last;
 * none when no recording of the cut has an enhanced voice (the cut keeps the sound it was rendered with).
 */
async function makeStems(edit: EditMeta, variant: string, tl: Timeline, groups: string[], made: Record<string, Record<string, Made>>): Promise<void> {
  const dir = stemsDir(edit.id, variant);
  const fx = [...new Set(groups.flatMap((src) => Object.keys(made[src] ?? {})))].sort((a, b) => Number(b === edit.voice?.fx) - Number(a === edit.voice?.fx) || a.localeCompare(b));
  await rm(dir, { recursive: true, force: true });
  if (!fx.length) return;
  const tmp = `${dir}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const secs = cutEnd(tl) / tl.fps;
  const voice = edit.voice?.fx && edit.voice.fx !== "off" ? edit.voice.fx : "off";
  const own = await ownOriginals(edit, tl, groups.filter((src) => !made[src]));
  for (const src of groups) {
    const key = stemKey(src);
    const original = Object.values(made[src] ?? {})[0]?.original ?? own[src]!;
    const pick = pickOf(edit.voice, src);
    for (const f of ["original", ...fx]) {
      // the edit's slot plays what this recording itself picked (its own enhancer); one it has none of is the recording as it is
      const which = f === voice ? pick : f;
      const file = f === "original" || which === "off" ? original : (made[src]?.[which]?.enhanced ?? original);
      await part(tl, src, { [src]: file }, secs, path.join(tmp, `${key}.${f}.m4a`));
    }
  }
  const others = [...new Set([...tl.tracks.A2.items, ...tl.tracks.A3.items].map((i) => i.src))];
  await part(tl, null, others.length ? await localFiles({ ...tl, sources: Object.fromEntries(others.map((s) => [s, tl.sources[s]!])) }, edit.id, true) : {}, secs, path.join(tmp, "rest.m4a"));
  const set: StemSet = { groups: groups.map((src) => ({ key: stemKey(src), label: tl.sources[src]!.name, mix: shareOf(edit.voice, src) })), fx, voice, duration: secs };
  // the cut's sound: each recording as recorded at 1 - its share and through the edit's enhancer at its share, and the rest, as Review's controls mix them
  const ins = [...groups.flatMap((src) => [`${stemKey(src)}.original.m4a`, `${stemKey(src)}.${voice === "off" ? "original" : voice}.m4a`]), "rest.m4a"];
  const w = [...groups.flatMap((src) => [1 - shareOf(edit.voice, src), shareOf(edit.voice, src)]), 1];
  await ffmpegTo(path.join(tmp, "mix.m4a"), [
    ...ins.flatMap((f) => ["-i", path.join(tmp, f)]),
    "-filter_complex", `${ins.map((_, k) => `[${k}:a]volume=${w[k]!.toFixed(3)}[m${k}]`).join(";")};${ins.map((_, k) => `[m${k}]`).join("")}amix=inputs=${ins.length}:duration=longest:normalize=0,alimiter=limit=0.89[a]`,
    "-map", "[a]", "-c:a", "aac", "-b:a", "192k", "-f", "mp4",
  ]);
  await writeFile(path.join(tmp, "stems.json"), JSON.stringify({ set, key: stemsKey(tl, edit.voice) }));
  await rename(tmp, dir);
}

/** The voice of recordings with no session, levelled as the Audio Enhancer levels its originals (enhance.ts LOUDNESS); made once each. */
async function ownOriginals(edit: EditMeta, tl: Timeline, srcs: string[]): Promise<Record<string, string>> {
  if (!srcs.length) return {};
  const files = await localFiles({ ...tl, sources: Object.fromEntries(srcs.map((s) => [s, tl.sources[s]!])) }, undefined, true);
  const out: Record<string, string> = {};
  for (const src of srcs) {
    const dest = path.join(editDir(edit.id), "voice", `${src}.original.m4a`);
    if (!existsSync(dest)) {
      await mkdir(path.dirname(dest), { recursive: true });
      await ffmpegTo(dest, ["-i", files[src]!, "-vn", "-map", "0:a:0", "-af", LOUDNESS, "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "-f", "mp4"]);
    }
    out[src] = dest;
  }
  return out;
}

/** The version's stems when they were made from this cut and the edit's voice now, else null. */
export async function stemsFor(edit: EditMeta, variant: string, tl: Timeline): Promise<{ dir: string; set: StemSet } | null> {
  const dir = stemsDir(edit.id, variant);
  const got = JSON.parse(await readFile(path.join(dir, "stems.json"), "utf8").catch(() => "null")) as { set: StemSet; key: string } | null;
  return got && got.key === stemsKey(tl, edit.voice) ? { dir, set: got.set } : null;
}

/** The rendered preview's sound replaced by the stems' mix (the picture copied as it is). */
export async function withMix(video: string, dir: string): Promise<void> {
  await ffmpegTo(video, ["-i", video, "-i", path.join(dir, "mix.m4a"), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "copy", "-shortest", "-movflags", "+faststart", "-f", "mp4"]);
}

/** Review's stems folder filled from the version's own (linked where the disk allows, else copied). */
export const placeStems = (from: string, set: StemSet) => async (dir: string) => {
  for (const f of stemFiles(set)) await link(path.join(from, f), path.join(dir, f)).catch(() => copyFile(path.join(from, f), path.join(dir, f)));
};

/**
 * The edit has something for the sound step: a voice picked, voices made before (Review offers them), a bed asked for
 * (bed.ts), or the library's sound effects. Any other edit goes from post straight to its preview, as it always did.
 */
export function soundDue(e: Partial<Pick<EditMeta, "id" | "voice" | "song" | "brief" | "bundle" | "plan">>): boolean {
  if ((e.voice && (e.voice.fx !== "off" || Object.keys(e.voice.per ?? {}).length)) || (e.id && Object.keys(readStep(e.id, "voice") ?? {}).length)) return true;
  return !e.plan && (!!e.song || ASKS_MUSIC.test(e.brief ?? "") || e.bundle?.sfxSet === "library");
}

export async function soundStep({ edit, job, variant, signal }: StepContext): Promise<void> {
  if (!variant) return;
  let d = readDraft(edit.id, variant);
  if (!d) throw new Error(`Draft ${variant} first`);
  const laid = laySound(edit, d);
  if (laid !== d) await saveDraft(edit.id, variant, (d = { ...d, ...laid }));
  const tl = d.timeline;
  const groups = voiceGroups(tl);
  const { made, notes } = groups.length ? await enhanced(edit, job.actor ?? edit.createdBy, tl, groups) : { made: {}, notes: [] };
  if (signal.aborted) return;
  try {
    await makeStems(edit, variant, tl, groups, made);
  } catch (e) {
    // the voice controls are a nicety: the cut is filed with the sound it was rendered with
    await rm(stemsDir(edit.id, variant), { recursive: true, force: true });
    notes.push(`${VOICE_NOTE}its parts for Review's voice controls could not be made (${e instanceof Error ? e.message : String(e)}), so it plays as rendered`);
  }
  const next = [...d.notes.filter((n) => !n.startsWith(VOICE_NOTE)), ...notes];
  if (next.join("\n") !== d.notes.join("\n")) await saveDraft(edit.id, variant, { ...d, notes: next });
}
