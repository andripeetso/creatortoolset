import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import path from "node:path";
import type { Coverage, EditPlan, Focus, FootageIndex, GenSpec, IndexShot, IndexSource, PlanEffect, PlanFrame, PlanShot, PlanText, SongBeats } from "../../contracts/edit-plan";
import type { EditFeedback, Item, Sentence, Timeline, TimelineSource } from "../../contracts/editor";
import { SOUNDS } from "../../contracts/library";
import { aiFor, completeWithFallback } from "../ai-complete";
import { parseJsonObject } from "../lib/instagram/vision";
import { packInstructions } from "../lib/packs";
import { skillText } from "../lib/skills";
import { CONTEXT_MAX, footageProfile, workspaceContext, workspaceOf } from "../lib/workshop/context";
import { libraryDb } from "../library/db";
import { whoFor } from "../library/describe";
import { samePicture } from "../library/look";
import { PICTURE_FLOOR, pictureScores } from "../library/pictures";
import type { ProbeSummary } from "../library/media/probe";
import { NeedsKey } from "../library/transcribe";
import type { StepContext } from "./engine";
import { fitted } from "./framing";
import { clearPasses } from "./passes";
import { macAway } from "./script";
import { describeShots, focusOf, frameJunk, indexSources, isJunk, logged, songBeats, type LeftOut } from "./index";
import { measurable, readable } from "./media";
import { generateClip, styles } from "./generate";
import { editDir, ownerOf, readEdit, readStep, saveDraft, saveEdit, saveStep, sourcesWorkspace, UNNAMED, type EditMeta, type PlannedVersion } from "./store";
import { finishedProfile, styleBlock } from "./styles";
import { ask, onComputer } from "../work/on-computer";
import { emptyTracks, sourceOf } from "./timeline";
import { brollOf, librarySounds, placeSfx, sfxMoments, SFX_DB, type SfxSound } from "./sfx";

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
const FX_TYPES = new Set(["punch", "zoom", "flash", "shake", "glitch", "rgb", "blur", "invert", "strobe", "reverse", "stutter", "freeze", "zoomblur"]);
/** The effects that land on a beat when one is close. */
const HITS = new Set(["punch", "flash", "shake", "stutter", "freeze", "zoomblur"]);
const FRAMES: readonly PlanFrame[] = ["fill", "fit", "blur", "letterbox", "inset"];
export const INSET = { min: 0.3, max: 0.9, default: 0.6 };
/** Two shots from one source are at least this far apart (seconds): closer reads as the same moment twice. */
export const APART_S = 0.5;

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const HEX = /^#[0-9a-f]{6}$/i;
/** A source with a picture to cut (a song's cover art is none). */
const pictured = (s: IndexSource) => s.w > 0 && s.shots.length > 0;
/** A shot measured as badly taken (blurry, too dark, shaky: look.ts qualityOf) is picked only when nothing else is left */
const flawless = (x: IndexShot) => (x.flaws?.length ? 0 : 1);
/** Its flaws as a line's tail: ` · blurry, shaky` */
const flawTail = (x: IndexShot) => (x.flaws?.length ? ` · ${x.flaws.join(", ")}` : "");

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

/** The share of the sources' sound (songs aside) that is in sentences; with its length unknown, any sentence is all of it. */
export function speechShare(sentences: Pick<Sentence, "s" | "e">[], soundS: number): number {
  if (!(soundS > 0)) return sentences.length ? 1 : 0;
  return sentences.reduce((n, s) => n + Math.max(0, s.e - s.s), 0) / soundS;
}

/**
 * Whether this edit is planned rather than cut around speech: asked for, all its footage is B-roll, or nobody speaks in
 * it. Each source is judged on its own: one take where someone talks keeps a folder of takes and wordless clips cut
 * around what is said.
 */
export function isPlanned(edit: EditMeta, sentences: Sentence[]): boolean {
  if (edit.plan || allBroll(edit)) return true;
  const probe = libraryDb().prepare("SELECT probe FROM asset_versions WHERE id = ?");
  return !edit.sources.some((id) => {
    if (id === edit.song || isMusic(id)) return false;
    const p = JSON.parse((probe.get(id) as { probe: string | null } | undefined)?.probe ?? "null") as ProbeSummary | null;
    return speechShare(sentences.filter((s) => s.src === id), p?.acodec ? p.duration : 0) >= SPEECH_SHARE;
  });
}

/* ---------------- the song ---------------- */

export interface Song {
  id: string;
  /** where its file is in the library */
  key: string;
  title: string;
  dur: number;
  /** what the notes say about where it came from */
  from: string;
}

interface MusicRow {
  id: string;
  title: string;
  probe: string | null;
  source_key: string;
}

const songOf = (r: MusicRow, from: string): Song | null => {
  const p = JSON.parse(r.probe ?? "null") as ProbeSummary | null;
  return p?.acodec && p.duration > 1 ? { id: r.id, key: r.source_key, title: r.title, dur: p.duration, from } : null;
};

/**
 * The song an edit cuts to: the one it names (EditBrief.song), else a song among its sources, else the library's song
 * whose title the brief names, else, when nobody speaks in the footage, the library's newest song. Null: the sources'
 * own sound leads. Only a song the edit's creator may read, in the edit's own workspace.
 */
export function songFor(edit: EditMeta, index: FootageIndex): Song | null {
  const db = libraryDb();
  const row = db.prepare("SELECT v.id, a.title, v.probe, v.source_key, a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL");
  const mine = (id: string) => sourcesWorkspace(ownerOf(edit), [id]) === edit.workspaceId;
  if (edit.song && mine(edit.song)) {
    const r = row.get(edit.song) as MusicRow | undefined;
    const s = r && songOf(r, "the song the edit names");
    if (s) return s;
  }
  for (const src of index.sources) {
    if (!(isMusic(src.id) || (!pictured(src) && src.sound && !src.speech))) continue;
    const r = row.get(src.id) as MusicRow | undefined;
    const s = r && songOf(r, "a song among the sources");
    if (s) return s;
  }
  const lib = (row.get(edit.sources[0] ?? "") as { library_id: string } | undefined)?.library_id;
  if (!lib) return null;
  const rows = db
    .prepare(`SELECT v.id, a.title, v.probe, v.source_key FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE a.library_id = ? AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL AND ${musicSql} ORDER BY a.created_at DESC LIMIT 200`)
    .all(lib) as unknown as MusicRow[];
  const brief = edit.brief.toLowerCase();
  const named = rows.find((r) => r.title.trim().length >= 3 && brief.includes(r.title.trim().toLowerCase()));
  const pick = named ? songOf(named, "the song the brief names") : index.sources.some((s) => s.speech) ? null : rows.map((r) => songOf(r, "the library's newest song")).find(Boolean);
  return pick && mine(pick.id) ? pick : null;
}

/* ---------------- what the brief asks ---------------- */

/** A hard or social edit (a reel, a short, a montage to a song): SOCIAL_S long when no length is asked. */
const SOCIAL = /\b(hard[ -]?edits?|reels?|shorts?|tiktoks?|social|montages?|amv|phonk|hype|overdone|edit to (?:a|the) (?:song|beat|music))\b/i;
export const SOCIAL_S = { min: 15, max: 25 };
/** A brief that wants effects everywhere: every shot gets one, the strong hits get stacks. */
const OVERDONE = /\b(overdone|over[- ]the[- ]top|hard[ -]?edits?|lots of (?:effects|fx)|heavy (?:effects|fx)|more (?:visual )?effects|crazy|insane|maximal|chaotic)\b/i;
export const overdone = (brief: string) => OVERDONE.test(brief);

const UNIT = String.raw`(s|secs?|seconds?|mins?|minutes?)\b`;
const LIMIT = [
  // "max 25 s", "maximum 25 seconds", "no longer than 20 sec", "under 1 minute"
  new RegExp(String.raw`(?:max(?:imum)?|at most|under|no (?:longer|more) than|up to|within|less than|shorter than)\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*-?\s*${UNIT}`, "i"),
  // "25 s max", "30 seconds tops"
  new RegExp(String.raw`(\d+(?:\.\d+)?)\s*-?\s*${UNIT}\s*(?:max(?:imum)?|at most|tops)\b`, "i"),
  // "a 20-second edit", "15 s reel"
  new RegExp(String.raw`(\d+(?:\.\d+)?)\s*-?\s*${UNIT}\s+(?:long|edit|video|reel|cut|clip|short|montage)\b`, "i"),
];

/** The longest the brief allows, in seconds (0: it says none). */
export function briefMaxS(brief: string): number {
  for (const re of LIMIT) {
    const m = re.exec(brief);
    if (m) return Number(m[1]) * (m[2]!.toLowerCase().startsWith("m") ? 60 : 1);
  }
  return 0;
}

/**
 * How long the edit may be: target_s (never past what the brief allows), else the brief's own limit, else SOCIAL_S for
 * a hard or social edit. `max` 0: as long as the plan; `min` only says when it came out short.
 */
export function lengthOf(brief: string, targetS: number): { max: number; min: number; about: boolean } {
  const said = briefMaxS(brief);
  if (targetS > 0) return { max: said ? Math.min(said, targetS) : targetS, min: 0, about: !said || targetS <= said };
  if (said) return { max: said, min: 0, about: false };
  return SOCIAL.test(brief) ? { ...SOCIAL_S, about: false } : { max: 0, min: 0, about: false };
}

const STOP = new Set(["the", "and", "with", "from", "that", "this", "then", "when", "where", "footage", "clip", "clips", "video", "part", "moment", "shot", "shots", "show", "shows", "edit", "first", "start", "open", "some", "there", "it", "its", "says", "say", "like"]);
/** The brief's words worth matching against titles and descriptions. */
const wordsOf = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3 && !STOP.has(w));
// ponytail: a word matches by its first five letters (healed ~ heal), no stemming; a language with long compounds misses
const same = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && a.slice(0, 5) === b.slice(0, 5)) || (a.length >= 4 && b.startsWith(a)) || (b.length >= 4 && a.startsWith(b));
const hits = (words: string[], text?: string) => {
  if (!text) return 0;
  const t = wordsOf(text);
  return words.filter((w) => t.some((x) => same(w, x))).length;
};

const OPEN = /\b(?:start(?:s|ing)?|open(?:s|ing)?|begin(?:s|ning)?|kick(?:s|ing)? off|lead(?:s|ing)?)\s+(?:it\s+|the (?:edit|video)\s+)?(?:with|on|from)\s+([^.;!?\n]+)/i;

/**
 * Where the brief says to open ("start with S3", "start with the season zero defense footage when it says healed"):
 * the source by its tag or title, then the shot in it whose description matches the rest of the words. Else a shot
 * anywhere whose description matches. Null: the brief names no opener.
 */
export function openerOf(brief: string, index: FootageIndex): { source: IndexSource; shot?: IndexShot } | null {
  const m = OPEN.exec(brief);
  if (!m) return null;
  const said = m[1]!;
  const pics = index.sources.filter(pictured);
  const tag = /\b(?:S|[Ss]ource\s*#?|[Cc]lip\s*#?|[Vv]ideo\s*#?)(\d+)\b/.exec(said);
  const words = wordsOf(said);
  let source = tag ? index.sources[Number(tag[1]) - 1] : undefined;
  if (!source || !pictured(source)) {
    // the title whose words the brief uses most, by share of the title
    let best = 0;
    source = undefined;
    for (const s of pics) {
      const t = wordsOf(s.title.replace(/\.[a-z0-9]{2,4}$/i, ""));
      const k = t.length ? hits(t, said) / t.length : 0;
      if (k > best && k >= 0.5) [best, source] = [k, s];
    }
  }
  const rank = (s: IndexSource) => s.shots.map((x) => ({ x, n: hits(words, x.desc) })).filter((h) => h.n > 0).sort((a, b) => b.n - a.n)[0];
  if (source) return { source, ...(rank(source) ? { shot: rank(source)!.x } : {}) };
  // no source named: the best described moment, with at least two of its words (one when only one is given)
  const any = pics.flatMap((s) => (rank(s) ? [{ s, ...rank(s)! }] : [])).sort((a, b) => b.n - a.n)[0];
  return any && any.n >= Math.min(2, words.length) ? { source: any.s, shot: any.x } : null;
}

/** Shots handed to the AI per source: enough in all for a long edit, never a source's every shot. */
const POOL_MAX = 120;
const POOL_PER_SOURCE = { min: 4, max: 16 };
const POOL_GAP_S = 3;

/** How much a shot is worth showing: its motion, and how much it differs from the shots beside it (a scene change). */
function worth(shots: IndexShot[], k: number): number {
  const m = shots[k]!.motion;
  const near = [shots[k - 1], shots[k + 1]].filter((x): x is IndexShot => !!x);
  return m + 0.5 * (near.length ? Math.max(...near.map((x) => Math.abs(x.motion - m))) : 0) + (shots[k]!.desc ? 0.1 : 0);
}

/**
 * Up to `n` of a source's shots, spread over its whole length: the best of each stretch first, then the best left,
 * never two closer than POOL_GAP_S (or a 40th of the source). A shot the brief's words describe counts more, and one
 * whose picture matches the brief (its `pic`, matchPictures).
 */
export function shotPool(s: IndexSource, n: number, brief = ""): IndexShot[] {
  if (s.shots.length <= n) return s.shots.filter((x) => !isJunk(x));
  const words = wordsOf(brief);
  // junk (a map, a menu, loading, dark, a desktop) is never offered: its change is no action
  // a badly taken shot goes behind every well taken one; of two takes, the better taken counts a little more
  const score = s.shots.map((x, k) => (isJunk(x) ? -Infinity : worth(s.shots, k) + hits(words, x.desc) - 2 * (1 - flawless(x)) + 0.2 * ((x.quality ?? 1) - 1) + PIC_WEIGHT * (x.pic ?? 0)));
  const gap = Math.max(POOL_GAP_S, s.dur / 40);
  const picked: number[] = [];
  const free = (k: number) => !picked.includes(k) && picked.every((j) => Math.abs(s.shots[j]!.a - s.shots[k]!.a) >= gap);
  const byScore = s.shots.map((_, k) => k).sort((a, b) => score[b]! - score[a]!);
  const parts = Math.max(1, Math.ceil(n / 2));
  for (let p = 0; p < parts; p++) {
    const k = byScore.find((j) => s.shots[j]!.a >= (p * s.dur) / parts && s.shots[j]!.a < ((p + 1) * s.dur) / parts && free(j));
    if (k !== undefined) picked.push(k);
  }
  for (const k of byScore) if (picked.length < n && free(k) && score[k] !== -Infinity) picked.push(k);
  return picked.filter((k) => score[k] !== -Infinity).sort((a, b) => a - b).map((k) => s.shots[k]!);
}

/** What the best picture match is worth in a shot's score: a bit more than one of the brief's words in its description. */
const PIC_WEIGHT = 1.5;
/** A shot this close to the best picture match is marked for the AI as looking like the brief. */
const LOOKS_LIKE = 0.6;
const looksLike = (x: IndexShot) => ((x.pic ?? 0) >= LOOKS_LIKE ? ", looks like the brief" : "");

/**
 * Sets each shot's `pic` from the library's picture vectors (search by picture, library/pictures.ts): how close its
 * picture is to the brief, over the floor a search lists at, as a share of the best shot's. Nothing where the library
 * has no vectors for the footage or no picture model here.
 */
export async function matchPictures(index: FootageIndex, brief: string, actor: string): Promise<void> {
  for (const s of index.sources) for (const x of s.shots) delete x.pic; // an index read again for another brief
  const scores = await pictureScores(index.sources.map((s) => s.id), brief, actor).catch(() => new Map<string, { start: number; score: number }[]>());
  const best = Math.max(...[...scores.values()].flat().map((r) => r.score));
  if (!(best > PICTURE_FLOOR)) return;
  for (const s of index.sources) {
    const rows = (scores.get(s.id) ?? []).sort((p, q) => p.start - q.start);
    if (!rows.length) continue;
    // the library's stretch the shot starts in (both are found by look.ts shotsOf, from the same picture)
    for (const x of s.shots) {
      const r = rows.filter((r) => r.start <= x.a + 0.05).at(-1) ?? rows[0]!;
      x.pic = Math.max(0, (r.score - PICTURE_FLOOR) / (best - PICTURE_FLOOR));
    }
  }
}

const poolSize = (index: FootageIndex) => clamp(Math.floor(POOL_MAX / Math.max(1, index.sources.filter(pictured).length)), POOL_PER_SOURCE.min, POOL_PER_SOURCE.max);

/* ---------------- the prompt ---------------- */

const SYSTEM = `You edit a video. You get what the person asked for (the brief), how their workspace works, an index of the footage and, when a song leads, its beats. You don't watch the footage: the index tells you each source's length, picture, sound, whether someone speaks, and its shots with how much moves in each and what is seen.

Make exactly the kind of edit the brief asks for, whatever it is: a hard edit cut on the beat, a calm recap, a trailer, a music video, a montage. The brief decides the pace, the order, the effects and the texts; the workspace's setup decides the rest. Pick the moments that fit.

Write the edit as shots played one after another from 0, with no gaps. Times are seconds. When a song leads, cut on its beats (given as seconds in the edit) and land the hits (punch, flash, shake, stutter, zoomblur) on its strong beats. An effect's time is inside its shot, from 0.

Never use the same moment of a source twice: each shot is a different stretch of footage. Show each action once too: two stretches with the same thing happening (the same character casting the same skill, the same summon, the same view of a place), from one source or two, count as the same moment unless the brief asks for it again. Spread the shots over every source and over each source's whole length; the listed shots are the strongest moments, spread out for you. When the brief says what to open with, the first shot is that. Never make the edit longer than the length given.

Answer with JSON only, in this shape:
{"plans":[{"kind":"the brief's words for this kind of edit","variation":"what sets this version apart","lead":"song","shots":[{"src":"S1","in":12.5,"dur":1.0,"speed":1,"fx":[{"type":"punch","at":0,"amount":1.2}],"enter":"cut","frame":"fill","sound":"off","why":"a few words"}],"texts":[{"at":0,"dur":1.5,"text":"words on screen","place":"middle"}]}]}

- src: a source by its tag; in: where in it the shot starts (seconds); dur: how long the shot is in the edit.
- speed: 1 as filmed (0.25 to 4); or ramp, the speed over the shot's own time: [{"t":0,"speed":1},{"t":0.4,"speed":0.3}].
- fx: punch {at, amount 1.05-2}, zoom {at, dur, from, to: 1-3}, flash {at, dur, color "#rrggbb"}, shake {at, dur, amount 0-1}, glitch, rgb, blur, invert, strobe, zoomblur {at, dur, amount 0-1}, stutter {at, dur: the slice, amount: how many times it plays, 2-8}, freeze {at, dur}, reverse {} (the whole shot backwards). Several can stack on one shot. Leave out what a shot doesn't need.
- frame: how the shot sits in the frame. fill (crops to the frame, the default), fit (the whole picture on black), blur (whole, over a blurred copy of itself), letterbox (a widescreen band), inset (a smaller picture over the shot before; scale = its share of the width, 0.3-0.9). split: [{"src":"S4","in":30}] stacks 1-2 more pictures in a column with this one. Not every shot has to fill the frame.
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
  /** the generated clips' styles, each with a line saying what it looks like */
  gen: Array<{ id: string; line: string }>;
  packText?: string;
  /** a version after the first: what the person said, and the last version of each plan (by name, v1 first) */
  revise?: Revise;
}

/** What a revise reads: the person's notes, oldest first, and each version's last plan with the shots a note sits on. */
export interface Revise {
  notes: EditFeedback[];
  last: { name: string; plan: EditPlan; marked: number[] }[];
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

/** Shot lines the plan reads in all: past this, the busiest (every line with action 2 or more first, then by action, then clear; never by motion). */
export const LINES_MAX = 1500;
/** A shot line's words, cut for the plan. */
const LINE_TEXT = 100;
const LINES_HOW =
  "Shot lines: S<n> start–end (minutes:seconds) a<action: 0 nothing changes (a menu, loading, standing) … 5 a peak of the action>, clear when the main subject is easy to see, then tags and what happens. A shot's in is still seconds.";

/** Timeline lines in a plan prompt, in all; past it each source keeps its share, spread over its length. */
export const TIMELINE_MAX = 1200;
const TIMELINE_TEXT = 160;
const TIMELINE_HOW =
  "Timeline lines: t start–end (minutes:seconds), what happens there, watched with its sound: what is heard and what changes. Pick moments by these times.";

/** m:ss.d */
const mmss = (t: number) => {
  const d = Math.round(t * 10) / 10;
  return `${Math.floor(d / 60)}:${(d % 60).toFixed(1).padStart(4, "0")}`;
};

/**
 * Each source's shot descriptions from the library as plan lines (`S3 12:30.0–12:36.0 a4 clear · fight, boss · what
 * happens`), by source id; a source without them has none here. Past LINES_MAX in all, the lines with the most action
 * stay, in order.
 */
export function shotLines(index: FootageIndex): Map<string, string[]> {
  const all = index.sources.filter((s) => pictured(s) && logged(s)).flatMap((s) => s.shots.map((x) => ({ s, x })));
  // a shot that looks like the brief counts as two steps more action
  const rank = (x: IndexShot) => (x.action ?? 0) + 2 * (x.pic ?? 0);
  const keep = new Set(all.length <= LINES_MAX ? all : [...all].sort((p, q) => rank(q.x) - rank(p.x) || Number(!!q.x.clear) - Number(!!p.x.clear)).slice(0, LINES_MAX));
  const out = new Map<string, string[]>();
  for (const l of all) {
    if (!keep.has(l)) continue;
    const { x } = l;
    const text = (x.desc ?? "").replace(/\s+/g, " ").trim().slice(0, LINE_TEXT);
    const line = `${tagOf(index, l.s.id)} ${mmss(x.a)}–${mmss(x.b)} a${x.action ?? 0}${x.clear ? " clear" : ""}${looksLike(x)}${flawTail(x)}${x.tags?.length ? ` · ${x.tags.join(", ")}` : ""}${text ? ` · ${text}` : ""}`;
    out.set(l.s.id, [...(out.get(l.s.id) ?? []), line]);
  }
  return out;
}

/** Each source's timeline as plan lines (`  t 1:02.0–1:05.5 the boss falls · sound: a roar · change: a cut to a wide`), by source id. */
export function timelineLines(index: FootageIndex): Map<string, string[]> {
  const timed = index.sources.filter((s) => s.timeline?.length);
  const share = Math.max(1, Math.floor(TIMELINE_MAX / Math.max(1, timed.length)));
  const out = new Map<string, string[]>();
  for (const s of timed) {
    const all = s.timeline!;
    const kept = all.length <= share ? all : Array.from({ length: share }, (_, k) => all[Math.floor((k * all.length) / share)]!);
    out.set(
      s.id,
      kept.map((e) => `  t ${mmss(e.a)}–${mmss(e.b)} ${[e.what, e.sound && `sound: ${e.sound}`, e.change && `change: ${e.change}`].filter(Boolean).join(" · ").replace(/\s+/g, " ").slice(0, TIMELINE_TEXT)}`),
    );
  }
  return out;
}

/** The person's notes as a prompt quotes them, oldest first: where each was said, then their words as they are. */
export const noteLines = (notes: EditFeedback[]): string[] =>
  notes.map((n) => `- ${n.from === "review" ? `In Review${n.variant ? ` on ${n.variant}` : ""}${n.t !== undefined ? ` at ${n.t.toFixed(1)} s` : ""}` : `In chat${n.variant ? ` about ${n.variant}` : ""}`}: ${JSON.stringify(n.text)}`);

/** The person's notes on an edit's versions, oldest first, word for word: how every later version's prompt reads them
 * (a shot-list revise here, a talking-head script in script.ts). */
export function notesPrompt(notes: EditFeedback[]): string {
  return `What the person said about the versions so far, oldest first, in their own words (the newest says what they want now):\n${noteLines(notes).join("\n")}`;
}

/** The revise's part of the prompt: the person's notes word for word and the last version shot by shot. */
function revisePrompt(r: Revise, index: FootageIndex): string[] {
  const shot = (s: PlanShot, k: number, marked: number[]) =>
    `  ${k + 1}. ${"source" in s.src ? `${tagOf(index, s.src.source)} in ${s.src.inS.toFixed(1)}` : `generated ${s.src.generate.style}`}, ${s.dur.toFixed(2)} s${s.fx?.length ? `, ${s.fx.map((f) => f.type).join(" + ")}` : ""}${s.why ? `: ${s.why}` : ""}${marked.includes(k) ? "  ← a note sits on this shot" : ""}`;
  return [
    ...(r.notes.length ? [notesPrompt(r.notes)] : []),
    `The last version${r.last.length > 1 ? "s" : ""}, shot by shot:\n${r.last.map((l) => `${l.name}:\n${l.plan.shots.map((s, k) => shot(s, k, l.marked)).join("\n")}`).join("\n")}`,
    'Make the next version from the last one and change what the notes speak to, nothing else: in each plan\'s "shots", {"keep": n} keeps shot n of that version as it is (its source, timing and effects), and a new shot takes the place of each one that changes. Plans are in the same order as the versions above. When a note asks for a different whole (shorter, another order, another song), write all of its shots new.',
  ];
}

export function planPrompt(i: PlanInput): { system: string; user: string } {
  const parts = [`Brief:\n${i.brief.trim() || "(none: make a good edit of this footage)"}`];
  if (i.setup.trim()) parts.push(`The workspace's setup:\n${i.setup.trim()}`);
  parts.push(`Versions: ${i.versions}${i.versions > 1 ? " (each different, says how in its variation)" : ""}`);
  const len = lengthOf(i.brief, i.targetS);
  if (len.max) parts.push(len.about ? `Length: about ${len.max} seconds, never longer` : `Length: ${len.min ? `${len.min} to ` : "at most "}${len.max} seconds${len.min ? ", never longer, ending on a downbeat" : ""}`);
  const open = openerOf(i.brief, i.index);
  if (open) parts.push(`Open with: ${tagOf(i.index, open.source.id)}${open.shot ? ` at ${open.shot.a.toFixed(1)}-${open.shot.b.toFixed(1)}${open.shot.desc ? ` (${open.shot.desc})` : ""}` : ""}`);
  // only when a shot is marked: a prompt without measures stays word for word as it was
  if (i.index.sources.some((s) => s.shots.some((x) => x.flaws?.length))) parts.push("A shot marked blurry, too dark or shaky is badly taken: use it only when no other shot shows what the brief needs.");
  if (overdone(i.brief)) parts.push("Effects: overdone. Every shot gets at least one effect, the shots on strong beats get stacks of two to four (punch + flash + shake, stutter + zoomblur…), and the sizes vary (fill, fit, blur, letterbox, inset, split).");
  const n = poolSize(i.index);
  const lines = shotLines(i.index);
  const timed = timelineLines(i.index);
  const src = i.index.sources.map((s) => {
    const head = `${tagOf(i.index, s.id)} ${JSON.stringify(s.title)}: ${s.dur.toFixed(1)} s, ${pictured(s) ? `${s.w}x${s.h} at ${Math.round(s.fps)} fps` : "sound only (no picture: not a shot)"}, ${s.sound === false ? "no sound" : "sound"}${s.speech ? ", someone speaks" : ""}`;
    // the library's shot descriptions: every line (LINES_MAX in all, the busiest kept); else the strongest shots, spread out
    const own = lines.get(s.id);
    const pool = !own && pictured(s) ? shotPool(s, n, i.brief) : [];
    const shots = own ?? pool.map((x) => `  ${x.a.toFixed(1)}-${x.b.toFixed(1)} motion ${x.motion.toFixed(2)}${looksLike(x)}${flawTail(x)}${x.desc ? `: ${x.desc}` : ""}`);
    if (own && own.length < s.shots.length) shots.unshift(`  ${own.length} of its ${s.shots.length} shot lines (the busiest):`);
    else if (!own && pool.length < s.shots.length) shots.unshift(`  ${pool.length} of its ${s.shots.length} shots:`);
    const said = i.words[s.id] ? [`  said: ${i.words[s.id]}`] : [];
    const t = timed.get(s.id) ?? [];
    if (t.length && t.length < s.timeline!.length) t.unshift(`  ${t.length} of its ${s.timeline!.length} timeline lines:`);
    return [head, ...shots, ...t, ...said].join("\n");
  });
  if (lines.size) parts.push(LINES_HOW);
  if (timed.size) parts.push(TIMELINE_HOW);
  parts.push(`Sources:\n${src.join("\n")}`);
  const b = i.index.song;
  if (i.song && b) {
    const left = i.song.dur - b.startS;
    const to = Math.min(left, (len.max || left) + 5);
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
  if (i.index.story) parts.push(`What happens across the footage, from the pictures:\n${i.index.story}`);
  if (i.revise) parts.push(...revisePrompt(i.revise, i.index));
  if (i.gen.length)
    parts.push(
      `A shot can also be a clip made from nothing, moving to the sound under it: {"generate":{"style":"one of the styles","palette":["#rrggbb"],"seed":1},"dur":2} in place of src and in. Styles:\n${i.gen.map((g) => `- ${g.id}: ${g.line}`).join("\n")}`,
    );
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
  /** the person's words: the length, the opener and how overdone it is are read from them */
  brief?: string;
  /** a revise: this version's last plan, whose shots the answer keeps by number ({"keep": n}) */
  last?: EditPlan;
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
    else if (type === "reverse") {
      if (!out.some((x) => x.type === "reverse")) out.push({ type });
    } else if (type === "stutter") {
      const times = Math.round(clamp(num(f.amount) ?? 3, 2, 8));
      out.push({ type, at, dur: r3(clamp(num(f.dur) ?? 0.1, 0.04, Math.max(0.04, Math.min(0.5, room / times)))), amount: times });
    } else if (type === "freeze") out.push({ type, at, dur: len(Math.min(0.4, room), 0.1) });
    else if (type === "zoomblur") out.push({ type, at, dur: len(Math.min(0.25, room), 0.05), amount: amount(0.6) });
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
  if (!pictured(source)) return `a shot from ${tagOf(index, source.id)}, which has no picture: left out`;
  return { source, inS };
}

/** Whether `span` seconds from `x` keep `apart` from every stretch in `taken`. */
const clearOf = (taken: Array<[number, number]>, x: number, span: number, apart: number) => taken.every(([a, b]) => x + span <= a - apart + 1e-6 || x >= b + apart - 1e-6);

/**
 * The in-point nearest `want` where `span` seconds of a source of `dur` keep `apart` (APART_S) from every stretch in
 * `taken`, or undefined when none is left. A source with shot descriptions keeps 0: its pictures are checked instead.
 */
export function freeIn(taken: Array<[number, number]>, span: number, want: number, dur: number, apart = APART_S): number | undefined {
  const fits = (x: number) => x >= -1e-9 && x + span <= dur + 1e-6 && clearOf(taken, x, span, apart);
  return [want, ...taken.flatMap(([a, b]) => [b + apart, a - apart - span]), 0, dur - span]
    .filter(fits)
    .sort((x, y) => Math.abs(x - want) - Math.abs(y - want))[0];
}

/** The picture hashes of the stretches `span` seconds from `inS` show (more than a moment of each). */
export function picturesAt(s: IndexSource, inS: number, span: number): string[] {
  const mid = inS + span / 2;
  return s.shots.filter((x) => x.ph && ((x.a <= mid && mid < x.b) || Math.min(x.b, inS + span) - Math.max(x.a, inS) > Math.min(0.2, span / 2))).map((x) => x.ph!);
}

const shownAlready = (phs: string[], shown: string[]) => phs.some((p) => shown.some((q) => samePicture(p, q)));

/**
 * The next best stretch not in the cut, for `span` seconds: one whose picture is not shown yet, with the most action,
 * then clear, then from another source than `not`, then long enough on its own. Only sources with shot descriptions.
 */
export function nextBest(index: FootageIndex, used: Map<string, Array<[number, number]>>, shown: string[], span: number, not: string): { source: IndexSource; inS: number } | undefined {
  let best: { source: IndexSource; inS: number; key: number[] } | undefined;
  const ahead = (p: number[], q: number[]) => { const k = p.findIndex((v, j) => v !== q[j]); return k >= 0 && p[k]! > q[k]!; };
  for (const s of index.sources) {
    if (!pictured(s) || !logged(s)) continue;
    for (const x of s.shots) {
      if (x.a + span > s.dur + 1e-6 || !clearOf(used.get(s.id) ?? [], x.a, span, 0) || junkAt(s, x.a, span) || shownAlready(picturesAt(s, x.a, span), shown)) continue;
      const key = [flawless(x), x.action ?? 0, x.clear ? 1 : 0, s.id !== not ? 1 : 0, x.b - x.a >= span ? 1 : 0, x.quality ?? 1];
      if (!best || ahead(key, best.key)) best = { source: s, inS: x.a, key };
    }
  }
  return best && { source: best.source, inS: best.inS };
}

/**
 * A source's shots, well taken first (no flaw: look.ts qualityOf), then by action, then clear, then how well taken, in
 * time order otherwise: how a source with shot descriptions is ranked.
 * Never by motion: in gameplay, walking moves the whole picture more than a fight does.
 */
export const byAction = (s: IndexSource): IndexShot[] =>
  [...s.shots].sort((p, q) => flawless(q) - flawless(p) || (q.action ?? 0) - (p.action ?? 0) || Number(!!q.clear) - Number(!!p.clear) || (q.quality ?? 1) - (p.quality ?? 1));

/** A moment not in the edit yet, `span` long: the best free one of the least used source, never a picture the cut shows already (`shown`). */
function spare(index: FootageIndex, used: Map<string, Array<[number, number]>>, span: number, shown: string[]): { source: IndexSource; inS: number } | undefined {
  const pics = index.sources.filter(pictured).sort((a, b) => (used.get(a.id)?.length ?? 0) - (used.get(b.id)?.length ?? 0));
  for (const s of pics)
    for (const x of logged(s) ? byAction(s) : shotPool(s, poolSize(index))) {
      const at = freeIn(used.get(s.id) ?? [], span, x.a, s.dur);
      if (at !== undefined && !junkAt(s, at, span) && !shownAlready(picturesAt(s, at, span), shown)) return { source: s, inS: at };
    }
  return undefined;
}

/** The stretch inS..inS+span of a source shows junk: an index shot it overlaps by a fifth of its length or more is
 * junk (`isJunk`: measured, or the AI saw it on the sheet). */
export function junkAt(s: IndexSource, inS: number, span: number): boolean {
  return s.shots.some((x) => isJunk(x) && Math.min(inS + span, x.b) - Math.max(inS, x.a) >= Math.max(0.2 * span, 1e-3));
}

/** The window a shot's picture is cropped to, as its frame shows it: the frame (fill), a letterbox band, a split's row;
 * null when the whole picture shows (fit, blur, inset). */
export function cropShape(s: Pick<PlanShot, "frame" | "split">, W: number, H: number): [number, number] | null {
  if (s.split?.length) return [W, H / (1 + s.split.length)];
  if (!s.frame || s.frame === "fill") return [W, H];
  return s.frame === "letterbox" ? [W, W / LETTERBOX] : null;
}

/** Each source shot's crop where its picture moves (focusOf), and a fill no window holds shown whole over a blur. */
export function placeShots(shots: PlanShot[], index: FootageIndex, W: number, H: number): number {
  const byId = new Map(index.sources.map((s) => [s.id, s]));
  let blurred = 0;
  const at = (src: { source: string; inS: number }, span: number, shape: [number, number]): ReturnType<typeof focusOf> | null => {
    const s = byId.get(src.source);
    return s && s.w ? focusOf(s, src.inS, src.inS + span, shape[0], shape[1]) : null;
  };
  const keep = (f: ReturnType<typeof focusOf> | null): { focus?: Focus } => (f && (f.x !== 0.5 || f.y !== 0.5) ? { focus: { x: f.x, y: f.y } } : {});
  for (const s of shots) {
    if (!("source" in s.src)) continue;
    delete s.focus;
    const span = sourceSpan(s.dur, s.speed ?? 1, s.ramp);
    const shape = cropShape(s, W, H);
    if (!shape) continue;
    const f = at(s.src, span, shape);
    if (f && !f.ok && !s.split?.length && (!s.frame || s.frame === "fill")) {
      s.frame = "blur";
      blurred++;
      continue;
    }
    Object.assign(s, keep(f));
    if (s.split) s.split = s.split.map((p) => ({ source: p.source, inS: p.inS, ...keep(at(p, span, shape)) }));
  }
  return blurred;
}

const ROTATION = ["punch", "zoomblur", "rgb", "shake", "zoom", "glitch", "stutter"] as const;

/** An overdone edit's shot: at least one effect, and a stack of hits on a strong beat inside it. */
function denser(fx: PlanEffect[], k: number, dur: number, hit: number | undefined): PlanEffect[] {
  const out = [...fx];
  if (!out.length) out.push(...cleanFx([{ type: ROTATION[k % ROTATION.length], at: hit ?? 0 }], dur));
  if (hit !== undefined) for (const type of ["punch", "flash", "shake"]) if (out.length < 3 && !out.some((f) => f.type === type)) out.push(...cleanFx([{ type, at: hit, dur: 0.15 }], dur));
  return out;
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
  // a revise's answer that leaves the lead out keeps the last version's: the song doesn't come in, or go, unasked
  const leadRaw = (obj(raw.lead) ? str(raw.lead.type, 20) : str(raw.lead, 20)) || c.last?.lead.type || "";
  const song = c.song && beat && leadRaw !== "sources" ? c.song : undefined;
  const left = song ? song.dur - beat!.startS : Infinity;
  if (c.song && !song) notes.push("The AI kept the footage's own sound rather than the song");

  // each shot on its own: a source that exists, a length, a speed, effects, how it sits in the frame
  type Pic = { source: IndexSource; inS: number };
  type Draft = Omit<PlanShot, "src" | "at" | "split"> & { src: Src; split?: Pic[]; kept?: PlanShot };
  const shots: Draft[] = [];
  const given = (Array.isArray(raw.shots) ? raw.shots : []).filter(obj);
  // a revise's answer is in its own order ({"keep": n} has no time): only a fresh plan is put in order by its times
  const keeps = !!c.last && given.some((s) => s.keep !== undefined);
  for (const s of keeps ? given : given.sort((a, b) => (num(a.at) ?? 0) - (num(b.at) ?? 0))) {
    if (keeps && s.keep !== undefined) {
      // a shot of the last version, copied as it was: its source, timing and effects
      const n = Math.round(num(s.keep) ?? 0);
      const k = c.last!.shots[n - 1];
      const from = k && "source" in k.src ? c.index.sources.find((x) => "source" in k.src && x.id === k.src.source) : undefined;
      if (!k || ("source" in k.src && !from)) {
        notes.push(`The AI kept shot ${n} of the last version, which ${k ? "shows footage no longer in the edit" : "it does not have"}: left out`);
        continue;
      }
      const { at: _at, split: _split, src: _src, ...rest } = k;
      shots.push({ ...rest, src: "source" in k.src ? { source: from!, inS: k.src.inS } : { generate: k.src.generate as unknown as Record<string, unknown> }, kept: k });
      continue;
    }
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
    // a generated clip is made as long as its shot: it plays as made
    const made = "generate" in src;
    const fx = cleanFx(s.fx, d);
    // a reversed shot plays its stretch backwards at one speed
    const ramp = made || fx.some((f) => f.type === "reverse") ? undefined : cleanRamp(s.ramp, d);
    const split = made ? [] : (Array.isArray(s.split) ? s.split : []).filter(obj).slice(0, 2).flatMap((x) => {
      const r = srcOf(x, c.index);
      return typeof r === "string" || "generate" in r ? [] : [r];
    });
    const frame = made || split.length ? undefined : FRAMES.find((x) => x === s.frame);
    shots.push({
      src,
      dur: d,
      speed: made ? 1 : r3(clamp(num(s.speed) ?? 1, SPEED.min, SPEED.max)),
      ...(ramp ? { ramp } : {}),
      fx,
      ...(enter && enter !== "cut" ? { enter } : {}),
      ...(frame && frame !== "fill" ? { frame } : {}),
      ...(frame === "inset" ? { scale: r3(clamp(num(s.scale) ?? INSET.default, INSET.min, INSET.max)) } : {}),
      ...(split.length ? { split } : {}),
      sound: "source" in src && src.source.sound === false ? "off" : sound,
      ...(why ? { why } : {}),
    });
  }
  if (!shots.length) {
    notes.push("The AI's plan had no shot that can be used: the footage is cut in turn instead");
    shots.push(...fallbackShots(c, song ? left : Infinity));
  }

  // the opener the brief names goes first, at the moment it names
  // (a revise starts from the last version, whose first shot the person has seen: their notes decide it)
  const open = c.brief && !c.last ? openerOf(c.brief, c.index) : null;
  if (open) {
    const from = (d: Draft) => "source" in d.src && d.src.source.id === open.source.id;
    const at = (d: Draft) => !open.shot || ("source" in d.src && d.src.inS >= open.shot.a - 1 && d.src.inS < open.shot.b);
    let k = shots.findIndex((d) => from(d) && at(d));
    if (k < 0) k = shots.findIndex(from);
    if (k !== 0 || !at(shots[0]!)) {
      const d: Draft = k >= 0 ? shots.splice(k, 1)[0]! : { src: { source: open.source, inS: 0 }, dur: shots[0]?.dur ?? 1, speed: 1, fx: [], sound: song ? "off" : "full", why: "the opener the brief asks for" };
      const inS = open.shot?.a ?? (k >= 0 && "source" in d.src ? d.src.inS : ((logged(open.source) ? byAction(open.source) : shotPool(open.source, 1))[0]?.a ?? 0));
      d.src = { source: open.source, inS };
      if (open.source.sound === false) d.sound = "off";
      shots.unshift(d);
      notes.push(`The edit opens on ${tagOf(c.index, open.source.id)} at ${inS.toFixed(1)} s, as the brief asks`);
    }
  }

  // the length: the brief's, else the plan's own; never past the song's end
  const total = shots.reduce((n, s) => n + s.dur, 0);
  const len = lengthOf(c.brief ?? "", c.targetS);
  const asked = len.max > 0 ? len.max : total;
  let end = Math.min(asked, left, total);
  const beats = beat ? beat.beats.map((b) => b - beat.startS).filter((b) => b > 0) : [];
  if (song) {
    // the end on a beat, when one is close; on a downbeat within a bar when the edit has a limit of its own
    const near = beats.reduce<number | undefined>((best, b) => (b <= Math.min(asked, left, total) + 1e-9 && (best === undefined || Math.abs(b - end) < Math.abs(best - end)) ? b : best), undefined);
    const down = len.max && !len.about ? beat!.downbeats.map((b) => b - beat!.startS).filter((b) => b > MIN_SHOT_S && b <= end + 1e-9 && end - b < 240 / beat!.bpm && b >= len.min - 1e-9).pop() : undefined;
    if (down !== undefined) end = down;
    else if (near !== undefined && end - near < 60 / beat!.bpm) end = near;
  }
  if (len.about && end < len.max - 0.5)
    notes.push(`It is ${end.toFixed(1)} s, ${len.max} s were asked for: ${left <= total && left < asked ? "the song ends there" : "the plan had no more shots"}`);
  else if (len.min && end < len.min - 0.5) notes.push(`It is ${end.toFixed(1)} s, under the ${len.min}-${len.max} s such an edit runs: ${left < len.min ? "the song ends there" : "the plan had no more shots"}`);

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
  // every stretch of a source the edit shows so far: no moment is shown twice
  const used = new Map<string, Array<[number, number]>>();
  const take = (id: string, a: number, span: number) => used.set(id, [...(used.get(id) ?? []), [a, a + span]]);
  // the pictures the cut shows so far (shot descriptions' hashes): the same picture is shown once (PLAN.md D9)
  const shown: string[] = [];
  const byId = (id: string) => c.index.sources.find((x) => x.id === id);
  // the shots a revise keeps are in the cut already: the new ones go around them
  for (const s of shots.slice(0, n)) {
    if (!s.kept || !("source" in s.kept.src)) continue;
    const span = sourceSpan(s.kept.dur, s.kept.speed, s.kept.ramp);
    take(s.kept.src.source, s.kept.src.inS, span);
    for (const p of s.kept.split ?? []) take(p.source, p.inS, span);
    const from = byId(s.kept.src.source);
    if (from) shown.push(...picturesAt(from, s.kept.src.inS, span));
  }
  const keptAt = new Set<number>();
  let repeats = 0;
  let moved = 0;
  let gone = 0;
  let junked = 0;
  const dense = overdone(c.brief ?? "");
  const strong = beat && song ? beat.strong.map((b) => b - beat.startS) : [];
  let added = 0;
  for (let k = 0; k < n; k++) {
    const s = shots[k]!;
    const a = frames[k]! / fps;
    const dur = (frames[k + 1]! - frames[k]!) / fps;
    if (s.kept) {
      // ponytail: a kept shot keeps its effects and speed as they were; a slot whose length moved (a shot before it
      // changed length) is not re-fitted
      keptAt.add(out.length);
      lens.push(frames[k + 1]! - frames[k]!);
      out.push({ ...s.kept, at: r3(a), dur: r3(dur) });
      continue;
    }
    let speed = s.speed ?? 1;
    let ramp = s.ramp?.map((p) => ({ t: r3(Math.min(p.t, dur)), speed: p.speed })).filter((p, j, all) => j === 0 || p.t > all[j - 1]!.t);
    if (ramp && ramp.length < 2) ramp = undefined;
    let src: PlanShot["src"];
    let sound = s.sound;
    let split: PlanShot["split"];
    if ("source" in s.src) {
      let { source } = s.src;
      let span = sourceSpan(dur, speed, ramp);
      if (span > source.dur) {
        // the source is shorter than the shot at its speed: slowed until it fits
        const k2 = (source.dur / span) * 0.999;
        speed = r3(speed * k2);
        ramp = ramp?.map((p) => ({ ...p, speed: r3(p.speed * k2) }));
        span = sourceSpan(dur, speed, ramp);
        slowed++;
      }
      let inS = clamp(s.src.inS, 0, Math.max(0, source.dur - span - 0.001));
      let free = freeIn(used.get(source.id) ?? [], span, inS, source.dur, logged(source) ? 0 : APART_S);
      // a map, a menu, loading or a dark stretch is never shown: another moment instead
      const junk = free !== undefined && junkAt(source, free, span);
      if (junk) {
        free = undefined;
        junked++;
      }
      if (logged(source) && (free === undefined || shownAlready(picturesAt(source, free, span), shown))) {
        // a picture the cut shows already, junk, or no room left in this source: the next best stretch not shown yet
        const other = nextBest(c.index, used, shown, span, source.id);
        if (!other) {
          gone++;
          continue;
        }
        ({ source, inS } = other);
        if (source.sound === false) sound = "off";
        if (!junk) repeats++;
      } else if (free === undefined) {
        // the source has no stretch this long left unshown (or only junk): a moment from the least used one
        const other = spare(c.index, used, span, shown);
        if (!other) {
          gone++;
          continue;
        }
        ({ source, inS } = other);
        if (source.sound === false) sound = "off";
        if (!junk) moved++;
      } else if (Math.abs(free - inS) > 1e-6) {
        inS = free;
        moved++;
      }
      take(source.id, inS, span);
      shown.push(...picturesAt(source, inS, span));
      src = { source: source.id, inS: r3(inS) };
      const pics = (s.split ?? []).flatMap((p) => {
        const at = freeIn(used.get(p.source.id) ?? [], span, clamp(p.inS, 0, Math.max(0, p.source.dur - span - 0.001)), p.source.dur, logged(p.source) ? 0 : APART_S);
        if (at === undefined) return [];
        take(p.source.id, at, span);
        return [{ source: p.source.id, inS: r3(at) }];
      });
      if (pics.length) split = pics;
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
    if (dense) {
      const hit = strong.find((b) => b >= a && b < a + dur - 0.05);
      const more = denser(fx, k, dur, hit === undefined ? undefined : hit - a);
      if (more.length > fx.length) added++;
      fx = more;
    }
    // an inset sits over the shot before it: the first shot has none
    const frame = split || (s.frame === "inset" && !out.length) ? undefined : s.frame;
    lens.push(frames[k + 1]! - frames[k]!);
    out.push({
      at: r3(a),
      dur: r3(dur),
      src,
      ...(speed !== 1 ? { speed } : {}),
      ...(ramp ? { ramp } : {}),
      ...(fx.length ? { fx } : {}),
      ...(s.enter ? { enter: s.enter } : {}),
      ...(frame ? { frame } : {}),
      ...(frame === "inset" ? { scale: s.scale ?? INSET.default } : {}),
      ...(split ? { split } : {}),
      sound: "generate" in src ? "off" : sound,
      ...(s.why ? { why: s.why } : {}),
    });
  }
  if (moved) notes.push(`${moved} ${moved === 1 ? "shot showed a moment" : "shots showed moments"} already in the edit: moved to footage not shown yet`);
  if (repeats) notes.push(`${repeats} ${repeats === 1 ? "shot showed a picture" : "shots showed pictures"} already in the edit: the next best footage not shown yet is in ${repeats === 1 ? "its" : "their"} place`);
  if (junked) notes.push(`${junked} ${junked === 1 ? "shot was" : "shots were"} on a map, a menu, a loading screen or a dark stretch: moved to action`);
  if (gone) notes.push(`${gone} ${gone === 1 ? "shot was" : "shots were"} left out: every moment long enough was already in the edit`);
  if (added) notes.push(`Effects added to ${added} ${added === 1 ? "shot" : "shots"}: an overdone edit has one on every shot and stacks on the strong beats`);
  if (dense && out.length >= 6) {
    // an overdone edit varies its sizes: at least three
    const modes = new Set(out.map((x) => (x.split ? "split" : (x.frame ?? "fill"))));
    const want = (["blur", "letterbox", "fit"] as const).filter((m) => !modes.has(m));
    let changed = 0;
    for (let k = 2; k < out.length && modes.size < 3; k += 3) {
      const x = out[k]!;
      if (x.frame || x.split || "generate" in x.src || keptAt.has(k)) continue;
      x.frame = want.shift()!;
      modes.add(x.frame);
      changed++;
    }
    if (changed) notes.push(`${changed} ${changed === 1 ? "shot is" : "shots are"} framed differently: an overdone edit uses at least three sizes`);
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
  const W = own ? even(w) : c.size.w;
  const H = own ? even(h) : c.size.h;
  // a shot a revise keeps stays as it was, its crop too
  const blurred = placeShots(out.filter((_, k) => !keptAt.has(k)), c.index, W, H);
  if (blurred) notes.push(`${blurred} ${blurred === 1 ? "shot shows" : "shots show"} the whole picture over a blur: no crop of ${blurred === 1 ? "it" : "them"} holds what moves`);
  return {
    plan: {
      kind: str(raw.kind, 60) || "edit",
      w: W,
      h: H,
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
function fallbackShots(c: RepairContext, upTo: number): (Omit<PlanShot, "src" | "at" | "split"> & { src: Src })[] {
  const step = c.index.song?.bpm ? 120 / c.index.song.bpm : 3;
  const want = Math.min(upTo, c.targetS || 30);
  const pics = c.index.sources.filter(pictured);
  const out: (Omit<PlanShot, "src" | "at" | "split"> & { src: Src })[] = [];
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
export function genFile(spec: GenSpec, size: { w: number; h: number; fps: number }, at: number): { key: string; file: string } {
  // its place on the timeline too: with a song it moves to the part of the song it plays under
  const h = createHash("sha1").update(JSON.stringify([spec, size, at])).digest("hex").slice(0, 12);
  return { key: `gen-${h}`, file: `gen/${h}.mp4` };
}

const describe = (s: PlanShot): string =>
  [
    s.why ?? "",
    s.ramp ? `ramp ${s.ramp.map((p) => p.speed).join("→")}` : s.speed && s.speed !== 1 ? `speed ${s.speed}` : "",
    ...(s.fx ?? []).map((f) => ("at" in f ? `${f.type} at ${(f.at ?? 0).toFixed(2)} s` : f.type)),
    s.enter ? `enters with a ${s.enter}` : "",
    s.frame ? `${s.frame}${s.frame === "inset" ? ` at ${Math.round((s.scale ?? INSET.default) * 100)} % of the width` : ""}` : "",
    s.split?.length ? `split with ${s.split.map((p) => `${p.source} from ${p.inS.toFixed(1)} s`).join(" and ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

/** The share of the frame's height a letterbox band takes (2.39:1 across the frame's width). */
export const LETTERBOX = 2.39;

/**
 * The main picture's zoom over the source fitted into the frame (1): what an export can carry of how the shot sits.
 * fill and split cover the frame, fit and blur show it whole, letterbox covers the band, an inset is `scale` of the width.
 */
export function frameZoom(s: Pick<PlanShot, "frame" | "scale" | "split">, f: { w: number; h: number }, W: number, H: number): number {
  if (s.split?.length || !s.frame || s.frame === "fill") return Math.max(W / f.w, H / f.h);
  if (s.frame === "letterbox") return Math.max(W / f.w, W / LETTERBOX / f.h);
  if (s.frame === "inset") return Math.min(((s.scale ?? INSET.default) * W) / f.w, (0.9 * H) / f.h);
  return 1;
}

/**
 * A plan as the draft's timeline: each shot on V1 (sized as its frame says, with its speed, effects and entry), its own sound
 * on A1 when it plays it, the song on A2, a marker per shot (what it is and does, for an editor that can't draw the
 * effects) and per text. `sources` holds every source the plan names, the generated clips by genFile's key.
 */
export function planTimeline(plan: EditPlan, sources: Record<string, TimelineSource>, name: string, sfx?: { sounds: SfxSound[]; broll: ReadonlySet<string> } | null): Timeline {
  const { fps, w: W, h: H } = plan;
  const tl: Timeline = { name, fps, width: W, height: H, sources: {}, tracks: emptyTracks(), markers: [], plan: { kind: plan.kind, ...(plan.texts?.length ? { texts: plan.texts } : {}) } };
  const fr = (s: number) => Math.round(s * fps);
  let end = 0;
  plan.shots.forEach((s, k) => {
    const key = "source" in s.src ? s.src.source : genFile(s.src.generate, { w: W, h: H, fps }, s.at).key;
    const src = sources[key];
    if (!src) return;
    const rec = fr(s.at);
    const len = fr(s.at + s.dur) - rec;
    if (len <= 0) return;
    tl.sources[key] = src;
    const f = fitted(src, W, H);
    const zoom = src.w ? frameZoom(s, f, W, H) : 1;
    const inF = "source" in s.src ? Math.round(s.src.inS * src.fps) : 0;
    const link = `c${k + 1}`;
    // the cut opens on its picture (Review shows the first frame before Play): the first shot has no entry and no white
    // flash or negative on its first frame
    const fx = rec === 0 ? s.fx?.filter((x) => !("at" in x && ["flash", "invert", "strobe"].includes(x.type) && fr(x.at ?? 0) < 1)) : s.fx;
    const enter = rec === 0 ? undefined : s.enter;
    const item: Item = {
      src: key,
      in: inF,
      len,
      rec,
      link,
      ...(Math.abs(zoom - 1) > 0.0005 ? { zoom: r3(zoom) } : {}),
      ...(s.speed && s.speed !== 1 ? { speed: s.speed } : {}),
      ...(s.ramp ? { ramp: s.ramp } : {}),
      ...(fx?.length ? { fx } : {}),
      ...(enter && enter !== "cut" ? { enter } : {}),
      ...(s.frame && s.frame !== "fill" ? { frame: s.frame } : {}),
      ...(s.focus ? { focus: s.focus } : {}),
    };
    const split = (s.split ?? []).filter((p) => sources[p.source]);
    if (split.length) {
      for (const p of split) tl.sources[p.source] = sources[p.source]!;
      item.split = split.map((p) => ({ src: p.source, in: Math.round(p.inS * sources[p.source]!.fps), ...(p.focus ? { focus: p.focus } : {}) }));
    }
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
  // sound effects (A3) only when the edit's sound set is the library's; `sfx` null places none
  if (sfx && end) {
    for (const p of placeSfx(sfxMoments(plan, sfx.broll, end / fps), sfx.sounds, fps, end)) {
      tl.sources[p.sound.versionId] = p.sound;
      tl.tracks.A3.items.push({ src: p.sound.versionId, in: 0, len: p.len, rec: p.rec, gainDb: SFX_DB });
    }
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

/**
 * The workspace the edit was made in: its instructions, every context file and as much of their text as fits `max`
 * (lib/workshop/context.ts). It is its owner's (ownerOf), also for an edit a teammate made there, looked up the one way (workspaceOf).
 */
export async function workspaceSetup(edit: Pick<EditMeta, "createdBy" | "projectId"> & { workspaceId?: string }, max: number): Promise<string> {
  if (onComputer.on) return ask("workspaceSetup", max);
  return workspaceContext(await workspaceOf(ownerOf(edit), edit.projectId), max);
}

/** The frame: the edit's working size, else the first source with a picture, at its rate. */
function frameOf(edit: EditMeta, index: FootageIndex): RepairContext["size"] {
  const pic = index.sources.find(pictured);
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
  const { route, left, song, input, repair } = await planContext(edit, job.actor!, sentences, signal);
  if (signal.aborted) return;
  const revise = reviseOf(edit);
  const { system, user } = planPrompt({ ...input, ...(revise ? { revise } : {}) });
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
  const shots: Record<string, PlannedVersion> = {};
  const plans: Array<{ name: string; title: string; lines: [] }> = [];
  for (const [k, raw] of raws.slice(0, edit.versions).entries()) {
    const name = `v${k + 1}`;
    const last = revise?.last.find((l) => l.name === name)?.plan;
    // a revise's answer may leave out what stays: the kind, the variation and the words on screen of the last version
    const answer = last ? { kind: last.kind, ...(last.variation ? { variation: last.variation } : {}), ...(last.texts ? { texts: last.texts } : {}), ...raw } : raw;
    shots[name] = repairPlan(answer, { ...repair, ...(last ? { last } : {}) });
    const swapped = await lastLook(shots[name]!.plan, repair.index, signal, last?.shots);
    if (swapped) shots[name]!.notes.push(lookedNote(swapped));
    const p = shots[name]!.plan;
    plans.push({ name, title: p.variation || `${p.kind.charAt(0).toUpperCase()}${p.kind.slice(1)}`, lines: [] });
  }
  await saveStep(edit.id, "shots", shots);
  await saveStep(edit.id, "plan", { lines: [], plans, notes, at: Date.now(), coverage: coverageOf(edit, repair.index, left, Object.values(shots).map((x) => x.plan), song?.id) });
  const kind = shots.v1?.plan.kind;
  const now = readEdit(edit.id);
  if (kind && now?.name === UNNAMED) await saveEdit({ ...now, name: `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`.slice(0, 60), byTool: [...new Set([...(now.byTool ?? []), "name" as const])] });
}

/**
 * What a plan is written from: the person's own AI, the footage index with what is seen in it (`story`: and what
 * happens across it), the song and its beats, and the prompt's and the repair's parts.
 */
async function planContext(edit: EditMeta, actor: string, sentences: Sentence[], signal: AbortSignal, story = true) {
  const route = aiFor(whoFor(actor), "editor", "Editor plan");
  if (route.off) throw new NeedsKey(route.off);
  const { left, ...found } = await indexSources(edit, signal);
  let index: FootageIndex = found;
  // speech as the script step judged it (a few words made up over music are nobody speaking), and which have sound
  const probe = libraryDb().prepare("SELECT probe FROM asset_versions WHERE id = ?");
  for (const s of index.sources) {
    s.speech = s.dur > 0 && speechShare(sentences.filter((x) => x.src === s.id), s.dur) >= SPEECH_SHARE;
    s.sound = !!(JSON.parse((probe.get(s.id) as { probe: string | null } | undefined)?.probe ?? "null") as ProbeSummary | null)?.acodec;
  }
  const song = songFor(edit, index);
  if (song) index.song = await songBeats(await measurable(song.id, song.key), 0, signal);
  // the song is what is heard, not footage to cut
  if (song) index.sources = index.sources.filter((s) => s.id !== song.id || pictured(s));
  // what is seen in each shot and across the footage, from the person's own AI looking at contact sheets (asked once per footage)
  index = await describeShots(index, { actor, story, workspace: await workspaceSetup(edit, 6000) }, signal);
  // which shots look like what the brief asks for, by their pictures (search by picture)
  if (edit.brief.trim()) await matchPictures(index, edit.brief, actor);
  const gen = styles();
  // what footage the workspace holds and what was finished in it (lib/workshop/context.ts, styles.ts); none adds nothing
  const profile = [await footageProfile(edit.projectId), await finishedProfile(ownerOf(edit), edit.projectId ?? "")].filter(Boolean).join("\n");
  const setup = [await workspaceSetup(edit, CONTEXT_MAX), profile, await styleBlock(edit.style, edit)].filter(Boolean).join("\n\n");
  const packText = [await packInstructions(actor, "editor.script", null, { ai: route }), edit.style?.skill ? await skillText(ownerOf(edit), [edit.style.skill], null, { ai: route }) : ""].filter(Boolean).join("\n\n");
  const input: PlanInput = { brief: edit.brief, versions: edit.versions, targetS: edit.targetS, setup, index, words: wordsBySource(sentences), ...(song ? { song } : {}), gen, packText };
  const repair: RepairContext = { index, ...(song ? { song } : {}), targetS: edit.targetS, size: frameOf(edit, index), fixedSize: !!edit.size?.w, gen: gen.map((g) => g.id), brief: edit.brief };
  return { route, left, song, input, repair };
}

/**
 * A version after the first (tasks/flywheel/PLAN.md 3.5): the person's notes, oldest first, and each version's last
 * plan with the shots a Review note made since sits on. Null for a first plan, or with no notes: planned as before.
 */
export function reviseOf(edit: Pick<EditMeta, "id" | "feedback">): Revise | null {
  const notes = edit.feedback ?? [];
  const before = readStep(edit.id, "shots");
  if (!notes.length || !before) return null;
  const since = readStep(edit.id, "plan")?.at ?? 0;
  const last = Object.keys(before)
    .filter((n) => /^v\d$/.test(n))
    .sort()
    .map((name) => {
      const plan = before[name]!.plan;
      // a note in Review on this version's last cut, at a time inside a shot (only shots of footage still in the edit)
      const on = notes.filter((n) => n.from === "review" && n.variant === name && n.t !== undefined && n.at >= since).map((n) => n.t!);
      const marked = plan.shots.flatMap((s, k) => (on.some((t) => t >= s.at && t < s.at + s.dur) ? [k] : []));
      return { name, plan, marked };
    });
  return last.length ? { notes, last } : null;
}

/** What footage the cut was made from: every file but the song, the ones it could pick from, the ones it uses, the ones left out. */
export function coverageOf(edit: Pick<EditMeta, "sources">, index: FootageIndex, left: LeftOut[], plans: EditPlan[], songId?: string): Coverage {
  const probe = libraryDb().prepare("SELECT probe FROM asset_versions WHERE id = ?");
  const minutes = (id: string) => ((JSON.parse((probe.get(id) as { probe: string | null } | undefined)?.probe ?? "null") as ProbeSummary | null)?.duration ?? 0) / 60;
  const files = edit.sources.filter((id) => id !== songId && !isMusic(id));
  const pooled = index.sources.filter((s) => pictured(s) && files.includes(s.id));
  const used = new Set(plans.flatMap((p) => p.shots.flatMap((s) => ["source" in s.src ? s.src.source : "", ...(s.split ?? []).map((x) => x.source)])).filter((id) => files.includes(id)));
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    files: files.length,
    minutes: r1(files.reduce((m, id) => m + minutes(id), 0)),
    pooled: pooled.length,
    pooledMinutes: r1(pooled.reduce((m, s) => m + s.dur / 60, 0)),
    used: used.size,
    left: left.filter((l) => files.includes(l.id)).map(({ title, why }) => ({ title, why })),
  };
}

/**
 * The last look before a plan is drawn, so no shot is a frame of nothing: each shot's middle frame
 * as it will show (its crop, frameJunk). One that is dark, flat or a screen of menus is moved to the best moment no
 * shot shows yet (spare: never junk, never a picture the cut shows, the bad stretch left out), its crop placed again; up to LOOKS tries a shot. Counts
 * the shots moved. A shot with no clean moment left keeps its picture; one showing a moment of `before` (the last
 * version, whose kept shots were looked at then) is left as it is.
 */
export async function lastLook(plan: EditPlan, index: FootageIndex, signal?: AbortSignal, before: PlanShot[] = []): Promise<number> {
  const db = libraryDb();
  const files = new Map<string, string>();
  const file = async (id: string) => {
    if (!files.has(id)) files.set(id, await measurable(id, (db.prepare("SELECT source_key FROM asset_versions WHERE id = ?").get(id) as { source_key: string }).source_key));
    return files.get(id)!;
  };
  const byId = new Map(index.sources.map((s) => [s.id, s]));
  const used = new Map<string, Array<[number, number]>>();
  const span = (s: PlanShot) => sourceSpan(s.dur, s.speed ?? 1, s.ramp);
  // the pictures the cut shows: a shot moved here never brings one of them back
  const pictures: string[] = [];
  for (const s of plan.shots) {
    if (!("source" in s.src)) continue;
    used.set(s.src.source, [...(used.get(s.src.source) ?? []), [s.src.inS, s.src.inS + span(s)]]);
    const at = byId.get(s.src.source);
    if (at) pictures.push(...picturesAt(at, s.src.inS, span(s)));
  }
  let moved = 0;
  // a moment the last version showed (a shot a revise keeps) was looked at then: it stays
  const shown = (s: PlanShot) => before.some((b) => "source" in b.src && "source" in s.src && b.src.source === s.src.source && b.src.inS === s.src.inS);
  for (const s of plan.shots) {
    if (!("source" in s.src) || signal?.aborted || shown(s)) continue;
    const n = span(s);
    for (let k = 0; k < LOOKS; k++) {
      const src = s.src as { source: string; inS: number };
      const at = byId.get(src.source);
      if (!at?.w) break;
      const shape = cropShape(s, plan.w, plan.h);
      // a file this server can't read keeps its picture, as an unreadable frame does (frameJunk)
      const f = await file(src.source).catch(() => "");
      if (!f || !(await frameJunk(f, src.inS + n / 2, at, shape, s.focus ?? (shape ? { x: 0.5, y: 0.5 } : undefined), signal))) break;
      const other = spare(index, used, n, pictures);
      if (!other) break;
      used.set(other.source.id, [...(used.get(other.source.id) ?? []), [other.inS, other.inS + n]]);
      pictures.push(...picturesAt(other.source, other.inS, n));
      s.src = { source: other.source.id, inS: r3(other.inS) };
      if (other.source.sound === false) s.sound = "off";
      placeShots([s], index, plan.w, plan.h);
      if (k === 0) moved++;
    }
  }
  return moved;
}

/** Tries of the last look per shot */
const LOOKS = 4;

/** What the last look moved, as the plan's notes say it. */
const lookedNote = (n: number) => `${n} ${n === 1 ? "shot's picture was" : "shots' pictures were"} dark, empty or a screen of the game's menus as cropped: another moment instead`;

/** The draft of a planned version: its sources and generated clips, laid as a timeline. */
export async function draftPlan(edit: EditMeta, variant: string, saved: PlannedVersion, signal: AbortSignal): Promise<void> {
  const { plan } = saved;
  const db = libraryDb();
  const sources: Record<string, TimelineSource> = {};
  const ids = new Set(plan.shots.flatMap((s) => ["source" in s.src ? s.src.source : "", ...(s.split ?? []).map((p) => p.source)].filter(Boolean)));
  if (plan.lead.type === "song") ids.add(plan.lead.source);
  for (const id of ids) {
    const row = db.prepare("SELECT a.title, v.probe FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(id) as { title: string; probe: string | null } | undefined;
    if (!row?.probe) throw new Error("Some footage changed since the edit was planned: run it again from analyze");
    sources[id] = sourceOf(id, row.title, JSON.parse(row.probe) as ProbeSummary);
  }
  const size = { w: plan.w, h: plan.h, fps: plan.fps };
  // a generated clip moves to the song where it plays under it; with no song it makes up its own beat (generate.ts)
  const lead = plan.lead.type === "song" ? plan.lead : null;
  const songFile = lead && plan.shots.some((s) => "generate" in s.src) ? await readable(lead.source, (db.prepare("SELECT source_key FROM asset_versions WHERE id = ?").get(lead.source) as { source_key: string }).source_key) : null;
  for (const s of plan.shots) {
    if (!("generate" in s.src) || signal.aborted) continue;
    const { key, file } = genFile(s.src.generate, size, s.at);
    const abs = path.join(editDir(edit.id), file);
    let fps = Math.round(plan.fps);
    if (!existsSync(abs)) {
      // not inside an ffmpeg turn: generateClip takes its own, twice
      const made = await generateClip(
        { ...s.src.generate, params: { ...s.src.generate.params, w: plan.w, h: plan.h, fps: plan.fps }, ...(songFile ? { audio: songFile, audioStartS: lead!.startS + s.at } : {}) },
        path.dirname(abs),
        signal,
      );
      await rename(made.path, abs);
      fps = made.fps;
    }
    sources[key] = { versionId: key, name: `Generated ${s.src.generate.style}`, fps, tc: 0, dur: Math.round(s.src.generate.seconds * fps), w: plan.w, h: plan.h, file };
  }
  if (signal.aborted) return;
  // the library's sound effects when the edit's sound set is the library's; a pack's set is not placed yet
  const lib = (db.prepare("SELECT a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(edit.sources[0] ?? "") as { library_id: string } | undefined)?.library_id;
  const sfx = edit.bundle?.sfxSet === "library" && lib ? { sounds: librarySounds(lib), broll: brollOf(plan.shots.flatMap((s) => ("source" in s.src ? [s.src.source] : []))) } : null;
  const timeline = planTimeline(plan, sources, `${edit.name} ${variant}`, sfx);
  if (!timeline.tracks.V1.items.length) throw new Error(`Nothing in ${variant}'s plan can be shown`);
  // the AI's cut waits for its look before Review (critique.ts); a plan whose cut was looked at already carries the look
  await saveDraft(edit.id, variant, { timeline, notes: saved.notes, due: 1 });
  await clearPasses(edit.id, variant);
}
