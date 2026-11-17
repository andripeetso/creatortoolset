import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import type { SearchHit } from "../../contracts/library";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { aiFor, completeWithFallback } from "../ai-complete";
import { embedPictureQuery, embedPictures, PICTURE_MODEL, PICTURE_PX, pictureModelKept, picturesHere, readsAsEnglish } from "../lib/device-picture";
import { blobs, libraryDb, librarySetting } from "./db";
import { whoFor } from "./describe";
import { cosineTop } from "./embed";
import { firstClips } from "./jobs";
import { ffmpegSlot } from "./media/run";
import { CARD, toCard, type CardRow } from "./query";
import { keptSheets, middleCrop, type LookSheet } from "./shots";
import { stretchesOf } from "./stretches";

/**
 * Search by picture: a vector of what each shot shows (lib/device-picture.ts), so a typed search, the AI Editor's B-roll
 * pick and "More like this" find footage by its picture, not only its words. Each video and photo gets one from its card
 * picture (seg -1, the whole clip), and a video the look read gets one per stretch from the middle frame of its tile on
 * the look's sheets (seg as in stretches): no second read of the video. A file kept on a Mac has its sheets read here
 * as they arrive, before the look's AI call (worker.ts); the server's own looks keep their sheets, which the catch-up
 * reads. Library setting `pictures`, only where this server makes them (picturesHere).
 */

export const CARD_SEG = -1;
/** Picture hits a search takes, as search by meaning. */
const TOP = 50;
/**
 * How close (cosine) a picture must be to a typed search to be listed, measured on 243 frames of public-domain films
 * and 25 searches in English with the shots wanted marked, and 6 that should find nothing: those 6 never scored above
 * 0.099, the best wanted shot of every search scored 0.109 or more (half of them 0.133 or more); at 0.10, 83 of the 103
 * wanted shots are listed. Typed in Estonian they list 4 of them (the model reads little Estonian), so a search not in
 * English matches pictures by its English line (pictureWords): written by an AI, they list 71, none for the 6.
 */
export const PICTURE_FLOOR = 0.1;
/** Shots "More like this" lists. */
const ALIKE = 12;

type Row = { version_id: string; seg: number; start_s: number; vec: Float32Array };
const vecOf = (b: Uint8Array) => new Float32Array(Uint8Array.from(b).buffer);

/** Width and height of a JPEG, from its frame header; null when there is none. */
export function jpegSize(b: Buffer): { w: number; h: number } | null {
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

/** The parts `crops` (ffmpeg filters, "null" for the whole) of a JPEG, each squeezed to PICTURE_PX² as the model takes it, rgb24. */
export function picturesOf(jpeg: Buffer, crops: string[]): Promise<Uint8Array[]> {
  const n = crops.length;
  const each = (k: number) => `${crops[k]},scale=${PICTURE_PX}:${PICTURE_PX}:flags=bilinear,format=rgb24`;
  const graph =
    n === 1
      ? `[0:v]${each(0)}`
      : `[0:v]split=${n}${crops.map((_, k) => `[i${k}]`).join("")};${crops.map((_, k) => `[i${k}]${each(k)}[o${k}]`).join(";")};${crops.map((_, k) => `[o${k}]`).join("")}vstack=inputs=${n}`;
  const size = PICTURE_PX * PICTURE_PX * 3;
  return ffmpegSlot(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        const p = spawn(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-i", "pipe:0", "-filter_complex", graph, "-frames:v", "1", "-f", "rawvideo", "pipe:1"]);
        const parts: Buffer[] = [];
        let err = "";
        p.stdout.on("data", (d: Buffer) => parts.push(d));
        p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
        p.stdin.on("error", () => {}); // ffmpeg that stops early closes its input: the exit code says why
        p.on("error", reject);
        p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(parts)) : reject(new Error(err.trim() || `ffmpeg exited ${code}`))));
        p.stdin.end(jpeg);
      }),
  ).then((raw) => {
    if (raw.length !== n * size) throw new Error("ffmpeg gave pictures of another size");
    return Array.from({ length: n }, (_, k) => raw.subarray(k * size, (k + 1) * size));
  });
}

/** Replaces `versionId`'s vectors of these segs; null: no picture could be read (an empty row, so it is not tried again). */
function store(db: DatabaseSync, versionId: string, rows: { seg: number; start: number; vec: Float32Array | null }[], dropShots: boolean): void {
  db.exec("BEGIN");
  try {
    if (dropShots) db.prepare("DELETE FROM pictures WHERE version_id = ? AND seg >= 0").run(versionId);
    const put = db.prepare("INSERT OR REPLACE INTO pictures (version_id, seg, start_s, model, vec) VALUES (?, ?, ?, ?, ?)");
    for (const r of rows) put.run(versionId, r.seg, r.start, PICTURE_MODEL, r.vec ? new Uint8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength) : new Uint8Array());
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * A vector for each stretch on `sheets` (the look's, kept here or sent by a Mac), from its tile's middle frame. A sheet
 * that can't be read gets empty rows. Returns the shots it made vectors for. Throws only when the model fails.
 */
export async function sheetPictures(db: DatabaseSync, versionId: string, sheets: LookSheet[]): Promise<number> {
  const start = new Map(stretchesOf(db, versionId).map((s) => [s.seg, s.a]));
  const read: { segs: number[]; pics: Uint8Array[] | null }[] = [];
  for (const sh of sheets) {
    const jpeg = Buffer.from(sh.jpeg, "base64");
    const size = jpegSize(jpeg);
    const pics = size ? await picturesOf(jpeg, sh.segs.map((_, k) => middleCrop(k, size.w >= size.h))).catch(() => null) : null;
    read.push({ segs: sh.segs, pics });
  }
  const pics = read.flatMap((r) => r.pics ?? []);
  const vecs = pics.length ? await embedPictures(pics) : [];
  const rows = read.flatMap((r) => r.segs.map((seg) => ({ seg, start: start.get(seg) ?? 0, vec: r.pics ? vecs.shift()! : null })));
  // no sheet at all: one empty row says the version was looked at
  store(db, versionId, rows.length ? rows : [{ seg: 0, start: 0, vec: null }], true);
  return rows.filter((r) => r.vec).length;
}

/** The vector of a version's card picture (seg -1, the whole clip). Throws only when the model fails. */
export async function cardPicture(db: DatabaseSync, versionId: string, key: string): Promise<void> {
  const pics = await blobs
    .localCopy(key)
    .then((f) => readFile(f))
    .then((jpeg) => picturesOf(jpeg, ["null"]))
    .catch(() => null);
  const [vec] = pics ? await embedPictures(pics) : [null];
  store(db, versionId, [{ seg: CARD_SEG, start: 0, vec: vec ?? null }], false);
}

let running = false;
let again = false;

/**
 * Makes the vectors still missing, one clip at a time: the card picture of each current video and photo, and the shots
 * of each whose look kept its sheets, in libraries with search by picture on; an opened or edited clip first. Runs once
 * a minute and when woken (a card picture or a look is done); a model that can't be fetched waits for the next run.
 * Returns the clips done.
 */
export async function catchUpPictures(db = libraryDb()): Promise<number> {
  if (!picturesHere()) return 0;
  if (running) {
    again = true;
    return 0;
  }
  running = true;
  let n = 0;
  try {
    for (;;) {
      again = false;
      const todo = db
        .prepare(
          `SELECT d.version_id, d.kind, d.storage_key FROM derivatives d JOIN assets a ON a.current_version_id = d.version_id JOIN libraries l ON l.id = a.library_id
           WHERE a.trashed_at IS NULL AND a.kind IN ('video', 'image') AND d.kind IN ('thumb', 'looksheets') AND d.storage_key IS NOT NULL
             AND COALESCE(json_extract(l.settings, '$.pictures'), 1)
             AND NOT EXISTS (SELECT 1 FROM pictures p WHERE p.version_id = d.version_id AND p.model = ? AND (p.seg = -1) = (d.kind = 'thumb'))
           ORDER BY d.version_id IN (SELECT value FROM json_each(?)) DESC, d.kind = 'thumb' DESC, d.version_id LIMIT 20`,
        )
        .all(PICTURE_MODEL, JSON.stringify(firstClips())) as { version_id: string; kind: string; storage_key: string }[];
      for (const t of todo) {
        if (t.kind === "thumb") await cardPicture(db, t.version_id, t.storage_key);
        else {
          // sheets gone or of an older format: empty, until the look reads the picture again (stretches.ts drops the rows)
          await sheetPictures(db, t.version_id, (await keptSheets(db, t.version_id))?.sheets ?? []);
        }
        n++;
      }
      if (todo.length < 20 && !again) return n;
    }
  } catch (e) {
    console.warn("[library] search by picture:", e instanceof Error ? e.message : e);
    return n;
  } finally {
    running = false;
  }
}

/** Runs the catch-up now (a card picture or a look is done); a run in progress goes round once more. */
export const wakePictures = (): void => void catchUpPictures();

/** catchUpPictures now and every minute; the returned function stops it. */
export function startPictureCatchUp(): () => void {
  wakePictures();
  const t = setInterval(wakePictures, 60_000);
  t.unref();
  return () => clearInterval(t);
}

/** The library's picture vectors of today's model, narrowed by `where` (clauses on the asset `a`, as a search's). */
function libraryRows(libraryId: string, where: { sql: string; params: (string | number)[] }[] = []): Row[] {
  // ponytail: every vector of the library read and scanned per search, as search by meaning; sqlite-vec past ~100k shots
  return (
    libraryDb()
      .prepare(
        `SELECT p.version_id, p.seg, p.start_s, p.vec FROM pictures p JOIN assets a ON a.current_version_id = p.version_id
         WHERE a.library_id = ? AND a.trashed_at IS NULL AND p.model = ? AND length(p.vec) > 0${where.map((w) => ` AND ${w.sql}`).join("")}`,
      )
      .all(libraryId, PICTURE_MODEL, ...where.flatMap((w) => w.params)) as (Omit<Row, "vec"> & { vec: Uint8Array })[]
  ).map((r) => ({ ...r, vec: vecOf(r.vec) }));
}

/** Rows as search hits, in order: a card picture is the clip, a shot opens at its start with its line when it has one. */
function hitsOf(rows: Omit<Row, "vec">[]): SearchHit[] {
  if (!rows.length) return [];
  const db = libraryDb();
  const ids = [...new Set(rows.map((r) => r.version_id))];
  const cards = new Map(
    (
      db
        .prepare(`SELECT ${CARD} FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE v.id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as unknown as CardRow[]
    ).map((r) => [r.version_id, toCard(r)]),
  );
  const lines = new Map<string, Map<number, string>>();
  return rows.flatMap((r): SearchHit[] => {
    const asset = cards.get(r.version_id);
    if (!asset) return [];
    if (r.seg === CARD_SEG) return [{ asset }];
    if (!lines.has(r.version_id)) lines.set(r.version_id, new Map(stretchesOf(db, r.version_id).map((s) => [s.seg, s.text])));
    const line = lines.get(r.version_id)!.get(r.seg);
    return [{ asset, seconds: r.start_s, ...(line ? { snippet: line } : {}) }];
  });
}

/** Whether a search can match pictures in this library now (never waiting for a model download). */
const searchable = (libraryId: string) => picturesHere() && librarySetting(libraryId, "pictures") && pictureModelKept();

/** What the usage tally counts a search's English line as. */
export const ENGLISH_LABEL = "Media Library search in English";
/** A search's English lines, by its words in lower case (the oldest go past ENGLISH_KEPT). */
const english = new Map<string, string>();
const ENGLISH_KEPT = 500;
/** The search each account's English line is being written for: asked once its words stay SETTLE_MS (not each word typed). */
const asking = new Map<string, { key: string; timer: NodeJS.Timeout }>();
const SETTLE_MS = 700;
/** Searches whose English line could not be written (a usage limit, a provider down): not asked again for a while. */
const failed = new Map<string, number>();
const RETRY_MS = 10 * 60_000;

/** The person's own AI, asked for typed `q` in English: the words to match pictures with. Null when it has no answer. */
async function toEnglish(q: string, username: string): Promise<string | null> {
  const route = aiFor(whoFor(username), "analyzer", ENGLISH_LABEL);
  if (route.off) return null;
  const parse = (t: string) => {
    const line = (t.trim().split("\n")[0] ?? "").replace(/^["'“]+|["'”.]+$/g, "").trim().slice(0, 200);
    if (!line) throw new Error("No English line");
    return line;
  };
  return completeWithFallback("You turn a search of a video library into English: what the footage should show. Answer with the English words only.", q, undefined, parse, route);
}

/**
 * The words a search matches pictures with: `q` itself when it reads as English; else its English line, written by the
 * searcher's own AI once and kept. "pending" while it is being written (the search goes without pictures and is asked
 * again); null when there is none: no AI for this account, or it failed lately. Never waits for the AI.
 */
async function pictureWords(q: string, username: string): Promise<string | "pending" | null> {
  if (await readsAsEnglish(q)) return q;
  const key = q.trim().toLowerCase();
  const line = english.get(key);
  if (line) return line;
  if ((failed.get(key) ?? 0) > Date.now() - RETRY_MS || aiFor(whoFor(username), "analyzer", ENGLISH_LABEL).off) return null;
  if (asking.get(username)?.key === key) return "pending";
  clearTimeout(asking.get(username)?.timer);
  const timer = setTimeout(() => {
    void toEnglish(q, username)
      .then((l) => {
        if (!l) return;
        english.set(key, l);
        if (english.size > ENGLISH_KEPT) english.delete(english.keys().next().value!);
      })
      .catch(() => void failed.set(key, Date.now()))
      .finally(() => asking.get(username)?.key === key && asking.delete(username));
  }, SETTLE_MS);
  timer.unref();
  asking.set(username, { key, timer });
  return "pending";
}

/**
 * The 50 shots whose picture is closest to typed `q` (or its English line, pictureWords) and at least PICTURE_FLOOR
 * close, as search hits. `hits` null when search by picture is off or not ready here, the library has no vectors yet,
 * there are no words to match it with, or the model is busy (a transcript is being made): the search then goes without
 * them. `pending`: the English line is being written; the same search asked again soon has the pictures.
 */
export async function pictureHits(
  libraryId: string,
  q: string,
  username: string,
  where: { sql: string; params: (string | number)[] }[] = [],
): Promise<{ hits: SearchHit[] | null; pending?: true }> {
  if (!searchable(libraryId)) return { hits: null };
  const rows = libraryRows(libraryId, where);
  if (!rows.length) return { hits: null };
  const words = await pictureWords(q, username).catch(() => null);
  if (words === "pending") return { hits: null, pending: true };
  const [qv] = words ? await embedPictureQuery([words]).catch(() => [undefined]) : [undefined];
  if (!qv) return { hits: null };
  return { hits: hitsOf(cosineTop(qv, rows, TOP, PICTURE_FLOOR)) };
}

/**
 * More like this: the shots that look most like `versionId`'s shot at `at` seconds (the stretch it falls in), or like its
 * card picture when `at` is not given or it has no shots. The shot itself is left out. Empty when it has no vector yet.
 */
export function alikeHits(libraryId: string, versionId: string, at?: number): SearchHit[] {
  if (!picturesHere() || !librarySetting(libraryId, "pictures")) return [];
  const rows = libraryRows(libraryId);
  const own = rows.filter((r) => r.version_id === versionId);
  const shot = at === undefined ? undefined : own.filter((r) => r.seg >= 0 && r.start_s <= at).sort((x, y) => y.start_s - x.start_s)[0];
  const from = shot ?? own.find((r) => r.seg === CARD_SEG) ?? own[0];
  if (!from) return [];
  // its own card picture is the same moment as one of its shots: never listed for it
  const others = rows.filter((r) => r !== from && !(r.version_id === versionId && r.seg === CARD_SEG));
  return hitsOf(cosineTop(from.vec, others, ALIKE));
}

/**
 * How closely each of `versionId`s' shots matches typed `text` (the AI Editor's brief; not in English, its English line
 * from `actor`'s AI, waited for: an edit is background work), by version and stretch start; an empty map when search by
 * picture can't run here, has no vectors for them, or there are no English words for the brief.
 */
export async function pictureScores(versionIds: string[], text: string, actor: string): Promise<Map<string, { start: number; score: number }[]>> {
  const out = new Map<string, { start: number; score: number }[]>();
  if (!versionIds.length || !text.trim() || !picturesHere() || !pictureModelKept()) return out;
  const rows = (
    libraryDb()
      .prepare(`SELECT version_id, seg, start_s, vec FROM pictures WHERE model = ? AND seg >= 0 AND length(vec) > 0 AND version_id IN (${versionIds.map(() => "?").join(",")})`)
      .all(PICTURE_MODEL, ...versionIds) as (Omit<Row, "vec"> & { vec: Uint8Array })[]
  ).map((r) => ({ ...r, vec: vecOf(r.vec) }));
  if (!rows.length) return out;
  const words = (await readsAsEnglish(text)) ? text : await toEnglish(text, actor).catch(() => null);
  const [qv] = words ? await embedPictureQuery([words]).catch(() => [undefined]) : [undefined];
  if (!qv) return out;
  for (const r of rows) {
    let s = 0;
    for (let i = 0; i < qv.length; i++) s += qv[i]! * r.vec[i]!;
    out.set(r.version_id, [...(out.get(r.version_id) ?? []), { start: r.start_s, score: s }]);
  }
  return out;
}
