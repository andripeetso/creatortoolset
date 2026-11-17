import type { DatabaseSync } from "node:sqlite";
import { STRETCH_TEXT_MAX, type LookLevel, type PictureSignal, type Stretch } from "../../contracts/library";
import { shotsOf } from "./look";

/**
 * A video's shot descriptions (contracts/library.ts Stretch; table `stretches`, migration 21), in order. Where the
 * person wrote their own line for a stretch, theirs is the one returned. Empty until the library's `look` job ran.
 */
export function stretchesOf(db: DatabaseSync, versionId: string): Stretch[] {
  const rows = db
    .prepare("SELECT * FROM stretches WHERE version_id = ? ORDER BY seg, source = 'user' DESC")
    .all(versionId) as {
    version_id: string;
    seg: number;
    a: number;
    b: number;
    motion: number;
    action: number | null;
    clear: number | null;
    tags: string;
    text: string;
    ph: string | null;
    source: string;
    stamp: string | null;
  }[];
  const out: Stretch[] = [];
  for (const r of rows) {
    if (out.length && out[out.length - 1]!.seg === r.seg) continue;
    let tags: string[] = [];
    try {
      const t = JSON.parse(r.tags) as unknown;
      if (Array.isArray(t)) tags = t.filter((x): x is string => typeof x === "string");
    } catch {
      /* a bad tags cell reads as none */
    }
    out.push({
      versionId: r.version_id,
      seg: r.seg,
      a: r.a,
      b: r.b,
      motion: r.motion,
      action: r.action ?? 0,
      clear: r.clear === 1,
      tags,
      text: r.text,
      ph: r.ph ?? "",
      source: r.source === "user" ? "user" : "ai",
      stamp: r.stamp ?? "",
    });
  }
  return out;
}

/** A video's stretches as found in its picture (look.ts shotsOf), each with the picture hash of its middle frame. */
export interface FoundStretch {
  a: number;
  b: number;
  motion: number;
  ph?: string | null;
}

/** One line for a stretch, checked (look.ts ratedLine) and with the hash of its middle frame when the writer has it. */
export interface StretchLine {
  seg: number;
  text: string;
  action: number;
  clear: boolean;
  tags: string[];
  ph?: string;
}

/**
 * Stores the stretches found in a version's picture at `level`, in order and with no line yet: the AI's rows found
 * before go (stretches are found again only when the picture is read again); the person's own lines stay. The
 * shots' picture vectors go with them (pictures.ts makes them again from the new sheets).
 */
export function storeStretches(db: DatabaseSync, versionId: string, found: FoundStretch[], level: LookLevel = "standard"): void {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM stretches WHERE version_id = ? AND source = 'ai'").run(versionId);
    db.prepare("UPDATE asset_versions SET look_level = ? WHERE id = ?").run(level === "standard" ? null : level, versionId);
    db.prepare("DELETE FROM pictures WHERE version_id = ? AND seg >= 0").run(versionId);
    const add = db.prepare("INSERT INTO stretches (version_id, seg, a, b, motion, ph, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'ai', ?)");
    const now = Date.now();
    found.forEach((s, seg) => add.run(versionId, seg, s.a, s.b, s.motion, s.ph || null, now));
    indexStretches(db, versionId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Writes the AI's lines on stretches already stored, under the context `stamp` they were written with. Returns how many it wrote. */
export function storeLines(db: DatabaseSync, versionId: string, stamp: string, lines: StretchLine[]): number {
  let n = 0;
  db.exec("BEGIN");
  try {
    const put = db.prepare(
      "UPDATE stretches SET text = ?, action = ?, clear = ?, tags = ?, ph = COALESCE(?, ph), stamp = ?, created_at = ? WHERE version_id = ? AND seg = ? AND source = 'ai'",
    );
    const now = Date.now();
    for (const l of lines) n += Number(put.run(l.text, l.action, l.clear ? 1 : 0, JSON.stringify(l.tags), l.ph || null, stamp, now, versionId, l.seg).changes);
    indexStretches(db, versionId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return n;
}

/**
 * The person's own line for a stretch, which wins over the AI's (stretchesOf); empty removes it and the AI's shows
 * again. It keeps the AI's action, tags and picture hash: the person corrects the words. False when there is no such stretch.
 */
export function setUserLine(db: DatabaseSync, versionId: string, seg: number, text: string): boolean {
  const t = text.trim().replace(/\s+/g, " ").slice(0, STRETCH_TEXT_MAX);
  if (!db.prepare("SELECT 1 FROM stretches WHERE version_id = ? AND seg = ? AND source = 'ai'").get(versionId, seg)) return false;
  if (t)
    db.prepare(
      `INSERT OR REPLACE INTO stretches (version_id, seg, a, b, motion, action, clear, tags, text, ph, source, stamp, created_at)
       SELECT version_id, seg, a, b, motion, action, clear, tags, ?, ph, 'user', NULL, ? FROM stretches WHERE version_id = ? AND seg = ? AND source = 'ai'`,
    ).run(t, Date.now(), versionId, seg);
  else db.prepare("DELETE FROM stretches WHERE version_id = ? AND seg = ? AND source = 'user'").run(versionId, seg);
  indexStretches(db, versionId);
  return true;
}

/** Rewrites a version's rows in search_stretches from the lines shown (the person's where they wrote one). */
export function indexStretches(db: DatabaseSync, versionId: string): void {
  db.prepare("DELETE FROM search_stretches WHERE version_id = ?").run(versionId);
  const add = db.prepare("INSERT INTO search_stretches (version_id, seg, text, tags) VALUES (?, ?, ?, ?)");
  for (const s of stretchesOf(db, versionId)) if (s.text) add.run(versionId, s.seg, s.text, s.tags.join(" "));
}

/** The most frames a picture read elsewhere may send (six hours at 30 a second). */
export const MAX_SIGNAL_FRAMES = 6 * 3600 * 30;
const nums = (x: unknown, n: number) => Array.isArray(x) && x.length === n && x.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);

/** A picture as numbers, checked (contracts PictureSignal): the same count of each, finite and not negative. */
export function parseSignal(body: unknown): PictureSignal | string {
  const b = (body ?? {}) as Record<string, unknown>;
  const fps = Number(b.fps);
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) return "fps must be between 1 and 120";
  const n = Array.isArray(b.step) ? b.step.length : -1;
  if (n < 1 || n > MAX_SIGNAL_FRAMES) return `step must hold 1 to ${MAX_SIGNAL_FRAMES} frames`;
  if (!nums(b.step, n) || !nums(b.cut, n) || !nums(b.lag, n)) return "step, cut and lag must be as long as each other, of numbers 0 or more";
  return { fps, step: b.step as number[], cut: b.cut as number[], lag: b.lag as number[] };
}

/**
 * A picture read on another computer (the studio's worker, a Mac with the file): its stretches found as the server finds
 * its own (look.ts shotsOf, D4) at the library's level and stored with no line yet (storeStretches), answered in order.
 */
export function takeSignal(db: DatabaseSync, versionId: string, duration: number, x: PictureSignal, level: LookLevel = "standard"): { seg: number; a: number; b: number; motion: number }[] {
  const read = { fps: x.fps, step: Float32Array.from(x.step), cut: Float32Array.from(x.cut), lag: Float32Array.from(x.lag) };
  const found = shotsOf(read, duration || x.step.length / x.fps, level);
  storeStretches(db, versionId, found, level);
  return found.map((s, seg) => ({ seg, a: s.a, b: s.b, motion: s.motion }));
}

/** The level a version's stored stretches were found at (storeStretches). */
export const stretchLevelOf = (db: DatabaseSync, versionId: string): LookLevel =>
  ((db.prepare("SELECT look_level FROM asset_versions WHERE id = ?").get(versionId) as { look_level: LookLevel | null } | undefined)?.look_level ?? "standard");
