import type { DatabaseSync } from "node:sqlite";
import type { AssetCard } from "../../contracts/library";
import { libraryDb } from "./db";
import type { ProbeSummary } from "./media/probe";
import type { Segment } from "./transcribe";

/**
 * A-roll and B-roll. A-roll is a take where someone talks to the camera, the takes a video is built on; B-roll is
 * everything laid over them. Every video gets one while it is prepared, from what is there anyway: how much of the clip
 * is speech (the transcript's timed segments against its length), its length, and, when the AI describes the clip, the
 * AI's answer from that same call. A clip filed as A-roll (the AI Editor's footage, the A-roll folder) is A-roll.
 * A clip nobody can tell is B-roll: a wrong A-roll costs more than a missed one. Sound and pictures have no roll.
 * The roll lives on the clip (assets.roll); the A-roll folder is a smart folder that lists it ({"roll":"a"}).
 */

export type Roll = "a" | "b";

/**
 * Where the free signals call it. ponytail: thresholds set on made-up clips (roll.test.ts); tune them on real footage.
 * A: at least A_MIN_S long, speech over A_SHARE of it, A_WORDS words, A_RATE words a spoken second (talk measured 3 to
 * 3.7, a sung line 1.75: sung words come slower). B: speech under B_SHARE, or under B_WORDS words. Between: unclear.
 */
export const ROLL_RULE = { A_MIN_S: 8, A_SHARE: 0.5, A_WORDS: 20, A_RATE: 2, B_SHARE: 0.2, B_WORDS: 8 };

/** The free signals' call: "a", "b", or null when they can't tell (the AI settles it, else B). `segments` null = not transcribed. */
export function rollFromSpeech(duration: number, hasSound: boolean, segments: Segment[] | null): Roll | null {
  if (!hasSound) return "b";
  if (!segments) return null;
  const r = ROLL_RULE;
  const words = segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  // the seconds covered by speech, overlaps counted once, inside the clip
  let spoken = 0;
  let end = 0;
  for (const s of [...segments].sort((x, y) => x.start - y.start)) {
    const from = Math.max(s.start, end);
    const to = Math.min(s.end, duration);
    if (to > from) spoken += to - from;
    end = Math.max(end, s.end);
  }
  const share = duration > 0 ? spoken / duration : 0;
  if (duration >= r.A_MIN_S && share >= r.A_SHARE && words >= r.A_WORDS && words / spoken >= r.A_RATE) return "a";
  if (share < r.B_SHARE || words < r.B_WORDS) return "b";
  return null;
}

/** The free call with the AI's answer: the AI may turn an A into a B and settle an unclear clip, never make a clear B an A. */
export function decideRoll(free: Roll | null, ai: Roll | null | undefined): Roll {
  if (ai === "b") return "b";
  if (free === "a") return "a";
  return free === null && ai === "a" ? "a" : "b";
}

interface SortRow {
  asset_id: string;
  kind: string;
  filed_roll: Roll | null;
  current: number;
  probe: string | null;
  segments: string | null;
  hearing: number;
  ai: Roll | null;
}

/**
 * Sorts the clip of version `versionId` (its current version only) and stores the roll. Left as it is while the probe
 * or the transcript is still to come. Returns the roll, or null for no roll (sound, pictures, not ready).
 */
export function sortRoll(db: DatabaseSync, versionId: string): Roll | null {
  const r = db
    .prepare(
      `SELECT a.id AS asset_id, a.kind, a.filed_roll, a.current_version_id = v.id AS current, v.probe,
        (SELECT segments FROM transcripts t WHERE t.version_id = v.id) AS segments,
        EXISTS (SELECT 1 FROM jobs j WHERE j.version_id = v.id AND j.kind = 'transcribe' AND j.state IN ('queued', 'running')) AS hearing,
        (SELECT roll FROM descriptions d WHERE d.version_id = v.id AND d.source = 'ai') AS ai
       FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?`,
    )
    .get(versionId) as SortRow | undefined;
  if (!r?.current || !r.probe) return null;
  const p = JSON.parse(r.probe) as ProbeSummary;
  let roll: Roll | null = null;
  if (r.kind === "video" && p.vcodec && !p.cover) {
    if (r.filed_roll) roll = r.filed_roll;
    else if (r.hearing) return null;
    else roll = decideRoll(rollFromSpeech(p.duration, !!p.acodec, r.segments ? (JSON.parse(r.segments) as Segment[]) : null), r.ai);
  }
  db.prepare("UPDATE assets SET roll = ? WHERE id = ?").run(roll, r.asset_id);
  return roll;
}

/** The jobs after which a clip is sorted again: what they add is what the rule reads. */
const SORTED_AFTER = new Set(["probe", "transcribe", "describe"]);

/** The library worker's hook, after each job: sorts the clip again when the job added what the rule reads. Never throws. */
export function sortAfter(job: { kind: string; version_id: string | null }): void {
  if (!job.version_id || !SORTED_AFTER.has(job.kind)) return;
  try {
    sortRoll(libraryDb(), job.version_id);
  } catch (e) {
    console.error("[library] roll:", e);
  }
}

/** Every video not sorted yet, sorted from what it already has (no AI, no key): once when the worker starts. Returns how many got a roll. */
export async function sortUnsorted(db: DatabaseSync = libraryDb()): Promise<number> {
  let n = 0;
  let after = "";
  try {
    for (;;) {
      const rows = db
        .prepare(
          `SELECT a.id, a.current_version_id AS v FROM assets a JOIN asset_versions v ON v.id = a.current_version_id
           WHERE a.kind = 'video' AND a.roll IS NULL AND v.probe IS NOT NULL AND a.id > ? ORDER BY a.id LIMIT 200`,
        )
        .all(after) as { id: string; v: string }[];
      if (!rows.length) return n;
      for (const r of rows) if (sortRoll(db, r.v)) n++;
      after = rows[rows.length - 1]!.id;
      await new Promise((ok) => setImmediate(ok)); // a big library never holds the server up
    }
  } catch (e) {
    console.error("[library] roll:", e);
    return n;
  }
}

/** The roll a smart folder lists, when its saved query is a roll and nothing else (the A-roll folder). */
export function rollFolder(db: DatabaseSync, libraryId: string, collectionId: string): Roll | null {
  const row = db.prepare("SELECT query FROM collections WHERE id = ? AND library_id = ? AND kind = 'smart'").get(collectionId, libraryId) as { query: string | null } | undefined;
  const q = row?.query ? (JSON.parse(row.query) as Record<string, unknown>) : null;
  return q && Object.keys(q).length === 1 && (q.roll === "a" || q.roll === "b") ? q.roll : null;
}

/** Files a video as `roll` for good (the AI Editor's footage, a clip put in the A-roll folder): no sort changes it. */
export function fileRoll(db: DatabaseSync, assetId: string, roll: Roll): void {
  db.prepare("UPDATE assets SET filed_roll = ?, roll = ? WHERE id = ? AND kind = 'video'").run(roll, roll, assetId);
}

type RollCard = Pick<AssetCard, "kind" | "roll" | "state" | "durationS" | "width">;

/** Cards counted: A-roll, B-roll, clips still being sorted (a video not failed, before its probe or with a picture), other files. */
export function rollCount(cards: RollCard[]): { a: number; b: number; left: number; other: number } {
  const a = cards.filter((c) => c.roll === "a").length;
  const b = cards.filter((c) => c.roll === "b").length;
  const left = cards.filter((c) => c.kind === "video" && !c.roll && c.state !== "failed" && (!c.durationS || !!c.width)).length;
  return { a, b, left, other: cards.length - a - b - left };
}

/** The one line that tells a person what was added: "12 clips added: 3 A-roll, 9 B-roll". */
export function rollLine(cards: RollCard[]): string {
  const { a, b, left, other } = rollCount(cards);
  const clips = a + b + left;
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (!clips) return `${n(other, "file", "files")} added`;
  const parts = left === clips ? ["still being sorted into A-roll and B-roll"] : [a && `${a} A-roll`, b && `${b} B-roll`, left && `${left} still being sorted`].filter(Boolean);
  return `${n(clips, "clip", "clips")} added: ${parts.join(", ")}${other ? `. ${n(other, "other file", "other files")} added too` : ""}`;
}
