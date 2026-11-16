import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { FootageIndex, IndexShot, IndexSource, SongBeats } from "../../contracts/edit-plan";
import type { Stretch } from "../../contracts/library";
import { aiFor, completeWithFallback } from "../ai-complete";
import { completeVisionWithFallback } from "../ai-vision";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { deviceStatus } from "../lib/device-transcribe";
import { env } from "../lib/env";
import { libraryDb } from "../library/db";
import { whoFor } from "../library/describe";
import { ffmpegSlot, writeJsonAtomic } from "../library/media/run";
import { stampOf } from "../lib/workshop/context";
import { refreshDescription } from "../library/describe";
import { enqueueJob } from "../library/jobs";
import { TOO_BIG } from "../library/mac-look";
import { lookFirst, lookStamp, queueLook } from "../library/shots";
import { stretchesOf } from "../library/stretches";
import { notifyWorkshopOwner } from "../review";
import { clock, COLS, contactSheet, CX, CY, HUD_MAX, hudOf, junkOf, looks, lookPrompt, median, parseLooked, readPicture, ROWS, RULE, shotsOf } from "../library/look";
import type { ProbeSummary } from "../library/media/probe";
import { NeedsKey, segmentsOf, wordsOf } from "../library/transcribe";
import { Waiting } from "./analyze";
import { measurable } from "./media";
import { macAway } from "./script";
import { gateOf, onComputer } from "../work/on-computer";

/**
 * The footage index for an edit planned as shots (contracts/edit-plan.ts): what each source holds, from its picture
 * alone, and where a song's beats, hits and parts are. Any footage, not only someone talking: shots between picture
 * changes, long takes split where the picture changes most, how much moves in each, and, from the person's own AI
 * looking at contact sheets, what is seen. The measuring is plain arithmetic on what ffmpeg decodes; nothing else runs.
 */

// ── the picture ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Bump when the shots a source gets would change: a cached index of another version is read again. */
const INDEX_V = 2;
/** A phone game's skill buttons sit over a moving world and never stay put: in a very wide picture (a 9:16 window
 * under WIDE of its width, a phone's 2.2:1) a window at the outer EDGE of either side never fills either. */
const WIDE = 0.3;
const EDGE = 0.15;
/** A crop window off-centre must hold this much more of what moves: a game keeps its hero in the middle */
const CENTRE = 0.25;

/** A shot is no shot: measured junk, or the AI saw "junk: …" on the contact sheet. */
export const isJunk = (x: Pick<IndexShot, "junk" | "desc">) => !!x.junk || /^junk\b/i.test(x.desc ?? "");

/** A window `r` of a line of cells wide over shares `e`: the place holding the most, a centred one favoured by CENTRE
 * -> [place 0..1, share held, first and last edge as fractions]. */
function place(e: number[], r: number): [number, number, number, number] {
  if (r >= 0.98) return [0.5, 1, 0, 1];
  const n = e.length;
  const cum = [0];
  for (const v of e) cum.push(cum[cum.length - 1]! + v);
  const tot = cum[n]!;
  const at = (u: number) => {
    const x = Math.min(n, Math.max(0, u));
    const i = Math.min(n - 1, Math.floor(x));
    return cum[i]! + (cum[i + 1]! - cum[i]!) * (x - i);
  };
  const held = (x: number) => (tot > 0 ? (at((x * (1 - r) + r) * n) - at(x * (1 - r) * n)) / tot : r);
  let best = 0;
  let score = -Infinity;
  for (let k = 0; k <= 40; k++) {
    const x = k / 40;
    const v = held(x) + CENTRE * (1 - 2 * Math.abs(x - 0.5));
    if (v > score + 1e-12) [best, score] = [x, v];
  }
  return [Math.round(best * 1000) / 1000, held(best), best * (1 - r), best * (1 - r) + r];
}

/**
 * Where a w:h crop window sits in a source's picture for its stretch a..b s, so it shows what moves there, never a HUD
 * corner or empty floor: the shots' change across and down, weighted by how much of
 * each the stretch covers, the HUD left out; then the window holding the most (`place`). One window a shot, no drift.
 * `ok` is false when no window of that shape holds its share of what moves, it is more than HUD_MAX HUD, or it sits at
 * the edge of a very wide picture (WIDE, EDGE): a fill becomes a blur (the whole picture over a blurred copy).
 */
export function focusOf(src: Pick<IndexSource, "w" | "h" | "shots" | "hud">, a: number, b: number, w: number, h: number): { x: number; y: number; ok: boolean } {
  const cols = new Array<number>(CX).fill(0);
  const rows = new Array<number>(CY).fill(0);
  for (const x of src.shots) {
    const k = Math.max(0, Math.min(b, x.b) - Math.max(a, x.a)) / Math.max(1e-6, x.b - x.a);
    if (k <= 0 || !x.moves) continue;
    x.moves.cols.forEach((v, i) => (cols[i] += k * v));
    x.moves.rows.forEach((v, i) => (rows[i] += k * v));
  }
  const rx = Math.min(1, w / h / (src.w / src.h));
  const ry = Math.min(1, src.w / src.h / (w / h));
  const [x, hx, x0, x1] = place(cols, rx);
  const [y, hy, y0, y1] = place(rows, ry);
  const hud = src.hud ?? [];
  let n = 0;
  let on = 0;
  const c0 = Math.floor(x0 * CX + 1e-6);
  const r0 = Math.floor(y0 * CY + 1e-6);
  for (let r = r0; r < Math.max(r0 + 1, Math.ceil(y1 * CY - 1e-6)); r++)
    for (let c = c0; c < Math.max(c0 + 1, Math.ceil(x1 * CX - 1e-6)); c++) (n++, (on += hud[r * CX + c] ?? 0));
  return { x, y, ok: on / Math.max(1, n) <= HUD_MAX && hx >= 0.85 * rx && hy >= 0.85 * ry && (rx >= WIDE || (x >= EDGE && x <= 1 - EDGE)) };
}

/**
 * One version's index as cached: everything but `speech`, which a transcript arriving later changes. `looked`: the AI
 * has looked at it (describeShots), so a shot it left without words is not asked about again.
 */
const indexFile = (versionId: string) => path.join(env.dataDir, "editor", "cache", `${versionId}.index.json`);
type Cached = { v: number; src: Omit<IndexSource, "speech">; looked?: string | true };

async function cached(versionId: string): Promise<Cached | null> {
  try {
    const c = JSON.parse(await readFile(indexFile(versionId), "utf8")) as Cached;
    return c.v === INDEX_V ? c : null;
  } catch {
    return null;
  }
}

/** `looked`: the stamp of the workspace context the AI looked at it under (lookedUnder), when it has. */
async function keep(src: Omit<IndexSource, "speech"> & { speech?: boolean }, looked = ""): Promise<void> {
  const { speech: _, ...rest } = src;
  await mkdir(path.dirname(indexFile(src.id)), { recursive: true });
  await writeJsonAtomic(indexFile(src.id), { v: INDEX_V, src: rest, ...(looked ? { looked } : {}) } satisfies Cached);
}

/** The stamp of the context the AI Editor's own look at a source was made under; one from before stamps had none. */
const lookedUnder = (workspace = "") => stampOf(workspace, "editor-look-1");

interface Row {
  id: string;
  library_id: string;
  source_key: string;
  probe: string | null;
  state: string;
  title: string;
}

const rowOf = (id: string) =>
  libraryDb()
    .prepare("SELECT v.id, a.library_id, v.source_key, v.probe, v.state, a.title FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?")
    .get(id) as Row | undefined;

/**
 * The Media Library's side of what an edit reads of a file (library/shots.ts, describe.ts): put these files' work
 * first; ask for one file's shot descriptions, the first time or again (a look job, from its kept sheets when it has
 * them, so the gate waits on it like any other; true when the file gets a look at all); the stamp that file's lines
 * are written under; have a description written under another context written again (true when it queued one); and
 * queue a job that failed once more. A test swaps these.
 */
export const shotLog = {
  first: (ids: string[]): void => lookFirst(ids),
  redo: (versionId: string, actor: string | null): boolean => queueLook(libraryDb(), versionId, actor, true),
  stamp: (versionId: string): Promise<string> => lookStamp(libraryDb(), versionId),
  refresh: (versionId: string, actor: string | null): Promise<boolean> => refreshDescription(libraryDb(), versionId, actor),
  retry: (libraryId: string, versionId: string, kind: string, actor: string | null): void => enqueueJob(libraryDb(), libraryId, versionId, kind, actor),
};

/** The library's work on a file the gate waits for, and what failing it means. */
const LIBRARY_WORK: Record<string, string> = { transcribe: "", describe: "the Media Library could not describe it", look: "the Media Library could not describe its shots" };
/** After this long with no file getting ready, the person hears once that the edit still waits (inbox). */
export const STILL_WAITING_MS = 30 * 60_000;
/** Per edit: how many files were ready, since when, and whether the inbox has been told. */
const waits = new Map<string, { ready: number; since: number; told?: true }>();
/**
 * What the gate asked the library for, each once while this server runs, so work that can't be done is not waited on
 * forever: "<version>:<stamp>" lines written again under that stamp, "<version>:first" a file's first shot
 * descriptions, "<version>:retry:<kind>" a failed job queued once more.
 */
const asked = new Set<string>();
/** True the first time `key` is asked. */
const once = (key: string) => !asked.has(key) && !!asked.add(key);

/** Why a file kept on a Mac with no shot descriptions is left out: nothing of its picture is here. */
const ON_MAC = "it is kept on a Mac, not uploaded, and has no shot descriptions to cut from";

/** One of the edit's files the cut can't use, and why in plain words (Coverage.left). */
export type LeftOut = { id: string; title: string; why: string };

type IndexEdit = { id?: string; name?: string; createdBy?: string; projectId?: string; now?: boolean; sources: string[] };

/** What the index gate hands the read: the sources ready to read, and the ones left out with why. */
export interface IndexGate {
  ready: { id: string; row: Row; probe: ProbeSummary; lines: Stretch[]; why?: string }[];
  left: LeftOut[];
}

/**
 * What every source of the edit holds: length, frame rate, size, whether someone speaks, and its shots. The gate
 * (tasks/flywheel/PLAN.md 3.2) waits, and only waits, while the Media Library still works on a file (its probe, its
 * transcript, its description, its shot descriptions, or lines written under another workspace context than now's):
 * those files go first and the step says "Waiting for the Media Library: 3 of 12 files", with the library's own line
 * for a computer that is off or an AI that isn't connected. What is missing is asked for here, each once: the shot
 * descriptions of a file that has none (a clip from before the library wrote them), a description written under
 * another context, and a description or a look that failed, which gets one more try. A file the library could not
 * read is left out (`left`); one whose description or look failed twice is used as it was before shot descriptions
 * (read here), and left out only when it can't be read here either; with `now` (the person said to cut now) nothing
 * new is asked for and every file still not ready is left out. A source with the library's shot descriptions takes them as its shots; one without is read
 * here as before (its picture once per version, cached). One with no picture (a song) has no shots. A transcript is
 * never asked for here (analyze does that).
 */
export async function indexSources(edit: IndexEdit, signal: AbortSignal, now = Date.now()): Promise<FootageIndex & { left: LeftOut[] }> {
  // on a computer the server ran the gate when it handed the step over (work/on-computer.ts)
  const { ready, left } = onComputer.on ? gateOf<IndexGate>() : await indexGate(edit, signal, now);
  const db = libraryDb();
  const sources: IndexSource[] = [];
  for (const { id, row, probe, lines, why } of ready) {
    if (signal.aborted) throw signal.reason ?? new Error("Stopped");
    const speech = !!(wordsOf(db, id)?.length || segmentsOf(db, id).length);
    const turned = probe.rotation === 90 || probe.rotation === 270;
    const size = { dur: probe.duration, fps: probe.fps, w: turned ? probe.height : probe.width, h: turned ? probe.width : probe.height };
    // the library's shot descriptions are its shots: the same stretches this file's picture gives (library/look.ts)
    const described = !!probe.vcodec && !probe.cover && lines.length > 0;
    // its picture is still read once per version (cached): the lines say what happens, the read where it moves and
    // what is junk
    let src = (await cached(id))?.src;
    if (!src) {
      const picture = !!probe.vcodec && !probe.cover;
      const reading = picture ? measurable(id, row.source_key).then((f) => readPicture(f, probe.fps, signal)) : Promise.resolve(null);
      // a source with shot descriptions that can't be read here (on a Mac, upload off) is cut from its lines alone; one
      // with no lines that the library failed on, or that is kept on a Mac, is left out and named, and the cut is
      // made from the rest
      const onMac = row.source_key.startsWith("mac:");
      const read = await reading.catch((e: unknown) => {
        if ((described || why || onMac) && !signal.aborted) return null;
        throw e;
      });
      if (picture && !read && !described) {
        left.push({ id, title: row.title, why: why ?? ON_MAC });
        continue;
      }
      const shots = read ? shotsOf(read, probe.duration) : [];
      src = { id, title: row.title, ...size, shots, ...(read ? { hud: hudOf(read) } : {}) };
      if (read || !picture) await keep(src);
    }
    if (described) src = { ...src, ...size, shots: lines.map((l) => lineShot(l, src!.shots)) };
    sources.push({ ...src, title: row.title, speech });
  }
  return { sources, left };
}

/**
 * indexSources' gate: what the server's library and its memory say about each source (probe, the library's work on it,
 * its shot descriptions and their stamp), waiting (Waiting) while the library still works on one. Runs on the server
 * only, also for a step a computer takes (its claim runs it).
 */
export async function indexGate(edit: IndexEdit, signal: AbortSignal, now = Date.now()): Promise<IndexGate> {
  const db = libraryDb();
  const ready: IndexGate["ready"] = [];
  const actor = edit.createdBy ?? null;
  const left: LeftOut[] = [];
  const pending: { id: string; title: string; line?: string }[] = [];
  for (const id of edit.sources) {
    if (signal.aborted) throw signal.reason ?? new Error("Stopped");
    const row = rowOf(id);
    if (!row) throw new Error(`A source of the edit is gone from the library (${id})`);
    const probe = JSON.parse(row.probe ?? "null") as ProbeSummary | null;
    if (!probe) {
      if (row.state === "failed") left.push({ id, title: row.title, why: "the Media Library could not read it" });
      else pending.push({ id, title: row.title });
      continue;
    }
    const kinds = Object.keys(LIBRARY_WORK);
    const work = db.prepare(`SELECT kind, state, error FROM jobs WHERE version_id = ? AND kind IN (${kinds.map(() => "?").join(", ")})`).all(id, ...kinds) as { kind: string; state: string; error: string | null }[];
    // a description or a look that failed gets one more try (a bad answer, a file that was busy); one that failed for
    // its size would fail the same way
    const failed = work.filter((w) => w.state === "failed" && LIBRARY_WORK[w.kind]);
    const again = failed.filter((w) => !edit.now && w.error !== TOO_BIG && once(`${id}:retry:${w.kind}`));
    for (const w of again) shotLog.retry(row.library_id, id, w.kind, actor);
    if (again.length) {
      pending.push({ id, title: row.title });
      continue;
    }
    const why = failed[0] && LIBRARY_WORK[failed[0].kind];
    const lookFailed = failed.some((w) => w.kind === "look");
    // queued or running, or a description parked for an AI that isn't connected: its own line says which (a transcript
    // parked for a key never holds a planned edit: it takes the words there are)
    const busy = work.filter((w) => w.state === "queued" || w.state === "running" || (w.state === "needs_key" && w.kind !== "transcribe"));
    if (busy.length) {
      pending.push({ id, title: row.title, line: (busy.find((w) => w.kind === "transcribe") && deviceStatus(id)) || busy.find((w) => w.error)?.error || undefined });
      continue;
    }
    const lines = stretchesOf(db, id);
    const stamp = lines.some((s) => s.source === "ai") ? await shotLog.stamp(id) : "";
    // written under another context than the workspace's now: written again, then used (asked once per stamp)
    if (!lookFailed && lines.some((s) => s.source === "ai" && s.stamp !== stamp) && once(`${id}:${stamp}`)) {
      shotLog.redo(id, actor);
      pending.push({ id, title: row.title });
      continue;
    }
    // no shot descriptions yet (a clip described before the library wrote them, or whose look never ran): asked for,
    // when it is a file that gets them
    if (!edit.now && !lookFailed && !lines.length && once(`${id}:first`) && shotLog.redo(id, actor)) {
      pending.push({ id, title: row.title });
      continue;
    }
    // its description was written under another context than the workspace's now: written again, then used
    if (!edit.now && (await shotLog.refresh(id, actor))) {
      pending.push({ id, title: row.title });
      continue;
    }
    ready.push({ id, row, probe, lines, ...(why ? { why } : {}) });
  }
  const key = edit.id ?? edit.sources.join(",");
  if (pending.length && !edit.now) {
    shotLog.first(pending.map((p) => p.id));
    const w = waits.get(key);
    if (!w || w.ready !== ready.length) waits.set(key, { ready: ready.length, since: now });
    else if (!w.told && now - w.since >= STILL_WAITING_MS && edit.createdBy && edit.id) {
      w.told = true;
      void notifyWorkshopOwner(edit.createdBy, { kind: "waiting", by: "AI Editor", name: edit.name ?? "An edit", text: `Still waiting for the Media Library: ${ready.length} of ${edit.sources.length} files`, href: `/editor/${edit.id}`, ref: edit.id }).catch(() => {});
    }
    const said = pending.find((p) => p.line)?.line;
    throw new Waiting(30, `Waiting for the Media Library: ${ready.length} of ${edit.sources.length} files${said ? `. ${said.replace(/\.$/, "")}` : ""}`);
  }
  waits.delete(key);
  for (const p of pending) left.push({ id: p.id, title: p.title, why: "still being read by the Media Library" });
  return { ready, left };
}

/** What is known of a source's shots without reading it again: the library's shot descriptions (with what its cached
 * index measured), else the AI Editor's own index of it. */
export async function knownShots(versionId: string): Promise<IndexShot[]> {
  const lines = stretchesOf(libraryDb(), versionId);
  const measured = (await cached(versionId))?.src.shots ?? [];
  return lines.length ? lines.map((l) => lineShot(l, measured)) : measured;
}

/** One shot description as the plan reads a shot, with what the picture measured at its middle (`measured`, the same
 * finder's stretches): whether it is junk and where it moves, so its crop follows the action. */
const lineShot = (s: Stretch, measured: IndexShot[] = []): IndexShot => {
  const mid = (s.a + s.b) / 2;
  const m = measured.find((x) => x.a <= mid && mid < x.b);
  return { a: s.a, b: s.b, motion: s.motion, ...(s.text ? { desc: s.text } : {}), action: s.action, clear: s.clear, tags: s.tags, ...(s.ph ? { ph: s.ph } : {}), ...(m?.junk ? { junk: m.junk } : {}), ...(m?.moves ? { moves: m.moves } : {}) };
};

/** A source whose shots are the library's shot descriptions (each carries its action): the AI doesn't look at it again. */
export const logged = (s: IndexSource): boolean => s.shots.length > 0 && s.shots.every((x) => x.action !== undefined);

export { contactSheet, cutsOf, hudOf, junkOf, looks, lookPrompt, parseLooked, readPicture, shotsOf, type Looked, type PictureRead } from "../library/look";

/**
 * The last look before a shot is used: its frame at `t` s as the shot shows it (a `shape` window at `focus`, else the
 * whole picture), at the index's scale -> why it is no shot (`junkOf`, or "ui" when more than UI_BRIGHT of it is bright
 * and colourless: an app window or a document; snow stays well under), "" when fine or unreadable.
 */
export async function frameJunk(file: string, t: number, size: { w: number; h: number }, shape: [number, number] | null, focus?: { x: number; y: number }, signal?: AbortSignal): Promise<string> {
  const buf = await ffmpegSlot(
    () =>
      new Promise<Buffer>((resolve) => {
        const p = spawn(
          ffmpegCommand(),
          ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", Math.max(0, t).toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale='if(gte(iw,ih),256,-2)':'if(gte(iw,ih),-2,256)'", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
          { signal },
        );
        const parts: Buffer[] = [];
        p.stdout.on("data", (d: Buffer) => parts.push(d));
        p.on("error", () => resolve(Buffer.alloc(0)));
        p.on("close", () => resolve(Buffer.concat(parts)));
      }),
  );
  if (!buf.length) return "";
  // the frame is 256 on its long side
  const [W, H] = size.w >= size.h ? [256, buf.length / 3 / 256] : [buf.length / 3 / 256, 256];
  if (!Number.isInteger(W) || !Number.isInteger(H)) return "";
  let [x0, y0, cw, ch] = [0, 0, W, H];
  if (shape) {
    const r = shape[0] / shape[1] / (W / H);
    [cw, ch] = r < 1 ? [Math.round(W * r), H] : [W, Math.round(H / r)];
    [x0, y0] = [Math.round((W - cw) * (focus?.x ?? 0.5)), Math.round((H - ch) * (focus?.y ?? 0.5))];
  }
  const gw = Math.max(4, Math.floor(cw / 4));
  const gh = Math.max(4, Math.floor(ch / 4));
  const g = new Float32Array(gw * gh);
  const ch2 = new Float32Array(gw * gh);
  let bright = 0;
  for (let y = 0; y < gh * 4 && y < ch; y++)
    for (let x = 0; x < gw * 4 && x < cw; x++) {
      const i = ((y0 + y) * W + x0 + x) * 3;
      const [r, gr, b] = [buf[i]!, buf[i + 1]!, buf[i + 2]!];
      const hi = Math.max(r, gr, b);
      if (hi > 217 && (hi - Math.min(r, gr, b)) / hi < 31 / 255) bright++;
      const j = Math.floor(y / 4) * gw + Math.floor(x / 4);
      g[j] += (0.299 * r + 0.587 * gr + 0.114 * b) / 16;
      ch2[j] += Math.hypot(-0.1687 * r - 0.3313 * gr + 0.5 * b, 0.5 * r - 0.4187 * gr - 0.0813 * b) / 16;
    }
  return junkOf(looks(g, gw, gh, ch2)) || (bright / (Math.min(ch, gh * 4) * Math.min(cw, gw * 4)) > UI_BRIGHT ? "ui" : "");
}

/** A window more than this share bright and colourless is an app window or a document, not a shot */
const UI_BRIGHT = 0.2;

// ── contact sheets and the person's AI ──────────────────────────────────────────────────────────────────────────

const LABEL = "AI Editor footage";
/** Sheets in one call: a call reads up to SHEETS_PER_CALL × COLS × ROWS shots */
const SHEETS_PER_CALL = 6;
/** Sheets per source at most: a longer source has every k-th shot looked at, the rest left without words */
const MAX_SHEETS = 8;


/** One tile of a call: which shot of which source, and its number in the call (from 1). */
interface Tile {
  src: number;
  shot: number;
  n: number;
}

interface Sheet {
  src: number;
  tiles: Tile[];
}


/**
 * Fills each shot's `desc` (and the index's `story` when `ai.story`) from the person's own AI looking at contact
 * sheets: one frame per shot, COLS × ROWS to a sheet, up to SHEETS_PER_CALL sheets in one call across sources. A
 * one-shot source the library has described already takes the library's words with no call. What was said is kept
 * with the source's cached index, so a second edit of the same footage asks nothing.
 */
export async function describeShots(index: FootageIndex, ai: { actor: string; story?: boolean; workspace?: string }, signal: AbortSignal): Promise<FootageIndex> {
  const who = whoFor(ai.actor);
  const route = aiFor(who, "editor", LABEL);
  if (route.off) throw new NeedsKey(route.off);
  const db = libraryDb();
  const libraryWords = (id: string) =>
    (db.prepare("SELECT text FROM descriptions WHERE version_id = ? ORDER BY source = 'user' DESC LIMIT 1").get(id) as { text: string } | undefined)?.text;
  const sources = index.sources.map((s) => ({ ...s, shots: s.shots.map((x) => ({ ...x })) }));
  const sheets: Sheet[] = [];
  const under = lookedUnder(ai.workspace);
  for (const [si, s] of sources.entries()) {
    // the library's shot descriptions are its words already
    if (logged(s)) continue;
    // looked at under another workspace context than now's (one from before stamps: under none): its words are asked
    // for again; looked at under this one: not asked again, whatever was left without words
    const was = (await cached(s.id))?.looked;
    if (was && (was === true ? lookedUnder() : was) !== under) for (const x of s.shots) delete x.desc;
    else if (was) continue;
    const open = s.shots.map((x, i) => (x.desc ? -1 : i)).filter((i) => i >= 0);
    if (!open.length) continue;
    const known = libraryWords(s.id);
    if (s.shots.length === 1 && known) {
      s.shots[0]!.desc = known.slice(0, 200);
      await keep(s, under);
      continue;
    }
    // ponytail: a source past MAX_SHEETS sheets has every k-th open shot looked at; the rest stay without words
    const cap = MAX_SHEETS * COLS * ROWS;
    const picked = open.length <= cap ? open : Array.from({ length: cap }, (_, k) => open[Math.floor((k * open.length) / cap)]!);
    for (let i = 0; i < picked.length; i += COLS * ROWS) sheets.push({ src: si, tiles: picked.slice(i, i + COLS * ROWS).map((shot) => ({ src: si, shot, n: 0 })) });
  }
  let story: string | undefined;
  const scratch = path.join(env.dataDir, "editor", "cache", `sheets-${randomUUID()}`);
  try {
    for (let c = 0; c < sheets.length; c += SHEETS_PER_CALL) {
      if (signal.aborted) throw signal.reason ?? new Error("Stopped");
      const batch = sheets.slice(c, c + SHEETS_PER_CALL);
      const last = c + SHEETS_PER_CALL >= sheets.length;
      await mkdir(scratch, { recursive: true });
      const lines: string[] = [];
      const images = [];
      let n = 0;
      for (const [k, sh] of batch.entries()) {
        const s = sources[sh.src]!;
        const row = rowOf(s.id);
        if (!row) throw new Error(`A source of the edit is gone from the library (${s.id})`);
        const file = path.join(scratch, `${k}.jpg`);
        await contactSheet(
          await measurable(s.id, row.source_key),
          sh.tiles.map((t) => Math.max(0, Math.min(s.dur - 0.1, (s.shots[t.shot]!.a + s.shots[t.shot]!.b) / 2))),
          s.w >= s.h,
          file,
        );
        images.push({ jpegBase64: (await readFile(file)).toString("base64") });
        for (const t of sh.tiles) t.n = ++n;
        const known = libraryWords(s.id);
        lines.push(
          `Picture ${k + 1}: from “${s.title}”${known ? ` (the library describes it as: ${known.slice(0, 400)})` : ""}. Its tiles, left to right, top to bottom, are shots ` +
            sh.tiles.map((t) => `${t.n} (${clock(s.shots[t.shot]!.a)}–${clock(s.shots[t.shot]!.b)})`).join(", "),
        );
      }
      if (last && ai.story) {
        const before = sources.flatMap((s) => s.shots.filter((x) => x.desc).map((x) => `${s.title} ${clock(x.a)}: ${x.desc}`));
        if (before.length) lines.push(`Already described elsewhere in the footage:\n${before.slice(0, 300).join("\n")}`);
      }
      const { system, user } = lookPrompt(lines, last && !!ai.story, ai.workspace);
      const { value } = await completeVisionWithFallback(system, user, images, signal, parseLooked, who, { label: LABEL, job: "editor" });
      for (const sh of batch)
        for (const t of sh.tiles) {
          const words = value.shots[String(t.n)];
          if (words) sources[sh.src]!.shots[t.shot]!.desc = words;
        }
      // a source whose last sheet this was is looked at: what the AI left without words stays so
      for (const si of new Set(batch.map((b) => b.src))) await keep(sources[si]!, sheets.slice(c + SHEETS_PER_CALL).some((x) => x.src === si) ? "" : under);
      if (value.story) story = value.story;
    }
    // every shot was described before: the story is one question in words alone. With the library's lines for every
    // source the plan reads each line, so no story is asked for
    if (ai.story && !story && !sheets.length && !sources.filter((s) => s.w > 0 && s.shots.length).every(logged)) {
      const lines = sources.flatMap((s) => s.shots.filter((x) => x.desc).map((x) => `${s.title} ${clock(x.a)}–${clock(x.b)}: ${x.desc}`));
      if (lines.length) {
        const system = `You read shot-by-shot notes of footage for a video editor and tell what happens across it, from the pictures alone. ${RULE} Answer with JSON only.`;
        const user = `${lines.slice(0, 600).join("\n")}\n\nAnswer as {"story": "what happens across all of the footage, in order, in a few sentences"}`;
        story = (await completeWithFallback(system, user, signal, parseLooked, { ...route, retries: 0 })).story;
      }
    }
  } catch (e) {
    // the person's Mac is off or its AI gone: the step waits for it, as the script step does
    const away = macAway(e);
    if (away) throw new NeedsKey(away.message);
    throw e;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return { ...index, sources, ...(story ? { story } : {}) };
}

// ── the song ─────────────────────────────────────────────────────────────────────────────────────────────────────

const SR = 22050;
const N = 1024;
const HOP = 256;
/** envelope frames a second */
const ENV_RATE = SR / HOP;
/** The bins up to about 200 Hz (21.5 Hz each): where a kick drum's hit is. */
const LOW_BINS = Math.round(200 / (SR / N));
/** A beat or a hit is moved to the steepest rise in loudness within this far (s): the onset itself, to the millisecond */
const SNAP_S = 0.035;
/** loudness reads for that snap, each this long (s) */
const FINE_S = 0.002;
/** A hit is strong when it is this many times the median hit within STRONG_AROUND_S */
const STRONG_OVER = 1.5;
const STRONG_AROUND_S = 8;
/** Parts: loudness read in windows of SECTION_WIN_S, a change of SECTION_DB between the SECTION_SPAN_S before and after
 * makes a new part, no part shorter than SECTION_MIN_S */
const SECTION_WIN_S = 1;
const SECTION_SPAN_S = 4;
const SECTION_DB = 6;
const SECTION_MIN_S = 4;

/** `file` from `startS` as mono samples at SR. */
export async function decodeMono(file: string, startS: number, signal?: AbortSignal): Promise<Float32Array> {
  return ffmpegSlot(
    () =>
      new Promise((resolve, reject) => {
        // -ss after -i: the start is exact to the sample, not the nearest packet
        const p = spawn(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", file, "-ss", String(startS), "-vn", "-ac", "1", "-ar", String(SR), "-f", "f32le", "pipe:1"], {
          signal,
        });
        const parts: Buffer[] = [];
        let err = "";
        p.stdout.on("data", (d: Buffer) => parts.push(d));
        p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
        p.on("error", reject);
        p.on("close", (code) => {
          if (code !== 0) return reject(new Error(err.trim() || `ffmpeg exited ${code}`));
          const b = Buffer.concat(parts);
          const whole = b.length - (b.length % 4);
          resolve(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + whole)));
        });
      }),
  );
}

/** In-place radix-2 FFT of (re, im), length a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len)
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
  }
}

/**
 * The onset envelope: how much louder each band got from one frame to the next, rises only. `env` on log magnitudes
 * (every onset counts, soft or hard: tempo and onsets); `hard` on plain magnitudes (how hard a hit is; a steady bass
 * under it adds nothing).
 */
export function onsetEnvelope(x: Float32Array): { env: Float32Array; hard: Float32Array; low: Float32Array } {
  const frames = Math.max(0, Math.floor((x.length - N) / HOP) + 1);
  const env = new Float32Array(frames);
  const hard = new Float32Array(frames);
  const low = new Float32Array(frames);
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let prev = new Float64Array(N / 2);
  let prevLin = new Float64Array(N / 2);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) (re[i] = x[f * HOP + i]! * win[i]!), (im[i] = 0);
    fft(re, im);
    const mag = new Float64Array(N / 2);
    const lin = new Float64Array(N / 2);
    let flux = 0;
    let rise = 0;
    let kick = 0;
    for (let k = 1; k < N / 2; k++) {
      lin[k] = Math.hypot(re[k]!, im[k]!);
      mag[k] = Math.log1p(100 * lin[k]!);
      if (f) (flux += Math.max(0, mag[k]! - prev[k]!)), (rise += Math.max(0, lin[k]! - prevLin[k]!));
      if (f && k <= LOW_BINS) kick += Math.max(0, mag[k]! - prev[k]!); // log rise: a hit from quiet counts, a steady bass barely
    }
    env[f] = flux;
    hard[f] = rise;
    low[f] = kick;
    prev = mag;
    prevLin = lin;
  }
  return { env, hard, low };
}

/** The envelope frame `f`'s time (s): its window's middle. */
const frameTime = (f: number) => (f * HOP + N / 2) / SR;

/**
 * The time (s) of the steepest loudness rise within SNAP_S of `t`: where the hit starts. Read on the change from one
 * sample to the next, where a hit's attack is loud and a steady bass (whose 2 ms reads would swing with its own wave)
 * is nearly silent.
 */
function snap(x: Float32Array, t: number): number {
  const L = Math.round(FINE_S * SR);
  const from = Math.max(0, Math.round((t - SNAP_S) * SR));
  const to = Math.min(x.length - L, Math.round((t + SNAP_S) * SR));
  let best = -Infinity;
  let at = t;
  let before = from === 0 ? 0 : -1; // before the file's first sample is silence: a hit right at 0 is a rise
  for (let i = from; i <= to; i += L) {
    let s = 0;
    for (let j = Math.max(1, i); j < i + L; j++) s += (x[j]! - x[j - 1]!) ** 2;
    const rms = Math.sqrt(s / L);
    if (before >= 0 && rms - before > best) [best, at] = [rms - before, i / SR];
    before = rms;
  }
  return at;
}

/** How hard the hit at `t` (s) is: the plain rise around its frame. */
function hitStrength(hard: Float32Array, t: number): number {
  const f = Math.round((t * SR - N / 2) / HOP);
  let m = 0;
  for (let j = Math.max(0, f - 2); j <= Math.min(hard.length - 1, f + 2); j++) m = Math.max(m, hard[j]!);
  return m;
}

/** Peaks of the envelope over its local mean: the onsets, as frames. */
function peaksOf(env: Float32Array): number[] {
  const w = Math.round(0.05 * ENV_RATE);
  const span = Math.round(1.5 * ENV_RATE);
  const out: number[] = [];
  let sum = 0;
  let sq = 0;
  let c = 0;
  // ponytail: one mean and spread over the whole song; a moving one if quiet intros lose their onsets
  for (const v of env) (sum += v), (sq += v * v), c++;
  const mean = sum / Math.max(1, c);
  const sd = Math.sqrt(Math.max(0, sq / Math.max(1, c) - mean * mean));
  for (let i = 1; i < env.length - 1; i++) {
    const v = env[i]!;
    if (v < mean + 0.5 * sd) continue;
    let top = true;
    for (let j = Math.max(0, i - w); j <= Math.min(env.length - 1, i + w); j++) if (env[j]! > v || (env[j] === v && j < i)) top = false;
    if (!top) continue;
    let local = 0;
    let n = 0;
    for (let j = Math.max(0, i - span); j <= Math.min(env.length - 1, i + span); j++) (local += env[j]!), n++;
    if (v > (local / n) * 1.3) out.push(i);
  }
  return out;
}

/** The beat period in envelope frames, by autocorrelation weighted toward 120 bpm (so a half or double tempo loses). */
function periodOf(env: Float32Array): number {
  const mean = env.reduce((a, b) => a + b, 0) / Math.max(1, env.length);
  const e = Array.from(env, (v) => v - mean);
  let best = -Infinity;
  let at = Math.round((60 / 120) * ENV_RATE);
  const ac = (lag: number) => {
    let s = 0;
    for (let i = lag; i < e.length; i++) s += e[i]! * e[i - lag]!;
    return s / (e.length - lag);
  };
  for (let lag = Math.floor((60 / 200) * ENV_RATE); lag <= Math.ceil((60 / 60) * ENV_RATE); lag++) {
    const bpm = (60 * ENV_RATE) / lag;
    const weight = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const v = ac(lag) * weight;
    if (v > best) [best, at] = [v, lag];
  }
  // between whole frames: the peak of a parabola through the three around it
  const [l, m, r] = [ac(at - 1), ac(at), ac(at + 1)];
  const d = l - 2 * m + r;
  return d < 0 ? at + (0.5 * (l - r)) / d : at;
}

/**
 * Where the beats, bars, hard hits and loud and quiet parts of a song are, from `startS` on; times in the song's own
 * seconds. The tempo is the autocorrelation of the onset envelope; beats are followed from the strongest phase, each
 * one moved to the onset nearest it, so a drifting tempo is followed too; the bpm is the slope through the beats.
 * Downbeats assume four beats to a bar, on the beat where the bar's hits are hardest.
 */
export async function songBeats(file: string, startS: number, signal: AbortSignal): Promise<SongBeats> {
  const x = await decodeMono(file, startS, signal);
  return beatsOf(x, file, startS);
}

/** songBeats on samples already decoded (SR, mono). */
export function beatsOf(x: Float32Array, source: string, startS: number): SongBeats {
  const { env, hard, low } = onsetEnvelope(x);
  const empty: SongBeats = { source, startS, bpm: 0, beats: [], downbeats: [], strong: [], sections: sectionsOf(x, startS) };
  if (env.length < 4 * ENV_RATE) return empty;
  const P = periodOf(env);
  // the phase whose grid lands on the most kick (bass onsets): hi-hats between the beats are more onsets than the kick,
  // so all onsets alike put the beats on the off-beat. The bass is trusted only when it pulses with the tempo (one
  // phase well ahead of the rest); a steady bass, or none, goes by every onset.
  const phaseScores = (e: Float32Array) =>
    Array.from({ length: Math.ceil(P) }, (_, p) => {
      let s = 0;
      for (let t = p; t < e.length; t += P) {
        let m = 0; // the grid point or a frame either side: a kick's rise can straddle two frames
        for (let j = Math.max(0, Math.round(t) - 1); j <= Math.min(e.length - 1, Math.round(t) + 1); j++) m = Math.max(m, e[j]!);
        s += m;
      }
      return s;
    });
  const top = (xs: number[]) => xs.reduce((b, v, i) => (v > xs[b]! ? i : b), 0);
  const kickAt = phaseScores(low);
  const kickMean = kickAt.reduce((a, b) => a + b, 0) / kickAt.length;
  const phase = kickMean > 0 && kickAt[top(kickAt)]! > 2 * kickMean ? top(kickAt) : top(phaseScores(env));
  // follow the grid: each beat at the envelope's peak within a tenth of a period of where it was expected
  const tol = Math.max(1, Math.round(P * 0.1));
  const frames: number[] = [];
  const near = (t: number) => {
    let at = Math.round(t);
    for (let j = Math.max(0, Math.round(t) - tol); j <= Math.min(env.length - 1, Math.round(t) + tol); j++) if (env[j]! > env[at]!) at = j;
    return at;
  };
  for (let t = phase; t < env.length; ) {
    const f = near(t);
    const strongEnough = env[f]! > 0;
    frames.push(strongEnough ? f : Math.round(t));
    t = (strongEnough ? f : t) + P;
  }
  const beatsT = frames.map((f) => snap(x, frameTime(f)));
  // the slope through the beats: the bpm, to a fraction
  const n = beatsT.length;
  const mi = (n - 1) / 2;
  const mt = beatsT.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  beatsT.forEach((t, i) => ((num += (i - mi) * (t - mt)), (den += (i - mi) ** 2)));
  const period = den ? num / den : P / ENV_RATE;
  const strength = beatsT.map((t) => hitStrength(hard, t));
  let bar = 0;
  let barBest = -Infinity;
  for (let k = 0; k < 4; k++) {
    let s = 0;
    for (let i = k; i < n; i += 4) s += strength[i]!;
    if (s > barBest) [barBest, bar] = [s, k];
  }
  const onsets = peaksOf(env).map((f) => snap(x, frameTime(f)));
  const hits = onsets.map((t) => hitStrength(hard, t));
  const strong = onsets.filter((t, i) => {
    const around = hits.filter((_, j) => Math.abs(onsets[j]! - t) <= STRONG_AROUND_S);
    return hits[i]! >= STRONG_OVER * median(around);
  });
  const r3 = (t: number) => Math.round((t + startS) * 1000) / 1000;
  return {
    source,
    startS,
    bpm: Math.round((60 / period) * 10) / 10,
    beats: beatsT.map(r3),
    downbeats: beatsT.filter((_, i) => i % 4 === bar).map(r3),
    strong: strong.map(r3),
    sections: sectionsOf(x, startS),
  };
}

/** Loud and quiet parts: a new part where the loudness before and after differs by SECTION_DB; energy 0..1 of the loudest. */
export function sectionsOf(x: Float32Array, startS: number): SongBeats["sections"] {
  const W = Math.round(SECTION_WIN_S * SR);
  const db: number[] = [];
  for (let i = 0; i + W / 2 <= x.length; i += W) {
    let s = 0;
    const end = Math.min(x.length, i + W);
    for (let j = i; j < end; j++) s += x[j]! * x[j]!;
    db.push(10 * Math.log10(s / (end - i) + 1e-10));
  }
  const dur = x.length / SR;
  if (!db.length) return [];
  const span = Math.round(SECTION_SPAN_S / SECTION_WIN_S);
  const avg = (a: number, b: number) => {
    const xs = db.slice(Math.max(0, a), Math.min(db.length, b));
    return xs.reduce((p, q) => p + q, 0) / Math.max(1, xs.length);
  };
  const change = db.map((_, i) => (i < 1 ? 0 : Math.abs(avg(i, i + span) - avg(i - span, i))));
  const cuts: number[] = [];
  for (let i = 1; i < db.length; i++) {
    if (change[i]! < SECTION_DB) continue;
    if (change[i - 1]! > change[i]! || (change[i + 1] ?? 0) > change[i]!) continue;
    if (i * SECTION_WIN_S < SECTION_MIN_S || dur - i * SECTION_WIN_S < SECTION_MIN_S) continue;
    if (cuts.length && (i - cuts[cuts.length - 1]!) * SECTION_WIN_S < SECTION_MIN_S) continue;
    cuts.push(i);
  }
  const edges = [0, ...cuts, db.length];
  const rms = edges.slice(1).map((b, k) => {
    const a = edges[k]!;
    let s = 0;
    for (let i = a; i < b; i++) s += 10 ** (db[i]! / 10);
    return Math.sqrt(s / Math.max(1, b - a));
  });
  const top = Math.max(...rms, 1e-9);
  const r3 = (t: number) => Math.round((t + startS) * 1000) / 1000;
  return rms.map((e, k) => ({ a: r3(edges[k]! * SECTION_WIN_S), b: r3(k === rms.length - 1 ? dur : edges[k + 1]! * SECTION_WIN_S), energy: Math.round((e / top) * 100) / 100 }));
}
