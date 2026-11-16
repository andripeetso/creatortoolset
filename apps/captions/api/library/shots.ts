import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { aiFor } from "../ai-complete";
import { completeVisionWithFallback } from "../ai-vision";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { contextStamp, stampOf, workspaceContext } from "../lib/workshop/context";
import { blobs, librarySetting } from "./db";
import { WORKSPACE_MAX, whoFor, workspaceIdOf } from "./describe";
import { enqueueJob, prepareFirst } from "./jobs";
import { clock, FRAME_H, FRAME_W, lookPrompt, parseRated, pictureHash, readPicture, SHEET_STRETCHES, shotsOf, STRETCH_COLS, STRETCH_FRAMES, stretchSheet, type RatedLine } from "./look";
import { ffmpegSlot } from "./media/run";
import type { ProbeSummary } from "./media/probe";
import { storeLines, storeStretches, type StretchLine } from "./stretches";
import { NeedsKey } from "./transcribe";

/**
 * The library's `look` job: shot descriptions (tasks/flywheel/PLAN.md 2.3). A video that isn't a talking take and is
 * longer than LOOK_MIN_S gets a line for each stretch of its picture (a cut, or a long take split where it changes
 * most: look.ts shotsOf), written by the person's own AI from contact sheets with the workspace's context, routed as
 * the description is (describe.ts). It reads the same file the description read: the proxy when there is one, else
 * the original. The sheets are kept (a 'looksheets' derivative), so the lines can be written again under a new context
 * without reading the video (redoLook). A file kept on a Mac is not read here: its look waits for that Mac, which reads
 * it and sends the sheets for the AI's call only (mac-look.ts, lookFromSheets).
 * Each row keeps the stretch's motion (look.ts shotsOf), but motion is not action: walking scrolls the whole picture,
 * so dull stretches moved about twice as much as fights (measured 2026-11-15). Nothing here ranks or filters by it.
 */

/** What the usage tally counts a shot description call as (estimate.ts reads its average cost back). */
export const LOOK_LABEL = "Media Library shot descriptions";
/** The look prompt's version, in its context stamp: a change that should describe shots again bumps it. */
export const LOOK_VERSION = "look-1";
/** A clip this long or shorter keeps its description as its only line. */
export const LOOK_MIN_S = 8;
/** Sheets in one AI call, as the AI Editor sends them: up to SHEETS_PER_CALL × SHEET_STRETCHES stretches a call. */
export const SHEETS_PER_CALL = 6;
/** The kept sheets' format (look.ts stretchSheet): sheets of another format are made again from the video, and a Mac's are refused (mac-look.ts). */
export const SHEET_FORMAT = `${STRETCH_FRAMES}x${SHEET_STRETCHES}`;
/** Why a look of a file kept on a Mac waits (estimate.ts progress tells these apart by it). */
export const MAC_WAITS = "Waits for the Mac this file is on to read its picture";

/** One sheet: the stretches on it, in reading order, and its JPEG (base64). */
export interface LookSheet {
  segs: number[];
  jpeg: string;
}

/** The kept sheets of a version. */
interface KeptSheets {
  format: string;
  sheets: LookSheet[];
}

/**
 * Queues a look for `versionId` when it gets one: a video (not a talking take, by the library's roll and the AI's own
 * answer) longer than LOOK_MIN_S, in a library with shot descriptions on. True when queued. `again`: a look that is done
 * runs again (from its kept sheets, only the lines written under another stamp: the AI Editor's gate asks this).
 */
export function queueLook(db: DatabaseSync, versionId: string, actor: string | null, again = false): boolean {
  const r = db
    .prepare(
      `SELECT a.library_id, a.kind, a.roll, v.probe, (SELECT roll FROM descriptions d WHERE d.version_id = v.id AND d.source = 'ai') AS ai
       FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?`,
    )
    .get(versionId) as { library_id: string; kind: string; roll: string | null; probe: string | null; ai: string | null } | undefined;
  if (!r || r.kind !== "video" || r.roll !== "b" || r.ai === "a") return false;
  const duration = Number((JSON.parse(r.probe ?? "null") as ProbeSummary | null)?.duration) || 0;
  if (duration <= LOOK_MIN_S || !librarySetting(r.library_id, "look")) return false;
  enqueueJob(db, r.library_id, versionId, "look", actor, again);
  return true;
}

/**
 * The stamp a file's shot descriptions are written under: its workspace's context as the look reads it, and the look
 * prompt's version. A line with another stamp is written again (writeLines); the AI Editor's gate compares with this.
 */
export async function lookStamp(db: DatabaseSync, versionId: string): Promise<string> {
  return contextStamp(await workspaceIdOf(db, versionId), WORKSPACE_MAX, LOOK_VERSION);
}

/**
 * An edit waits on these files: their queued looks and descriptions go before the others' for the next ten minutes
 * (jobs.ts prepareFirst; the editor's gate calls this each time it checks). A look held for the plan's limit still waits for it.
 */
export function lookFirst(versionIds: string[]): void {
  for (const v of versionIds) prepareFirst(v);
}

/**
 * The look job for one version, as its actor: the route first (no picture is read without one), then the picture
 * read, stretches found and sheets made and kept, unless kept sheets are there already (a look that stopped at a usage
 * limit picks up there), then the lines.
 */
export async function lookVersion(db: DatabaseSync, versionId: string, src: () => Promise<string>, p: ProbeSummary, actor: string | null, scratch: string): Promise<void> {
  needLookRoute(actor);
  const kept = (await keptSheets(db, versionId)) ?? (await readAndKeep(db, versionId, await src(), p, scratch));
  await writeLines(db, versionId, actor, kept);
}

/** Parks the look (NeedsKey) when no one runs it or their AI isn't connected: no picture is read for nothing. */
export function needLookRoute(actor: string | null): asserts actor is string {
  if (!actor) throw new NeedsKey("No one to run this as: queue it again from the library");
  const route = aiFor(whoFor(actor), "analyzer", LOOK_LABEL);
  if (route.off) throw new NeedsKey(route.off);
}

/**
 * The lines of a file kept on a Mac, from the sheets that Mac made and sent (mac-look.ts): asked as the server's own look
 * asks, only for the stretches whose line is missing or stale. The sheets are never written here. Returns the AI calls.
 */
export async function lookFromSheets(db: DatabaseSync, versionId: string, actor: string | null, sheets: LookSheet[]): Promise<number> {
  needLookRoute(actor);
  return writeLines(db, versionId, actor, { format: SHEET_FORMAT, sheets });
}

/**
 * Writes the lines again from the kept sheets, under the workspace's context as it is now, without reading the video:
 * only the stretches whose line was written under another context or prompt. Returns the AI calls it made, or null
 * when no sheets are kept (queue a look instead).
 */
export async function redoLook(db: DatabaseSync, versionId: string, actor: string): Promise<number | null> {
  const kept = await keptSheets(db, versionId);
  return kept ? writeLines(db, versionId, actor, kept) : null;
}

async function readAndKeep(db: DatabaseSync, versionId: string, file: string, p: ProbeSummary, scratch: string): Promise<KeptSheets> {
  const found = shotsOf(await readPicture(file, p.fps), p.duration);
  const turned = p.rotation === 90 || p.rotation === 270;
  const landscape = (turned ? p.height : p.width) >= (turned ? p.width : p.height);
  const dir = path.join(scratch, `look-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  try {
    // ponytail: a seek per frame (13 sheets of a heavy 20-minute 720p file: 102 s); one decode of the whole file that
    // keeps the frames asked for, if the sheets ever take longer than the AI's calls (12 to 17 minutes an hour)
    const kept: KeptSheets = { format: SHEET_FORMAT, sheets: [] };
    const ph: string[] = [];
    for (let i = 0; i < found.length; i += SHEET_STRETCHES) {
      const out = path.join(dir, `${i}.jpg`);
      const these = found.slice(i, i + SHEET_STRETCHES);
      await stretchSheet(file, these, p.duration, landscape, out);
      ph.push(...(await sheetHashes(out, these.length, landscape)));
      kept.sheets.push({ segs: these.map((_, k) => i + k), jpeg: (await readFile(out)).toString("base64") });
    }
    storeStretches(db, versionId, found.map((s, i) => ({ ...s, ph: ph[i] })));
    const json = path.join(dir, "sheets.json");
    await writeFile(json, JSON.stringify(kept));
    const { library_id } = db.prepare("SELECT a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(versionId) as { library_id: string };
    const key = `libraries/${library_id}/v/${versionId}/looksheets.json`;
    const { bytes } = await blobs.put(key, json);
    db.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'looksheets', ?, ?)").run(versionId, key, bytes);
    return kept;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function keptSheets(db: DatabaseSync, versionId: string): Promise<KeptSheets | null> {
  const row = db.prepare("SELECT storage_key FROM derivatives WHERE version_id = ? AND kind = 'looksheets'").get(versionId) as { storage_key: string | null } | undefined;
  if (!row?.storage_key) return null;
  try {
    const kept = JSON.parse(await readFile(await blobs.localCopy(row.storage_key), "utf-8")) as KeptSheets;
    return kept.format === SHEET_FORMAT && Array.isArray(kept.sheets) ? kept : null;
  } catch {
    return null; // gone or unreadable: the picture is read again
  }
}

/**
 * Asks the actor's AI for the lines of every sheet with a stretch still to write under today's context (a line with
 * the current stamp stays), SHEETS_PER_CALL sheets a call, and stores each call's lines as they come: a limit midway
 * keeps what was written. A call that leaves stretches without a line is asked once more for those only, with the
 * sheets they are on (a measured call answered 1 of its 23); a stretch still without one is asked for on the next run.
 * Returns the calls made.
 */
async function writeLines(db: DatabaseSync, versionId: string, actor: string, kept: KeptSheets): Promise<number> {
  const who = whoFor(actor);
  const route = aiFor(who, "analyzer", LOOK_LABEL);
  if (route.off) throw new NeedsKey(route.off);
  const wsId = await workspaceIdOf(db, versionId);
  const workspace = wsId ? await workspaceContext(wsId, WORKSPACE_MAX) : "";
  // the stamp of the text these calls send (lookStamp's, read once)
  const stamp = stampOf(workspace, LOOK_VERSION);
  const rows = new Map(
    (db.prepare("SELECT seg, a, b, text, stamp FROM stretches WHERE version_id = ? AND source = 'ai'").all(versionId) as { seg: number; a: number; b: number; text: string; stamp: string | null }[]).map(
      (r) => [r.seg, r],
    ),
  );
  const todo = kept.sheets.filter((sh) => sh.segs.some((s) => rows.has(s) && !(rows.get(s)!.text && rows.get(s)!.stamp === stamp)));
  if (!todo.length) return 0;
  const { title } = db.prepare("SELECT a.title FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(versionId) as { title: string };
  let calls = 0;
  /** One call on `batch`, numbered from 1 across it; `only`: the tile numbers it answers for (the second ask). */
  const ask = async (batch: KeptSheets["sheets"], only?: number[]) => {
    const bySeg = new Map<number, number>();
    let n = 0;
    const lines = batch.map((sh, k) => {
      const tiles = sh.segs.map((s) => {
        bySeg.set(++n, s);
        const r = rows.get(s);
        return `${n} (${r ? `${clock(r.a)}–${clock(r.b)}` : "?"})`;
      });
      return `Picture ${k + 1}: from “${title}”. Its tiles, left to right, top to bottom, are shots ${tiles.join(", ")} (each tile: the shot's start, middle and end, side by side)`;
    });
    if (only) lines.push(`Answer only for shots ${only.join(", ")}.`);
    const { system, user } = lookPrompt(lines, false, workspace, true);
    const parse = only ? (t: string) => parseRated(t, true) : parseRated;
    const { value } = await completeVisionWithFallback(system, user, batch.map((sh) => ({ jpegBase64: sh.jpeg })), undefined, parse, who, { label: LOOK_LABEL, background: true, preferKey: true });
    calls++;
    const out: StretchLine[] = [];
    for (const [k, line] of Object.entries(value) as [string, RatedLine][]) {
      const seg = bySeg.get(Number(k));
      if (seg !== undefined && (!only || only.includes(Number(k)))) out.push({ seg, ...line });
    }
    storeLines(db, versionId, stamp, out);
    const got = new Set(out.map((l) => l.seg));
    const done = (s: number) => !!rows.get(s)?.text && rows.get(s)!.stamp === stamp;
    return [...bySeg].filter(([, s]) => !got.has(s) && !done(s)).map(([, s]) => s);
  };
  for (let c = 0; c < todo.length; c += SHEETS_PER_CALL) {
    const batch = todo.slice(c, c + SHEETS_PER_CALL);
    const missing = new Set(await ask(batch));
    if (!missing.size) continue;
    const again = batch.filter((sh) => sh.segs.some((s) => missing.has(s)));
    // the numbers the second ask gives the missing stretches: the same tiles, numbered across its own sheets
    const numbers = again.flatMap((sh) => sh.segs).flatMap((s, i) => (missing.has(s) ? [i + 1] : []));
    await ask(again, numbers);
  }
  return calls;
}

/**
 * The picture hash (look.ts pictureHash) of each stretch's middle frame, read off its sheet (the middle of the tile's
 * three frames, already small): one short ffmpeg run a sheet and no seek in the video. Seeking the video for each
 * middle frame took 105 s for the 200 stretches of a 20-minute file, the sheets themselves 107 s.
 */
export async function sheetHashes(sheet: string, count: number, landscape: boolean): Promise<string[]> {
  const [w, h] = landscape ? [FRAME_W, FRAME_H] : [FRAME_H, FRAME_W];
  const cols = landscape ? STRETCH_COLS.landscape : STRETCH_COLS.portrait;
  const crops = Array.from({ length: count }, (_, k) => {
    const x = (k % cols) * STRETCH_FRAMES * (w + 8) + (w + 8) + 4;
    const y = Math.floor(k / cols) * (h + 8) + 4;
    return `[t${k}]crop=${w}:${h}:${x}:${y},scale=9:8:flags=area,format=gray${count > 1 ? `[h${k}]` : ""}`;
  });
  const graph =
    `[0:v]split=${count}${Array.from({ length: count }, (_, k) => `[t${k}]`).join("")};${crops.join(";")}` +
    (count > 1 ? `;${crops.map((_, k) => `[h${k}]`).join("")}hstack=inputs=${count}` : "");
  const raw = await ffmpegSlot(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        const p = spawn(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", sheet, "-filter_complex", graph, "-frames:v", "1", "-f", "rawvideo", "pipe:1"]);
        const parts: Buffer[] = [];
        let err = "";
        p.stdout.on("data", (d: Buffer) => parts.push(d));
        p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
        p.on("error", reject);
        p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(parts)) : reject(new Error(err.trim() || `ffmpeg exited ${code}`))));
      }),
  ).catch(() => Buffer.alloc(0));
  // one row of 9 × count grey pixels after another, eight rows: tile k's row y starts at (y × count + k) × 9
  if (raw.length !== count * 72) return Array.from({ length: count }, () => "");
  return Array.from({ length: count }, (_, k) => pictureHash(Uint8Array.from({ length: 72 }, (_, i) => raw[(Math.floor(i / 9) * count + k) * 9 + (i % 9)]!)));
}
