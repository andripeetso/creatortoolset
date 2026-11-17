import type { EditPlan } from "../../contracts/edit-plan";
import type { TimelineSource } from "../../contracts/editor";
import { SOUNDS } from "../../contracts/library";
import { libraryDb } from "../library/db";
import type { ProbeSummary } from "../library/media/probe";
import { sourceOf } from "./timeline";

/**
 * The sound types the Editor places. Same list as the library's sound types; it moves to contracts/sfx.ts when that
 * file lands on main.
 */
export const SFX_TYPES = ["whoosh", "swipe", "pop", "click", "hit", "riser", "ding", "glitch", "typing", "camera", "paper", "notification", "transition"] as const;
export type SfxType = (typeof SFX_TYPES)[number];
const isType = (x: string): x is SfxType => (SFX_TYPES as readonly string[]).includes(x);

/** Two sounds start at least this far apart: about one every 2 s */
export const SFX_GAP_S = 2;
/** A sound is cut to this long at most */
export const SFX_MAX_S = 2;
/** The level under the voice, a fixed gain on the A3 item */
export const SFX_DB = -12;

/** A library sound the Editor may place: its timeline source and type (null: a general sound, placed on no moment). */
export interface SfxSound {
  src: TimelineSource;
  type: SfxType | null;
}

/** A moment a sound can mark, in seconds on the cut; `types` in the order to try them; higher `prio` is kept first. */
export interface SfxMoment {
  at: number;
  prio: number;
  types: readonly SfxType[];
}

/**
 * A sound's type: its tag when one is one of the types, else the first word of its file name that is one. Words, not
 * substrings: "whitewash" is not a whoosh.
 */
export function typeOf(tags: string[], name: string): SfxType | null {
  const tag = tags.find(isType);
  if (tag) return tag;
  return name.toLowerCase().split(/[^a-z]+/).find(isType) ?? null;
}

/** The library's sound effects, as the workspace's music is found: tagged `sound effect` or in the Sound effects folder. */
const effectSql = `(EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = a.id AND t.tag = '${SOUNDS.effect.tag}')
  OR a.id IN (SELECT ci.asset_id FROM collection_items ci JOIN collections c ON c.id = ci.collection_id
    WHERE c.library_id = a.library_id AND c.parent_id IS NULL AND c.name = '${SOUNDS.effect.folder}'))`;

/** The library's sounds with a measured length, newest first (as the music lookup), each with its type. */
export function librarySounds(libraryId: string): SfxSound[] {
  const db = libraryDb();
  const rows = db
    .prepare(`SELECT v.id, a.title, v.probe, v.source_key FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE a.library_id = ? AND a.trashed_at IS NULL AND ${effectSql} ORDER BY a.created_at DESC LIMIT 200`)
    .all(libraryId) as Array<{ id: string; title: string; probe: string | null }>;
  const tagsOf = db.prepare("SELECT tag FROM asset_tags WHERE asset_id = (SELECT asset_id FROM asset_versions WHERE id = ?)");
  const out: SfxSound[] = [];
  for (const r of rows) {
    if (!r.probe) continue;
    const tags = (tagsOf.all(r.id) as Array<{ tag: string }>).map((t) => t.tag);
    const src = sourceOf(r.id, r.title, JSON.parse(r.probe) as ProbeSummary);
    if (src.dur <= 0) continue;
    out.push({ src, type: typeOf(tags, r.title) });
  }
  return out;
}

/** The version ids among `ids` whose asset is B-roll as the library sorted it. */
export function brollOf(ids: string[]): Set<string> {
  if (!ids.length) return new Set();
  const rows = libraryDb()
    .prepare(`SELECT v.id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.roll = 'b' AND v.id IN (${ids.map(() => "?").join(", ")})`)
    .all(...ids) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * The moments a plan's sound marks: a text's pop-in, a B-roll shot's start and end, and each shot's entry (flash, whip,
 * dissolve, cut). A cut at the very start and B-roll at the start have no entry, as the timeline gives none.
 */
export function sfxMoments(plan: Pick<EditPlan, "shots" | "texts">, broll: ReadonlySet<string>, endS: number): SfxMoment[] {
  const out: SfxMoment[] = [];
  for (const t of plan.texts ?? []) out.push({ at: t.at, prio: 3, types: ["pop", "click", "ding"] });
  for (const s of plan.shots) {
    const isBroll = "source" in s.src && broll.has(s.src.source);
    if (isBroll && s.at > 0) out.push({ at: s.at, prio: 2, types: ["whoosh", "swipe"] });
    if (isBroll && s.at + s.dur < endS - 0.01) out.push({ at: s.at + s.dur, prio: 2, types: ["whoosh", "swipe"] });
    if (s.at <= 0) continue;
    if (s.enter === "flash") out.push({ at: s.at, prio: 4, types: ["hit"] });
    else if (s.enter === "whip") out.push({ at: s.at, prio: 3, types: ["whoosh", "swipe"] });
    else if (s.enter === "dissolve") out.push({ at: s.at, prio: 2, types: ["transition"] });
    else if (s.enter === "cut") out.push({ at: s.at, prio: 1, types: ["transition"] });
  }
  return out;
}

export interface SfxPlaced {
  sound: TimelineSource;
  rec: number;
  len: number;
}

/**
 * Places sounds on the moments: the higher-priority moments win where two are within SFX_GAP_S; the kept ones, in time
 * order, each take a sound of their first type that has one, never the sound the moment before played. A sound runs
 * SFX_MAX_S at most and stops at the cut's end. Frames at `fps`; `endFrames`: the cut's length.
 */
export function placeSfx(moments: SfxMoment[], sounds: SfxSound[], fps: number, endFrames: number): SfxPlaced[] {
  const kept: SfxMoment[] = [];
  for (const m of [...moments].sort((a, b) => b.prio - a.prio || a.at - b.at)) {
    if (m.at < 0 || Math.round(m.at * fps) >= endFrames) continue;
    if (kept.every((k) => Math.abs(k.at - m.at) >= SFX_GAP_S)) kept.push(m);
  }
  kept.sort((a, b) => a.at - b.at);
  const uses = new Map<string, number>();
  const out: SfxPlaced[] = [];
  let prev: string | null = null;
  for (const m of kept) {
    let pick: SfxSound | undefined;
    for (const t of m.types) {
      const pool = sounds.filter((s) => s.type === t && s.src.versionId !== prev);
      if (!pool.length) continue;
      pick = pool.reduce((a, b) => ((uses.get(b.src.versionId) ?? 0) < (uses.get(a.src.versionId) ?? 0) ? b : a));
      break;
    }
    if (!pick) continue;
    const rec = Math.round(m.at * fps);
    const len = Math.min(Math.round((pick.src.dur / pick.src.fps) * fps), Math.round(SFX_MAX_S * fps), endFrames - rec);
    if (len <= 0) continue;
    uses.set(pick.src.versionId, (uses.get(pick.src.versionId) ?? 0) + 1);
    prev = pick.src.versionId;
    out.push({ sound: pick.src, rec, len });
  }
  return out;
}
