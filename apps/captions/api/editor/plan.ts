import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { EditPlan, FootageIndex, GenSpec, IndexSource, PlanEffect, PlanShot, PlanText, SongBeats } from "../../contracts/edit-plan";
import type { Item, Sentence, Timeline, TimelineSource } from "../../contracts/editor";
import { SOUNDS } from "../../contracts/library";
import { aiFor, completeWithFallback } from "../ai-complete";
import { parseJsonObject } from "../lib/instagram/vision";
import { packInstructions } from "../lib/packs";
import { skillText } from "../lib/skills";
import { renderInstructions } from "../lib/workshop/prompt";
import { ownedProjects } from "../lib/workshop/workspace";
import { libraryDb } from "../library/db";
import { whoFor } from "../library/describe";
import type { ProbeSummary } from "../library/media/probe";
import { NeedsKey } from "../library/transcribe";
import type { StepContext } from "./engine";
import { fitted } from "./framing";
import { clearPasses } from "./passes";
import { macAway } from "./script";
import { generateClip, indexSources, songBeats, styles } from "./standins";
import { editDir, readEdit, saveDraft, saveEdit, saveStep, sourcesWorkspace, UNNAMED, type EditMeta } from "./store";
import { styleBlock } from "./styles";
import { emptyTracks, sourceOf } from "./timeline";

/**
 * The AI Editor's plan: an edit that is not cut around what is said. The person's own AI writes the edit as shots on a
 * timeline (contracts/edit-plan.ts) from the brief, the workspace's setup, the footage index and the song's beats;
 * code checks and repairs the answer (repairPlan) and never trusts it; the draft step lays it as a timeline
 * (planTimeline) and the preview draws its effects (plan-render.ts). Footage where nobody speaks is always planned, and
 * so is an edit that asks for it (EditBrief.plan): a speech-led edit takes the script step's path as before.
 */

/** Under this share of the footage's sound in sentences, nobody is taken to speak (a transcript over music makes words up). */
export const SPEECH_SHARE = 0.15;
export const SPEED = { min: 0.25, max: 4 };
/** A cut moved onto a beat keeps every shot at least this long (seconds). */
export const MIN_SHOT_S = 0.2;
const MAX_SHOT_S = 60;
const MAX_FX = 8;
const MAX_TEXTS = 30;
/** A shot's own sound under the song. */
export const UNDER_DB = -12;
/** An effect this close to a beat lands on it (seconds). */
const FX_SNAP_S = 0.12;
const FX_TYPES = new Set(["punch", "zoom", "flash", "shake", "glitch", "rgb", "blur", "invert", "strobe"]);

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const HEX = /^#[0-9a-f]{6}$/i;

/* ---------------- which edits are planned ---------------- */

const musicSql = `(EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = a.id AND t.tag = '${SOUNDS.music.tag}')
  OR a.id IN (SELECT ci.asset_id FROM collection_items ci JOIN collections c ON c.id = ci.collection_id
    WHERE c.library_id = a.library_id AND c.parent_id IS NULL AND c.name = '${SOUNDS.music.folder}'))`;

/**
 * A song the person added as one (use_file sound music: their own tag), never transcribed. The library's guess (a long
 * sound filed in Music by length) is not enough here: a voice recording can be filed there, and its words are the edit.
 */
export function isMusic(versionId: string): boolean {
  return !!libraryDb()
    .prepare("SELECT 1 FROM asset_versions v JOIN asset_tags t ON t.asset_id = v.asset_id WHERE v.id = ? AND t.source = 'user' AND t.tag = ?")
    .get(versionId, SOUNDS.music.tag);
}

/** Every source picked is B-roll as the library sorted it (nobody talks to the camera), songs aside: nothing to transcribe. */
export function allBroll(edit: Pick<EditMeta, "sources" | "song">): boolean {
  const q = libraryDb().prepare("SELECT a.roll FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?");
  const picture = edit.sources.filter((id) => id !== edit.song && !isMusic(id));
  return picture.length > 0 && picture.every((id) => (q.get(id) as { roll: string | null } | undefined)?.roll === "b");
}

/** The share of the sources' sound (songs aside) that is in sentences. */
export function speechShare(sentences: Pick<Sentence, "s" | "e">[], soundS: number): number {
  return soundS > 0 ? sentences.reduce((n, s) => n + Math.max(0, s.e - s.s), 0) / soundS : 0;
}

/** Whether this edit is planned rather than cut around speech: asked for, or nobody speaks in its footage. */
export function isPlanned(edit: EditMeta, sentences: Sentence[]): boolean {
  if (edit.plan) return true;
  const probe = libraryDb().prepare("SELECT probe FROM asset_versions WHERE id = ?");
  let soundS = 0;
  for (const id of edit.sources) {
    if (id === edit.song || isMusic(id)) continue;
    const p = JSON.parse((probe.get(id) as { probe: string | null } | undefined)?.probe ?? "null") as ProbeSummary | null;
    if (p?.acodec) soundS += p.duration;
  }
  return speechShare(sentences, soundS) < SPEECH_SHARE;
}

/* ---------------- the song ---------------- */

export interface Song {
  id: string;
  title: string;
  dur: number;
  /** what the notes say about where it came from */
  from: string;
}

interface MusicRow {
  id: string;
  title: string;
  probe: string | null;
}

const songOf = (r: MusicRow, from: string): Song | null => {
  const p = JSON.parse(r.probe ?? "null") as ProbeSummary | null;
  return p?.acodec && p.duration > 1 ? { id: r.id, title: r.title, dur: p.duration, from } : null;
};

/**
 * The song an edit cuts to: the one it names (EditBrief.song), else a song among its sources, else the library's song
 * whose title the brief names, else, when nobody speaks in the footage, the library's newest song. Null: the sources'
 * own sound leads. Only a song the edit's creator may read, in the edit's own workspace.
 */
export function songFor(edit: EditMeta, index: FootageIndex): Song | null {
  const db = libraryDb();
  const row = db.prepare("SELECT v.id, a.title, v.probe, a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.trashed_at IS NULL");
  const mine = (id: string) => sourcesWorkspace(edit.createdBy, [id]) === edit.workspaceId;
  if (edit.song && mine(edit.song)) {
    const r = row.get(edit.song) as MusicRow | undefined;
    const s = r && songOf(r, "the song the edit names");
    if (s) return s;
  }
  for (const src of index.sources) {
    if (!(isMusic(src.id) || (!src.w && src.sound && !src.speech))) continue;
    const r = row.get(src.id) as MusicRow | undefined;
    const s = r && songOf(r, "a song among the sources");
    if (s) return s;
  }
  const lib = (row.get(edit.sources[0] ?? "") as { library_id: string } | undefined)?.library_id;
  if (!lib) return null;
  const rows = db
    .prepare(`SELECT v.id, a.title, v.probe FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE a.library_id = ? AND a.trashed_at IS NULL AND ${musicSql} ORDER BY a.created_at DESC LIMIT 200`)
    .all(lib) as unknown as MusicRow[];
  const brief = edit.brief.toLowerCase();
  const named = rows.find((r) => r.title.trim().length >= 3 && brief.includes(r.title.trim().toLowerCase()));
  const pick = named ? songOf(named, "the song the brief names") : index.sources.some((s) => s.speech) ? null : rows.map((r) => songOf(r, "the library's newest song")).find(Boolean);
  return pick && mine(pick.id) ? pick : null;
}

/* ---------------- the prompt ---------------- */

const SYSTEM = `You edit a video. You get what the person asked for (the brief), how their workspace works, an index of the footage and, when a song leads, its beats. You don't watch the footage: the index tells you each source's length, picture, sound, whether someone speaks, and its shots with how much moves in each and what is seen.

Make exactly the kind of edit the brief asks for, whatever it is: a hard edit cut on the beat, a calm recap, a trailer, a music video, a montage. The brief decides the pace, the order, the effects and the texts; the workspace's setup decides the rest. Pick the moments that fit.

Write the edit as shots played one after another from 0, with no gaps. Times are seconds. When a song leads, cut on its beats (given as seconds in the edit) and land the hits (punch, flash, shake) on its strong beats. An effect's time is inside its shot, from 0.

Answer with JSON only, in this shape:
{"plans":[{"kind":"the brief's words for this kind of edit","variation":"what sets this version apart","lead":"song","shots":[{"src":"S1","in":12.5,"dur":1.0,"speed":1,"fx":[{"type":"punch","at":0,"amount":1.2}],"enter":"cut","sound":"off","why":"a few words"}],"texts":[{"at":0,"dur":1.5,"text":"words on screen","place":"middle"}]}]}

- src: a source by its tag; in: where in it the shot starts (seconds); dur: how long the shot is in the edit.
- speed: 1 as filmed (0.25 to 4); or ramp, the speed over the shot's own time: [{"t":0,"speed":1},{"t":0.4,"speed":0.3}].
- fx: punch {at, amount 1.05-2}, zoom {at, dur, from, to: 1-3}, flash {at, dur, color "#rrggbb"}, shake {at, dur, amount 0-1}, glitch, rgb, blur, invert, strobe {at, dur, amount 0-1}. Leave out what a shot doesn't need.
- enter: cut, flash, whip or dissolve. sound: off, under (beneath the song) or full.
- lead: "song" to cut to the song, "sources" to keep the footage's own sound.
- texts only when the brief or the setup asks for words on screen.`;

export interface PlanInput {
  brief: string;
  versions: number;
  targetS: number;
  /** the workspace's instructions and the editing style's notes */
  setup: string;
  index: FootageIndex;
  /** source id → what is said in it, with times (cut short) */
  words: Record<string, string>;
  song?: Song;
  /** the generated clips' styles, when there are any */
  gen: string[];
  packText?: string;
}

/** S1, S2, … for the sources in index order. */
export const tagOf = (index: FootageIndex, id: string) => `S${index.sources.findIndex((s) => s.id === id) + 1}`;

const list = (xs: number[], from: number, to: number) =>
  xs
    .map((b) => b - from)
    .filter((b) => b >= 0 && b <= to)
    .slice(0, 400)
    .map((b) => b.toFixed(2))
    .join(" ");

export function planPrompt(i: PlanInput): { system: string; user: string } {
  const parts = [`Brief:\n${i.brief.trim() || "(none: make a good edit of this footage)"}`];
  if (i.setup.trim()) parts.push(`The workspace's setup:\n${i.setup.trim()}`);
  parts.push(`Versions: ${i.versions}${i.versions > 1 ? " (each different, says how in its variation)" : ""}`);
  if (i.targetS) parts.push(`Length: about ${i.targetS} seconds`);
  const src = i.index.sources.map((s) => {
    const head = `${tagOf(i.index, s.id)} ${JSON.stringify(s.title)}: ${s.dur.toFixed(1)} s, ${s.w ? `${s.w}x${s.h} at ${Math.round(s.fps)} fps` : "sound only (no picture: not a shot)"}, ${s.sound === false ? "no sound" : "sound"}${s.speech ? ", someone speaks" : ""}`;
    const shots = s.shots.slice(0, 60).map((x) => `  ${x.a.toFixed(1)}-${x.b.toFixed(1)} motion ${x.motion.toFixed(2)}${x.desc ? `: ${x.desc}` : ""}`);
    const said = i.words[s.id] ? [`  said: ${i.words[s.id]}`] : [];
    return [head, ...shots, ...said].join("\n");
  });
  parts.push(`Sources:\n${src.join("\n")}`);
  const b = i.index.song;
  if (i.song && b) {
    const left = i.song.dur - b.startS;
    const to = Math.min(left, (i.targetS || left) + 5);
    parts.push(
      [
        `Song ${JSON.stringify(i.song.title)} leads, from ${b.startS.toFixed(1)} s of it: ${Math.round(b.bpm)} bpm, ${left.toFixed(1)} s left.`,
        `Beats (seconds in the edit): ${list(b.beats, b.startS, to)}`,
        `Downbeats: ${list(b.downbeats, b.startS, to)}`,
        `Strong: ${list(b.strong, b.startS, to)}`,
        `Sections: ${b.sections.map((s) => `${(s.a - b.startS).toFixed(1)}-${(s.b - b.startS).toFixed(1)} energy ${s.energy.toFixed(2)}`).join(", ")}`,
      ].join("\n"),
    );
  } else parts.push("No song: the footage's own sound leads.");
  if (i.gen.length) parts.push(`A shot can also be a clip made from nothing: {"generate":{"style":"${i.gen.join('" or "')}","palette":["#rrggbb"]},"dur":2} in place of src and in.`);
  return { system: i.packText ? `${SYSTEM}\n\n${i.packText}` : SYSTEM, user: parts.join("\n\n") };
}

/** The answer's plans, as objects for repairPlan to check: one plan given bare counts too. */
export function parsePlans(text: string): Record<string, unknown>[] {
  const o = parseJsonObject(text);
  const plans = (Array.isArray(o.plans) ? o.plans : [o]).filter(obj).filter((p) => Array.isArray(p.shots) && p.shots.length);
  if (!plans.length) throw new Error("The AI's answer has no shots");
  return plans;
}

/* ---------------- check and repair ---------------- */

export interface RepairContext {
  index: FootageIndex;
  /** the song that leads (its beats are index.song), with its length */
  song?: Pick<Song, "id" | "dur">;
  /** seconds; 0 = as long as the plan (and the song) */
  targetS: number;
  size: { w: number; h: number; fps: number };
  /** the size is the edit's own (its style's): the AI's is not taken */
  fixedSize: boolean;
  gen: string[];
}

/** The speed at `t` of a ramp (straight between its points, flat before the first and after the last). */
export function speedAt(ramp: { t: number; speed: number }[], t: number): number {
  if (t <= ramp[0]!.t) return ramp[0]!.speed;
  for (let k = 1; k < ramp.length; k++) {
    const a = ramp[k - 1]!;
    const b = ramp[k]!;
    if (t <= b.t) return b.t === a.t ? b.speed : a.speed + ((b.speed - a.speed) * (t - a.t)) / (b.t - a.t);
  }
  return ramp[ramp.length - 1]!.speed;
}

/** Seconds of source a shot of `dur` plays: its speed over its time. */
export function sourceSpan(dur: number, speed = 1, ramp?: { t: number; speed: number }[]): number {
  if (!ramp?.length) return dur * speed;
  const ts = [0, ...ramp.map((p) => p.t).filter((t) => t > 0 && t < dur), dur];
  let s = 0;
  for (let k = 1; k < ts.length; k++) s += ((speedAt(ramp, ts[k - 1]!) + speedAt(ramp, ts[k]!)) / 2) * (ts[k]! - ts[k - 1]!);
  return s;
}

/** An item's speed over its whole length (1 for every item that is not a planned shot's). */
export function meanSpeed(i: Pick<Item, "len" | "speed" | "ramp">, fps: number): number {
  if (!i.ramp?.length) return i.speed ?? 1;
  const d = i.len / fps;
  return d > 0 ? r3(sourceSpan(d, i.speed, i.ramp) / d) : 1;
}

function cleanRamp(v: unknown, dur: number): { t: number; speed: number }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const pts = v
    .filter(obj)
    .flatMap((p) => {
      const t = num(p.t);
      const s = num(p.speed);
      return t === undefined || s === undefined ? [] : [{ t: r3(clamp(t, 0, dur)), speed: r3(clamp(s, SPEED.min, SPEED.max)) }];
    })
    .sort((a, b) => a.t - b.t)
    .filter((p, k, all) => k === 0 || p.t > all[k - 1]!.t);
  return pts.length >= 2 && pts.some((p) => p.speed !== pts[0]!.speed) ? pts.slice(0, 12) : undefined;
}

/** A shot's effects, each of a known type and inside the shot. */
export function cleanFx(v: unknown, dur: number): PlanEffect[] {
  if (!Array.isArray(v)) return [];
  const out: PlanEffect[] = [];
  for (const f of v.filter(obj)) {
    if (out.length >= MAX_FX || !FX_TYPES.has(String(f.type))) continue;
    const at = r3(clamp(num(f.at) ?? 0, 0, Math.max(0, dur - 0.04)));
    const room = Math.max(0.03, dur - at);
    const len = (d: number, lo = 0.03) => r3(clamp(num(f.dur) ?? d, lo, room));
    const amount = (d: number, lo = 0, hi = 1) => r3(clamp(num(f.amount) ?? d, lo, hi));
    const type = f.type as PlanEffect["type"];
    if (type === "punch") out.push({ type, at, amount: amount(1.2, 1.02, 2) });
    else if (type === "zoom") out.push({ type, at, dur: len(room, 0.05), from: r3(clamp(num(f.from) ?? 1, 1, 3)), to: r3(clamp(num(f.to) ?? 1.2, 1, 3)) });
    else if (type === "flash") out.push({ type, at, dur: len(Math.min(0.15, room)), ...(HEX.test(String(f.color)) ? { color: String(f.color) } : {}) });
    else if (type === "shake") out.push({ type, at, dur: len(Math.min(0.3, room), 0.05), amount: amount(0.5) });
    else out.push({ type, at, dur: len(Math.min(0.3, room)), amount: amount(0.5) });
  }
  return out;
}

function cleanGen(v: Record<string, unknown>, seconds: number, gen: string[]): GenSpec | null {
  if (!gen.length) return null;
  const style = str(v.style, 80);
  const palette = Array.isArray(v.palette) ? v.palette.filter((c): c is string => typeof c === "string" && HEX.test(c)).slice(0, 6) : [];
  const params = obj(v.params) ? Object.fromEntries(Object.entries(v.params).filter(([, x]) => typeof x === "number" || typeof x === "string").slice(0, 20)) : undefined;
  const seed = num(v.seed);
  return {
    // free words go to the generator, which maps them to its nearest style; none at all is its first
    style: style || gen[0]!,
    seconds,
    ...(seed !== undefined ? { seed: Math.round(seed) } : {}),
    ...(palette.length ? { palette } : {}),
    ...(params && Object.keys(params).length ? { params: params as Record<string, number | string> } : {}),
  };
}

type Src = { source: IndexSource; inS: number } | { generate: Record<string, unknown> };

function srcOf(s: Record<string, unknown>, index: FootageIndex): Src | string {
  const g = obj(s.generate) ? s.generate : obj(s.src) && obj(s.src.generate) ? s.src.generate : null;
  if (g) return { generate: g };
  const ref = typeof s.src === "string" ? s.src : obj(s.src) ? str(s.src.source, 200) : str(s.source, 200);
  const inS = num(obj(s.src) ? s.src.inS : (s.in ?? s.inS)) ?? 0;
  const tag = /^s(\d+)$/i.exec(ref.trim());
  const source = index.sources.find((x) => x.id === ref) ?? (tag ? index.sources[Number(tag[1]) - 1] : undefined);
  if (!source) return `a shot from “${ref || "nothing"}”, which is not one of the sources: left out`;
  if (!source.w) return `a shot from ${tagOf(index, source.id)}, which has no picture: left out`;
  return { source, inS };
}

/** Moves each cut onto the nearest beat between its neighbours (each shot at least MIN_SHOT_S); cuts with no beat between stay. */
export function snapCuts(cuts: number[], end: number, beats: number[]): number[] {
  const out: number[] = [];
  let prev = 0;
  for (const c of cuts) {
    let best: number | undefined;
    for (const b of beats) if (b >= prev + MIN_SHOT_S && b <= end - MIN_SHOT_S && (best === undefined || Math.abs(b - c) < Math.abs(best - c))) best = b;
    const at = best ?? clamp(c, prev + MIN_SHOT_S, end - MIN_SHOT_S);
    if (at < prev + MIN_SHOT_S - 1e-9 || at > end - MIN_SHOT_S + 1e-9) continue; // no room: this cut goes and its shot runs on
    out.push(at);
    prev = at;
  }
  return out;
}

/**
 * The AI's plan checked against the footage and the brief, repaired where it can be: shots from sources that exist
 * and have a picture, laid end to end from 0 with no gap or overlap, cut on the song's beats when a song leads, as long
 * as the brief asks (and the song lasts), whole frames, in-points that leave room for the shot at its speed, effects of
 * known types inside their shots and within their ranges. What was changed is in the notes. A plan with nothing usable
 * is made again from the footage (fallbackShots), never refused.
 */
export function repairPlan(raw: Record<string, unknown>, c: RepairContext): { plan: EditPlan; notes: string[] } {
  const notes: string[] = [];
  const fps = c.size.fps;
  const beat = c.index.song;
  const leadRaw = obj(raw.lead) ? str(raw.lead.type, 20) : str(raw.lead, 20);
  const song = c.song && beat && leadRaw !== "sources" ? c.song : undefined;
  const left = song ? song.dur - beat!.startS : Infinity;
  if (c.song && !song) notes.push("The AI kept the footage's own sound rather than the song");

  // each shot on its own: a source that exists, a length, a speed, effects
  type Draft = Omit<PlanShot, "src" | "at"> & { src: Src };
  const shots: Draft[] = [];
  for (const s of (Array.isArray(raw.shots) ? raw.shots : []).filter(obj).sort((a, b) => (num(a.at) ?? 0) - (num(b.at) ?? 0))) {
    const src = srcOf(s, c.index);
    if (typeof src === "string") {
      notes.push(`The AI planned ${src}`);
      continue;
    }
    const dur = num(s.dur);
    if (dur === undefined || dur <= 0) continue;
    const d = clamp(dur, 1 / fps, MAX_SHOT_S);
    const sound = (["off", "under", "full"] as const).find((x) => x === s.sound) ?? (song ? "off" : "full");
    const enter = (["cut", "flash", "whip", "dissolve"] as const).find((x) => x === s.enter);
    const why = str(s.why, 120);
    shots.push({
      src,
      dur: d,
      speed: r3(clamp(num(s.speed) ?? 1, SPEED.min, SPEED.max)),
      ...(cleanRamp(s.ramp, d) ? { ramp: cleanRamp(s.ramp, d) } : {}),
      fx: cleanFx(s.fx, d),
      ...(enter && enter !== "cut" ? { enter } : {}),
      sound: "source" in src && src.source.sound === false ? "off" : sound,
      ...(why ? { why } : {}),
    });
  }
  if (!shots.length) {
    notes.push("The AI's plan had no shot that can be used: the footage is cut in turn instead");
    shots.push(...fallbackShots(c, song ? left : Infinity));
  }

  // the length: the brief's, else the plan's own; never past the song's end
  const total = shots.reduce((n, s) => n + s.dur, 0);
  const asked = c.targetS > 0 ? c.targetS : total;
  let end = Math.min(asked, left, total);
  const beats = beat ? beat.beats.map((b) => b - beat.startS).filter((b) => b > 0) : [];
  if (song) {
    // the end on a beat, when one is close
    const near = beats.reduce<number | undefined>((best, b) => (b <= Math.min(asked, left, total) + 1e-9 && (best === undefined || Math.abs(b - end) < Math.abs(best - end)) ? b : best), undefined);
    if (near !== undefined && end - near < 60 / beat!.bpm) end = near;
  }
  if (c.targetS > 0 && end < c.targetS - 0.5)
    notes.push(`It is ${end.toFixed(1)} s, ${c.targetS} s were asked for: ${left <= total && left < asked ? "the song ends there" : "the plan had no more shots"}`);

  // cuts where the plan put them, moved onto beats when a song leads, then onto whole frames
  let at = 0;
  const cuts: number[] = [];
  for (const s of shots) {
    at += s.dur;
    if (at < end - 1e-9) cuts.push(at);
  }
  const kept = song && beats.length ? snapCuts(cuts, end, beats) : snapCuts(cuts, end, []);
  if (kept.length < cuts.length) notes.push(`${cuts.length - kept.length} cuts had no room and were left out`);
  const frames = [0, ...kept, end].map((t) => Math.round(t * fps)).filter((f, k, all) => k === 0 || f > all[k - 1]!);
  const n = Math.min(shots.length, frames.length - 1);

  const out: PlanShot[] = [];
  const lens: number[] = [];
  let slowed = 0;
  for (let k = 0; k < n; k++) {
    const s = shots[k]!;
    const a = frames[k]! / fps;
    const dur = (frames[k + 1]! - frames[k]!) / fps;
    let speed = s.speed ?? 1;
    let ramp = s.ramp?.map((p) => ({ t: r3(Math.min(p.t, dur)), speed: p.speed })).filter((p, j, all) => j === 0 || p.t > all[j - 1]!.t);
    if (ramp && ramp.length < 2) ramp = undefined;
    let src: PlanShot["src"];
    if ("source" in s.src) {
      const { source } = s.src;
      let span = sourceSpan(dur, speed, ramp);
      if (span > source.dur) {
        // the source is shorter than the shot at its speed: slowed until it fits
        const k2 = (source.dur / span) * 0.999;
        speed = r3(speed * k2);
        ramp = ramp?.map((p) => ({ ...p, speed: r3(p.speed * k2) }));
        span = sourceSpan(dur, speed, ramp);
        slowed++;
      }
      src = { source: source.id, inS: r3(clamp(s.src.inS, 0, Math.max(0, source.dur - span - 0.001))) };
    } else {
      const g = cleanGen(s.src.generate, r3(dur), c.gen);
      if (!g) {
        notes.push("A generated clip was planned, and nothing here makes them: left out");
        continue;
      }
      src = { generate: g };
    }
    let fx = cleanFx(s.fx, dur);
    if (song && beats.length) {
      // the hits land on the beat nearest them, when one is that close and inside the shot
      fx = fx.map((f) => {
        if (f.type !== "punch" && f.type !== "flash" && f.type !== "shake") return f;
        const t = a + (f.at ?? 0);
        const b = beats.find((x) => Math.abs(x - t) <= FX_SNAP_S && x >= a && x < a + dur);
        return b === undefined ? f : { ...f, at: r3(b - a) };
      });
    }
    lens.push(frames[k + 1]! - frames[k]!);
    out.push({
      at: r3(a),
      dur: r3(dur),
      src,
      ...(speed !== 1 ? { speed } : {}),
      ...(ramp ? { ramp } : {}),
      ...(fx.length ? { fx } : {}),
      ...(s.enter ? { enter: s.enter } : {}),
      sound: "generate" in src ? "off" : s.sound,
      ...(s.why ? { why: s.why } : {}),
    });
  }
  if (slowed) notes.push(`${slowed} ${slowed === 1 ? "shot was" : "shots were"} slowed down to fit ${slowed === 1 ? "its" : "their"} source`);
  // a shot that went leaves no gap: the ones after it move up, counted in whole frames
  let f0 = 0;
  out.forEach((s, k) => {
    s.at = r3(f0 / fps);
    f0 += lens[k]!;
  });
  const length = f0 / fps;

  const texts: PlanText[] = (Array.isArray(raw.texts) ? raw.texts : []).filter(obj).flatMap((x) => {
    const text = str(x.text, 120);
    const a = num(x.at);
    if (!text || a === undefined || a >= length) return [];
    const place = (["top", "middle", "bottom"] as const).find((p) => p === x.place);
    const style = str(x.style, 80);
    return [{ at: r3(Math.max(0, a)), dur: r3(clamp(num(x.dur) ?? 1.5, 0.3, length - Math.max(0, a))), text, ...(place ? { place } : {}), ...(style ? { style } : {}) }];
  }).slice(0, MAX_TEXTS);

  const even = (x: number) => Math.round(x / 2) * 2;
  const w = num(raw.w);
  const h = num(raw.h);
  const own = !c.fixedSize && w && h && w >= 240 && h >= 240 && w <= 4096 && h <= 4096;
  const variation = str(raw.variation, 200);
  return {
    plan: {
      kind: str(raw.kind, 60) || "edit",
      w: own ? even(w) : c.size.w,
      h: own ? even(h) : c.size.h,
      fps,
      lead: song ? { type: "song", source: song.id, startS: beat!.startS } : { type: "sources" },
      shots: out,
      ...(texts.length ? { texts } : {}),
      ...(variation ? { variation } : {}),
    },
    notes,
  };
}

/** The footage in turn, a shot every two beats (else 3 s), until `upTo`: an edit when the AI gave none. */
function fallbackShots(c: RepairContext, upTo: number): (Omit<PlanShot, "src" | "at"> & { src: Src })[] {
  const step = c.index.song ? 120 / c.index.song.bpm : 3;
  const want = Math.min(upTo, c.targetS || 30);
  const pics = c.index.sources.filter((s) => s.w > 0);
  const out: (Omit<PlanShot, "src" | "at"> & { src: Src })[] = [];
  for (let k = 0; k * step < want && k < 400; k++) {
    if (!pics.length) {
      out.push({ src: { generate: { style: c.gen[0] ?? "" } }, dur: step, sound: "off" });
      continue;
    }
    const s = pics[k % pics.length]!;
    const turn = Math.floor(k / pics.length);
    out.push({ src: { source: s, inS: s.dur > step ? (turn * step * 3) % (s.dur - step) : 0 }, dur: step, sound: c.index.song ? "off" : "full" });
  }
  return out;
}

/* ---------------- the timeline ---------------- */

/** A generated clip's source key and file (in the edit's folder), named by what it is made from so a re-run reuses it. */
export function genFile(spec: GenSpec, size: { w: number; h: number; fps: number }): { key: string; file: string } {
  const h = createHash("sha1").update(JSON.stringify([spec, size])).digest("hex").slice(0, 12);
  return { key: `gen-${h}`, file: `gen/${h}.mp4` };
}

const describe = (s: PlanShot): string =>
  [
    s.why ?? "",
    s.ramp ? `ramp ${s.ramp.map((p) => p.speed).join("→")}` : s.speed && s.speed !== 1 ? `speed ${s.speed}` : "",
    ...(s.fx ?? []).map((f) => `${f.type} at ${(f.at ?? 0).toFixed(2)} s`),
    s.enter ? `enters with a ${s.enter}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

/**
 * A plan as the draft's timeline: each shot on V1 (filling the frame, with its speed, effects and entry), its own sound
 * on A1 when it plays it, the song on A2, a marker per shot (what it is and does, for an editor that can't draw the
 * effects) and per text. `sources` holds every source the plan names, the generated clips by genFile's key.
 */
export function planTimeline(plan: EditPlan, sources: Record<string, TimelineSource>, name: string): Timeline {
  const { fps, w: W, h: H } = plan;
  const tl: Timeline = { name, fps, width: W, height: H, sources: {}, tracks: emptyTracks(), markers: [], plan: { kind: plan.kind, ...(plan.texts?.length ? { texts: plan.texts } : {}) } };
  const fr = (s: number) => Math.round(s * fps);
  let end = 0;
  plan.shots.forEach((s, k) => {
    const key = "source" in s.src ? s.src.source : genFile(s.src.generate, { w: W, h: H, fps }).key;
    const src = sources[key];
    if (!src) return;
    const rec = fr(s.at);
    const len = fr(s.at + s.dur) - rec;
    if (len <= 0) return;
    tl.sources[key] = src;
    const f = fitted(src, W, H);
    const zoom = src.w ? Math.max(W / f.w, H / f.h) : 1;
    const inF = "source" in s.src ? Math.round(s.src.inS * src.fps) : 0;
    const link = `c${k + 1}`;
    const item: Item = {
      src: key,
      in: inF,
      len,
      rec,
      link,
      ...(zoom > 1.0005 ? { zoom: r3(zoom) } : {}),
      ...(s.speed && s.speed !== 1 ? { speed: s.speed } : {}),
      ...(s.ramp ? { ramp: s.ramp } : {}),
      ...(s.fx?.length ? { fx: s.fx } : {}),
      ...(s.enter && s.enter !== "cut" ? { enter: s.enter } : {}),
    };
    tl.tracks.V1.items.push(item);
    if (s.sound && s.sound !== "off") tl.tracks.A1.items.push({ src: key, in: inF, len, rec, link, ...(s.sound === "under" ? { gainDb: UNDER_DB } : {}), ...(item.speed ? { speed: item.speed } : {}), ...(item.ramp ? { ramp: item.ramp } : {}) });
    tl.markers.push({ rec, name: `Shot ${k + 1}`, color: "BLUE", note: describe(s) });
    end = rec + len;
  });
  for (const t of plan.texts ?? []) tl.markers.push({ rec: fr(t.at), name: "Text", color: "GREEN", note: t.text });
  tl.markers.sort((a, b) => a.rec - b.rec);
  if (plan.lead.type === "song" && sources[plan.lead.source] && end) {
    const s = sources[plan.lead.source]!;
    tl.sources[plan.lead.source] = s;
    tl.tracks.A2.items.push({ src: plan.lead.source, in: Math.round(plan.lead.startS * s.fps), len: end, rec: 0, ...(plan.lead.gainDb ? { gainDb: plan.lead.gainDb } : {}) });
  }
  return tl;
}

/* ---------------- the steps ---------------- */

/** What is said in each source, with times, cut short: for a plan that may use words (a recap of a talk). */
function wordsBySource(sentences: Sentence[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of sentences) {
    const line = `[${s.s.toFixed(1)}] ${s.text}`;
    if ((out[s.src]?.length ?? 0) + line.length < 3000) out[s.src] = out[s.src] ? `${out[s.src]} ${line}` : line;
  }
  return out;
}

/** The workspace the edit was made in: its instructions, as the Workshop's writer reads them. */
async function workspaceSetup(edit: EditMeta): Promise<string> {
  const projects = await ownedProjects(edit.createdBy);
  const p = projects.find((x) => x.id === edit.projectId) ?? (projects.length === 1 ? projects[0] : undefined);
  return p ? renderInstructions(p) : "";
}

/** The frame: the edit's working size, else the first source with a picture, at its rate. */
function frameOf(edit: EditMeta, index: FootageIndex): RepairContext["size"] {
  const pic = index.sources.find((s) => s.w > 0);
  const fps = pic ? Math.round(pic.fps * 1000) / 1000 : 30;
  if (edit.size?.w && edit.size.h) return { w: edit.size.w, h: edit.size.h, fps };
  return pic ? { w: pic.w, h: pic.h, fps } : { w: 1080, h: 1920, fps };
}

/**
 * The plan step, run in the script step's place: the index, the song, the AI's plans (one per version), each checked
 * and repaired. Saves them (shots.json) and the versions (plan.json, versions with no lines: the draft step knows a
 * planned version by that), and names an unnamed edit after its kind.
 */
export async function planStep({ edit, job, signal }: StepContext, sentences: Sentence[]): Promise<void> {
  const route = aiFor(whoFor(job.actor!), "editor", "AI Editor plan");
  if (route.off) throw new NeedsKey(route.off);
  const index = await indexSources(edit.sources);
  const speaks = new Set(sentences.map((s) => s.src));
  for (const s of index.sources) s.speech = speaks.has(s.id);
  const song = songFor(edit, index);
  if (song) index.song = await songBeats(song.id, song.dur);
  // the song is what is heard, not footage to cut
  if (song) index.sources = index.sources.filter((s) => s.id !== song.id || s.w > 0);
  const size = frameOf(edit, index);
  const gen = styles();
  const setup = [await workspaceSetup(edit), styleBlock(edit.style)].filter(Boolean).join("\n\n");
  const packText = [await packInstructions(job.actor!, "editor.script", null, { ai: route }), edit.style?.skill ? await skillText(edit.createdBy, [edit.style.skill], null, { ai: route }) : ""].filter(Boolean).join("\n\n");
  const { system, user } = planPrompt({ brief: edit.brief, versions: edit.versions, targetS: edit.targetS, setup, index, words: wordsBySource(sentences), ...(song ? { song } : {}), gen, packText });
  let raws: Record<string, unknown>[];
  try {
    raws = await completeWithFallback(system, user, signal, parsePlans, route);
  } catch (e) {
    const away = macAway(e);
    if (away) throw new NeedsKey(away.message);
    throw e;
  }
  if (signal.aborted) return;
  const notes = [song ? `Cut to “${song.title}” (${song.from})` : "No song: the footage's own sound leads"];
  if (raws.length < edit.versions) notes.push(`The AI planned ${raws.length} of the ${edit.versions} versions asked for`);
  const shots: Record<string, { plan: EditPlan; notes: string[] }> = {};
  const plans = raws.slice(0, edit.versions).map((raw, k) => {
    const name = `v${k + 1}`;
    shots[name] = repairPlan(raw, { index, ...(song ? { song } : {}), targetS: edit.targetS, size, fixedSize: !!edit.size?.w, gen });
    const p = shots[name]!.plan;
    return { name, title: p.variation || `${p.kind.charAt(0).toUpperCase()}${p.kind.slice(1)}`, lines: [] };
  });
  await saveStep(edit.id, "shots", shots);
  await saveStep(edit.id, "plan", { lines: [], plans, notes });
  const kind = shots.v1?.plan.kind;
  const now = readEdit(edit.id);
  if (kind && now?.name === UNNAMED) await saveEdit({ ...now, name: `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`.slice(0, 60), byTool: [...new Set([...(now.byTool ?? []), "name" as const])] });
}

/** The draft of a planned version: its sources and generated clips, laid as a timeline. */
export async function draftPlan(edit: EditMeta, variant: string, saved: { plan: EditPlan; notes: string[] }, signal: AbortSignal): Promise<void> {
  const { plan } = saved;
  const db = libraryDb();
  const sources: Record<string, TimelineSource> = {};
  const ids = new Set(plan.shots.flatMap((s) => ("source" in s.src ? [s.src.source] : [])));
  if (plan.lead.type === "song") ids.add(plan.lead.source);
  for (const id of ids) {
    const row = db.prepare("SELECT a.title, v.probe FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(id) as { title: string; probe: string | null } | undefined;
    if (!row?.probe) throw new Error("Some footage changed since the edit was planned: run it again from analyze");
    sources[id] = sourceOf(id, row.title, JSON.parse(row.probe) as ProbeSummary);
  }
  const size = { w: plan.w, h: plan.h, fps: plan.fps };
  for (const s of plan.shots) {
    if (!("generate" in s.src) || signal.aborted) continue;
    const { key, file } = genFile(s.src.generate, size);
    const abs = path.join(editDir(edit.id), file);
    if (!existsSync(abs)) {
      await mkdir(path.dirname(abs), { recursive: true });
      await generateClip(s.src.generate, abs, size);
    }
    sources[key] = { versionId: key, name: `Generated ${s.src.generate.style}`, fps: plan.fps, tc: 0, dur: Math.round(s.src.generate.seconds * plan.fps), w: plan.w, h: plan.h, file };
  }
  if (signal.aborted) return;
  const timeline = planTimeline(plan, sources, `${edit.name} ${variant}`);
  if (!timeline.tracks.V1.items.length) throw new Error(`Nothing in ${variant}'s plan can be shown`);
  await saveDraft(edit.id, variant, { timeline, notes: saved.notes });
  await clearPasses(edit.id, variant);
}
