import { openAsBlob } from "node:fs";
import https from "node:https";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { LOOK_LEVELS, watchModelOf, type LookLevel, type TimelineEvent, type WatchModel } from "../../contracts/library";
import { keyFor } from "../my-keys";
import { recordUsage } from "../lib/mac-claude";
import { workspaceContext } from "../lib/workshop/context";
import { parseJsonObject } from "../lib/instagram/vision";
import { libraryLookLevel, librarySetting } from "./db";
import { WORKSPACE_MAX, workspaceIdOf } from "./describe";
import { canEmbed } from "./embed";
import { enqueueJob } from "./jobs";
import { clock, RULE } from "./look";
import { hasSound } from "./media/probe";
import { WATCH_LABEL } from "./shots";

/**
 * Timelines: Gemini watches a video with its sound and says what happens when (contracts TimelineEvent), on top of the
 * shot descriptions. It runs in the look job (worker.ts), after the look, as the look's actor and on their own Gemini
 * key (Settings → API keys); with no key, or the library's Timelines off, nothing here runs and the look is as before.
 * The file sent is the one the look read: the proxy when there is one. A file kept on a Mac with nothing uploaded is
 * sent by that Mac to this server as a small copy made for it (mac-look.ts), so the key stays on the server and the call
 * is counted in the usage tally and the library's monthly budget like the look's own. A watch that fails never fails the
 * look: its error is kept and it is tried again RETRY_MS later (sweepWatch). A watch runs beside the look lane, never in
 * it (watchAfter): a busy model can keep one call waiting for minutes.
 */

/**
 * Dollars per million tokens, in and out (thinking counted as out), paid tier, one rate for video, audio and text.
 * Read 2026-11-16 off Google's price list; 3.8 Flash's doubles on 2027-01-01 (1.5 in, 7.5 out).
 */
const PRICE: Record<WatchModel, { in: number; out: number }> = {
  "gemini-3.8-flash": { in: 0.75, out: 3.75 },
  "gemini-3.5-flash-lite": { in: 0.3, out: 2.5 },
};
const BASE = "https://generativelanguage.googleapis.com";
/** Per level (contracts LOOK_LEVELS): frames a second Gemini samples, at what resolution. */
export const WATCH_LEVELS: Record<LookLevel, { fps: number; res: "MEDIA_RESOLUTION_LOW" | "MEDIA_RESOLUTION_MEDIUM" }> = {
  light: { fps: 0.5, res: "MEDIA_RESOLUTION_LOW" },
  standard: { fps: 1, res: "MEDIA_RESOLUTION_LOW" },
  detailed: { fps: 2, res: "MEDIA_RESOLUTION_MEDIUM" },
};
/**
 * One call covers this much of the video (its start and end offsets). Measured 2026-11-16 on a 24-minute open movie at
 * Standard: a 20-minute part came back with 777 output tokens and a 19-minute hole, where one call on 12 minutes gave 89
 * events over all of it. Ten minutes keeps each answer whole.
 */
export const PART_S = 10 * 60;
/**
 * Gemini's answers that mean "busy, ask again": tried RETRIES more times, waiting `backoffMs`, then three times that.
 * A call waits up to CALL_MS for its answer: 3.8 Flash under "high demand" kept calls queued 3 to 14 minutes (measured
 * 2026-11-16) before it answered; `post` is the call (a seam for the tests).
 */
const BUSY = [429, 500, 503];
const RETRIES = 2;
const CALL_MS = 30 * 60_000;
export const watchTiming = { backoffMs: 60_000, post: longPost };
/** Watches running now, by version, at most WATCHES_AT_ONCE (watchAfter). */
export const watching = new Map<string, Promise<void>>();
/**
 * Keys whose quota ran out (Gemini's 429 with a wait longer than ours), until when and Gemini's words: no call is made
 * on one before then, not the next part's, not another video's (parked).
 * ponytail: in memory; a restart asks once more and is told again
 */
export const parked = new Map<string, { until: number; said: string }>();
const parkedOf = (key: string) => {
  const p = parked.get(key);
  return p && p.until > Date.now() ? p : null;
};
const WATCHES_AT_ONCE = 3;
/** Parts of one video asked at once. */
const PARTS_AT_ONCE = 3;
/** A watch that failed is tried again this long after. */
export const RETRY_MS = 6 * 3600_000;
/** Caps on an event's words. */
const WHAT_MAX = 200;
const NOTE_MAX = 120;
/**
 * Tokens in a second of footage and out a minute of it (thinking included), by model and level, on an 11:39
 * public-domain NASA video with sound (720p proxy), 2026-11-16/17. Flash-Lite: measured at each level (Light $0.10,
 * Standard $0.14, Detailed $0.22 an hour of footage). 3.8 Flash reads the same tokens in (the same count on all 9 test
 * clips and this one); its out at Standard was measured on the video's first 3 minutes, 1733 a minute, and Light and
 * Detailed are that scaled by Flash-Lite's own ratio between levels (Light $0.46, Standard $0.64, Detailed $0.92).
 * ponytail: 3.8 Flash's Light and Detailed out are scaled, not measured: a free key's 20 calls a day ran out (Google's
 * 503s count too); measure them again once the key has billing on
 */
const MEASURED: Record<WatchModel, Record<LookLevel, { inS: number; outMin: number }>> = {
  "gemini-3.8-flash": {
    light: { inS: 59, outMin: 1349 },
    standard: { inS: 92, outMin: 1733 },
    detailed: { inS: 158, outMin: 2206 },
  },
  "gemini-3.5-flash-lite": {
    light: { inS: 59, outMin: 214 },
    standard: { inS: 92, outMin: 275 },
    detailed: { inS: 158, outMin: 350 },
  },
};

/** What an hour of footage costs to watch at `level` with `model` (dollars), from the measured tokens. */
export function watchUsdPerHour(level: LookLevel, model: WatchModel = watchModelOf(undefined)): number {
  const m = MEASURED[model][level];
  return (3600 * m.inS * PRICE[model].in + 60 * m.outMin * PRICE[model].out) / 1e6;
}

/**
 * Whether the library's last watch was stopped by a free Gemini key's daily quota (Google names the quota
 * "…free_tier…" in its answer), so its Timelines say so once.
 */
export function freeTierStopped(db: DatabaseSync, libraryId: string): boolean {
  const t = db
    .prepare("SELECT t.error FROM timelines t JOIN asset_versions v ON v.id = t.version_id JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? ORDER BY t.at DESC LIMIT 1")
    .get(libraryId) as { error: string | null } | undefined;
  return !!t?.error && /free_tier/.test(t.error);
}

/** The model a library's Timelines watch with (contracts WATCH_MODELS). */
export const libraryWatchModel = (db: DatabaseSync, libraryId: string): WatchModel =>
  watchModelOf((db.prepare("SELECT json_extract(settings, '$.timelineModel') AS v FROM libraries WHERE id = ?").get(libraryId) as { v: unknown } | undefined)?.v);

/** The actor's Gemini key, or "" (keyFor: their own, else the server's for an admin). */
export const watchKey = (actor: string | null): string => (actor ? keyFor(actor, "GEMINI_API_KEY").key : "");

/** A version's timeline row. */
interface Row {
  events: string;
  level: string | null;
  model: string | null;
  error: string | null;
  at: number;
}
const rowOf = (db: DatabaseSync, versionId: string) => db.prepare("SELECT events, level, model, error, at FROM timelines WHERE version_id = ?").get(versionId) as Row | undefined;

/** Whether `versionId` should be watched now as `actor`: Timelines on, a key, and no timeline at the library's level (one that failed: RETRY_MS later). */
export function wantsWatch(db: DatabaseSync, versionId: string, actor: string | null, now = Date.now()): boolean {
  const r = db.prepare("SELECT a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(versionId) as { library_id: string } | undefined;
  if (!r || !librarySetting(r.library_id, "timeline") || !watchKey(actor)) return false;
  const t = rowOf(db, versionId);
  if (!t) return true;
  if (t.error) return now - t.at >= RETRY_MS;
  return t.level !== libraryLookLevel(r.library_id);
}

/** A version's timeline, in order; empty when it has none. */
export function timelineOf(db: DatabaseSync, versionId: string): TimelineEvent[] {
  const t = rowOf(db, versionId);
  if (!t || t.error) return [];
  try {
    const e = JSON.parse(t.events) as unknown;
    return Array.isArray(e) ? (e as TimelineEvent[]) : [];
  } catch {
    return [];
  }
}

/** An event as one line of words: what happens, then its sound and its change. */
export const eventText = (e: TimelineEvent): string => [e.what, e.sound && `Sound: ${e.sound}`, e.change && `Change: ${e.change}`].filter(Boolean).join(". ");

/** Stores a timeline (or, with `error`, why the watch failed) and its search rows. */
export function storeTimeline(db: DatabaseSync, versionId: string, t: { events: TimelineEvent[]; level: LookLevel; model: string } | { error: string }): void {
  db.exec("BEGIN");
  try {
    if ("error" in t) {
      // a failed watch keeps a timeline made before: only its error and when are written
      db.prepare(
        "INSERT INTO timelines (version_id, error, at) VALUES (?, ?, ?) ON CONFLICT (version_id) DO UPDATE SET error = excluded.error, at = excluded.at",
      ).run(versionId, t.error.slice(0, 1000), Date.now());
    } else {
      db.prepare("INSERT OR REPLACE INTO timelines (version_id, events, level, model, error, at) VALUES (?, ?, ?, ?, NULL, ?)").run(
        versionId,
        JSON.stringify(t.events),
        t.level,
        t.model,
        Date.now(),
      );
      db.prepare("DELETE FROM search_timeline WHERE version_id = ?").run(versionId);
      const add = db.prepare("INSERT INTO search_timeline (version_id, a, text) VALUES (?, ?, ?)");
      for (const e of t.events) add.run(versionId, e.a, eventText(e));
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Seconds from "1:02", "1:02:03", "62", "62.5s" or a number; NaN when it is none of those. */
export function secondsOf(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  const t = v.trim().replace(/s$/, "");
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
}

/**
 * One part's answer as events inside a..b, in order. Times are asked from the start of the whole video; an answer
 * whose times all fit 0..(b - a) while the part starts later was counted from the part's start, and is moved there.
 * ponytail: the shift is a guess from the times alone; a part answered both ways at once keeps its mixed times clamped
 */
export function parseTimeline(text: string, a: number, b: number, sound = true): TimelineEvent[] {
  const o = parseJsonObject(text);
  const raw = Array.isArray(o.events) ? (o.events as Record<string, unknown>[]) : [];
  const cut = (x: unknown, n: number) => (typeof x === "string" ? x.trim().replace(/\s+/g, " ").slice(0, n) : "");
  let events = raw.flatMap((r) => {
    const s = secondsOf(r?.start);
    const e = secondsOf(r?.end);
    const what = cut(r?.what, WHAT_MAX);
    if (!what || !Number.isFinite(s)) return [];
    // a file with no sound track has nothing to say about sound: a note that came back anyway was made up
    const heard = sound ? cut(r.sound, NOTE_MAX) : "";
    const change = cut(r.change, NOTE_MAX);
    return [{ a: s, b: Number.isFinite(e) && e > s ? e : s, what, ...(heard ? { sound: heard } : {}), ...(change ? { change } : {}) }];
  });
  if (a > 0 && events.length && events.every((e) => e.b <= b - a + 1) && events.some((e) => e.a < a - 1)) events = events.map((e) => ({ ...e, a: e.a + a, b: e.b + a }));
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return events
    .map((e) => ({ ...e, a: r2(Math.max(a, Math.min(b, e.a))), b: r2(Math.max(a, Math.min(b, e.b))) }))
    .filter((e) => e.b > e.a || e.a < b)
    .sort((x, y) => x.a - y.a);
}

/**
 * The prompt for one part a..b of a video `dur` long. `sound` false: the file has no sound track, and the model is told
 * so (both models, asked as with sound, made up giggling, footsteps and singing over silent files: 2026-11-16).
 */
export function watchPrompt(o: { title: string; workspace: string; level: LookLevel; a: number; b: number; dur: number; sound: boolean }): { system: string; user: string } {
  const long = LOOK_LEVELS.find((l) => l.value === o.level)!.long;
  return {
    system:
      (o.sound
        ? "You watch a video with its sound for a video editor, so it can find moments by their time without watching it. "
        : "You watch a video for a video editor, so it can find moments by their time without watching it. The video has no " +
          "sound track: say nothing about what is heard, and never guess a sound from the picture. ") +
      "List what happens, in order, as events. Each has its start and end (M:SS, counted from the start of the whole video); what happens: " +
      "the subject, the action, the place and the kind of shot (wide, close, screen, text); " +
      (o.sound ? "what the sound adds, when it adds something (a hit, an explosion, a line said, music rising or dropping, a silence); " : "") +
      "and what changed from the event before " +
      `(a cut, the camera moving, a new place, a new screen). A new event starts whenever something changes, and none is longer than ${long} seconds. ` +
      `${RULE} Answer with JSON only.`,
    user: [
      ...(o.workspace ? [`The workspace the footage is for. Use it to name what is seen${o.sound ? " and heard" : ""} when the video shows it; never add what it doesn't:\n${o.workspace}`] : []),
      `“${o.title}”, ${clock(o.dur)} long${o.sound ? "" : ", with no sound"}. Watch it from ${clock(o.a)} to ${clock(o.b)}.`,
      `Answer as {"events": [{"start": "M:SS", "end": "M:SS", "what": "…", ${o.sound ? '"sound": "…", ' : ""}"change": "…"}]}`,
    ].join("\n\n"),
  };
}

/** The answer's shape; without sound it has no place for a sound note. */
const schemaOf = (sound: boolean) => ({
  type: "object",
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        properties: { start: { type: "string" }, end: { type: "string" }, what: { type: "string" }, ...(sound ? { sound: { type: "string" } } : {}), change: { type: "string" } },
        required: ["start", "end", "what"],
      },
    },
  },
  required: ["events"],
});

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".avi": "video/avi", ".mpg": "video/mpeg", ".mpeg": "video/mpeg", ".wmv": "video/wmv", ".3gp": "video/3gpp", ".flv": "video/x-flv" };

/** Gemini's error in a line: its own message when it gave one. */
/** Gemini's error in a line: its own message when it gave one (a quota's names the quota and the wait), and `waitS`, how long it asks to wait. */
async function failure(r: Response, what: string): Promise<Error & { waitS?: number }> {
  const body = await r.text().catch(() => "");
  let said = "";
  let waitS: number | undefined;
  try {
    const e = (JSON.parse(body) as { error?: { message?: string; details?: { retryDelay?: string }[] } }).error;
    said = e?.message ?? "";
    const delay = e?.details?.find((d) => d.retryDelay)?.retryDelay;
    if (delay) waitS = parseFloat(delay);
  } catch {
    /* not JSON */
  }
  return Object.assign(new Error(`Gemini ${what}: ${r.status}${said ? ` ${said.slice(0, 900)}` : ""}`), { waitS });
}

/** Uploads `file` to Gemini's Files API (resumable, one request for the bytes) and waits until it can be watched, asking every `waitMs`. */
export async function uploadVideo(key: string, file: string, display: string, waitMs = 5000): Promise<{ name: string; uri: string; mimeType: string }> {
  const blob = await openAsBlob(file);
  const mimeType = MIME[path.extname(file).toLowerCase()] ?? "video/mp4";
  const start = await fetch(`${BASE}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(blob.size),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: display.slice(0, 100) } }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!start.ok) throw await failure(start, "upload");
  const url = start.headers.get("x-goog-upload-url");
  if (!url) throw new Error("Gemini upload: no upload address");
  const up = await fetch(url, {
    method: "POST",
    headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: blob,
    signal: AbortSignal.timeout(60 * 60_000),
  });
  if (!up.ok) throw await failure(up, "upload");
  let f = ((await up.json()) as { file: { name: string; uri: string; state?: string } }).file;
  for (const until = Date.now() + 15 * 60_000; f.state !== "ACTIVE"; ) {
    if (f.state === "FAILED") throw new Error("Gemini could not read the video");
    if (Date.now() > until) throw new Error("Gemini took too long to take the video in");
    await new Promise((go) => setTimeout(go, waitMs));
    const r = await fetch(`${BASE}/v1beta/${f.name}`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw await failure(r, "upload");
    f = (await r.json()) as typeof f;
  }
  return { name: f.name, uri: f.uri, mimeType };
}
/** Drops an uploaded video from Gemini (it would go by itself after two days). */
export const deleteVideo = (key: string, name: string) =>
  fetch(`${BASE}/v1beta/${name}`, { method: "DELETE", headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(60_000) }).then(
    () => undefined,
    () => undefined,
  );

/** A stretch this long with no event in it is asked again (holesOf): three of the level's longest lines, at least a minute. */
export const holeS = (level: LookLevel): number => Math.max(60, 3 * LOOK_LEVELS.find((l) => l.value === level)!.long);

/**
 * The stretches of 0..dur that `events` leave without one, `min` seconds or longer, each cut to PART_S at most (with
 * no events and `min` 0: the whole video in parts).
 */
export function holesOf(events: TimelineEvent[], dur: number, min: number): [number, number][] {
  const gaps: [number, number][] = [];
  let end = 0;
  for (const e of [...events].sort((x, y) => x.a - y.a)) {
    if (e.a - end >= min && e.a > end) gaps.push([end, e.a]);
    end = Math.max(end, e.b);
  }
  if (dur - end >= min && dur > end) gaps.push([end, dur]);
  return gaps.flatMap(([a, b]) => Array.from({ length: Math.ceil((b - a) / PART_S) }, (_, k): [number, number] => [a + k * PART_S, Math.min(b, a + (k + 1) * PART_S)]));
}

/**
 * POSTs `body` and waits up to `ms` for the whole answer. Not fetch: it gives up after five minutes without the answer's
 * headers ("fetch failed"), and a busy Gemini sends none until the call leaves its queue.
 */
function longPost(url: string, headers: Record<string, string>, body: string, ms: number): Promise<Response> {
  return new Promise((done, fail) => {
    const req = https.request(url, { method: "POST", headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        clearTimeout(t);
        done(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500 }));
      });
      res.on("error", fail);
    });
    const t = setTimeout(() => req.destroy(new Error(`no answer in ${Math.round(ms / 60_000)} minutes`)), ms);
    req.on("error", (e) => {
      clearTimeout(t);
      fail(e);
    });
    req.end(body);
  });
}

/** One part's call: its events and what it cost. */
async function askPart(key: string, model: WatchModel, f: { uri: string; mimeType: string }, prompt: { system: string; user: string }, a: number, b: number, level: LookLevel, sound: boolean) {
  const { fps, res } = WATCH_LEVELS[level];
  // a busy model (measured: a 503 "high demand" after 109 s at Detailed) or a dropped connection is asked again later
  for (let i = 0; ; i++) {
    const p = parkedOf(key);
    if (p) throw new Error(p.said);
    const r = await callPart(key, model, f, prompt, a, b, fps, res, sound).catch((e: unknown) => {
      if (i >= RETRIES) throw new Error(`Gemini watch: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    if (r?.ok) return answerOf(r, model, a, b, sound);
    if (r) {
      const e = await failure(r, "watch");
      // a quota that asks for a longer wait than ours (measured: a free key's 20 calls a day, "retry in 4h") is not
      // asked again here: the watch fails and is tried again RETRY_MS later
      if ((e.waitS ?? 0) * 1000 > watchTiming.backoffMs * 3 ** i) {
        parked.set(key, { until: Date.now() + (e.waitS ?? 0) * 1000, said: e.message });
        throw e;
      }
      if (!BUSY.includes(r.status) || i >= RETRIES) throw e;
    }
    await new Promise((go) => setTimeout(go, watchTiming.backoffMs * 3 ** i));
  }
}

const callPart = (key: string, model: WatchModel, f: { uri: string; mimeType: string }, prompt: { system: string; user: string }, a: number, b: number, fps: number, res: string, sound: boolean) =>
  watchTiming.post(
    `${BASE}/v1beta/models/${model}:generateContent`,
    { "x-goog-api-key": key, "Content-Type": "application/json" },
    JSON.stringify({
      systemInstruction: { parts: [{ text: prompt.system }] },
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { fileUri: f.uri, mimeType: f.mimeType }, videoMetadata: { startOffset: `${Math.floor(a)}s`, endOffset: `${Math.ceil(b)}s`, fps } },
            { text: prompt.user },
          ],
        },
      ],
      generationConfig: { mediaResolution: res, responseMimeType: "application/json", responseJsonSchema: schemaOf(sound) },
    }),
    CALL_MS,
  );

/** A part's answer: its events inside a..b and what it cost. */
async function answerOf(r: Response, model: WatchModel, a: number, b: number, sound: boolean) {
  const body = (await r.json()) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  };
  const text = (body.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join("");
  const u = body.usageMetadata ?? {};
  const out = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  const usage = { tokens: (u.promptTokenCount ?? 0) + out, costUsd: ((u.promptTokenCount ?? 0) * PRICE[model].in + out * PRICE[model].out) / 1e6 };
  return { events: parseTimeline(text, a, b, sound), usage, inTokens: u.promptTokenCount ?? 0, outTokens: out };
}

/**
 * Watches `file` (a version's proxy, else its original; a Mac's copy) on the actor's Gemini key and stores its
 * timeline: uploaded once, asked in parts of PART_S (PARTS_AT_ONCE at a time) with the library's model, each call
 * tallied as WATCH_LABEL under the version's workspace, the upload dropped after. A file with no sound track is watched
 * as one (watchPrompt). Throws when it fails (watchAfter keeps the error).
 */
export async function watchVersion(
  db: DatabaseSync,
  versionId: string,
  file: string,
  actor: string,
): Promise<{ events: number; usd: number; ms: number; sound: boolean; inTokens: number; outTokens: number }> {
  const key = watchKey(actor);
  if (!key) throw new Error("Needs a Gemini API key");
  // a key whose quota ran out: nothing is uploaded or asked until its wait is over (the watch is tried again RETRY_MS later)
  const p = parkedOf(key);
  if (p) throw new Error(p.said);
  const t0 = Date.now();
  const v = db
    .prepare("SELECT a.title, a.library_id, v.probe FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?")
    .get(versionId) as { title: string; library_id: string; probe: string | null };
  const dur = Number((JSON.parse(v.probe ?? "null") as { duration?: number } | null)?.duration) || 0;
  const level = libraryLookLevel(v.library_id);
  const model = libraryWatchModel(db, v.library_id);
  const sound = await hasSound(file);
  const wsId = await workspaceIdOf(db, versionId);
  const workspace = wsId ? await workspaceContext(wsId, WORKSPACE_MAX) : "";
  const length = Math.max(dur, 1);
  const f = await uploadVideo(key, file, v.title);
  let usd = 0;
  let inTokens = 0;
  let outTokens = 0;
  /** The events of each range, asked PARTS_AT_ONCE at a time, each call tallied. */
  const ask = async (ranges: [number, number][]) => {
    const found: TimelineEvent[] = [];
    for (let i = 0; i < ranges.length; i += PARTS_AT_ONCE)
      for (const events of await Promise.all(
        ranges.slice(i, i + PARTS_AT_ONCE).map(async ([a, b]) => {
          const r = await askPart(key, model, f, watchPrompt({ title: v.title, workspace, level, a, b, dur, sound }), a, b, level, sound);
          usd += r.usage.costUsd;
          inTokens += r.inTokens;
          outTokens += r.outTokens;
          void recordUsage(WATCH_LABEL, r.usage, undefined, "workspace", wsId ?? null);
          return r.events;
        }),
      ))
        found.push(...events);
    return found;
  };
  try {
    let events = await ask(holesOf([], length, 0));
    // a stretch the answers left without an event is asked once more on its own
    const holes = holesOf(events, length, holeS(level));
    if (holes.length) events = [...events, ...(await ask(holes))].sort((x, y) => x.a - y.a);
    if (!events.length) throw new Error("Gemini named nothing that happens in the video");
    storeTimeline(db, versionId, { events, level, model });
    return { events: events.length, usd, ms: Date.now() - t0, sound, inTokens, outTokens };
  } finally {
    await deleteVideo(key, f.name);
  }
}

/**
 * After a look: the timeline of `versionId` when it wants one (wantsWatch), from the file `src` gives. It runs beside
 * the look lane, at most WATCHES_AT_ONCE at a time (one more waits for the sweep, sweepWatch; a copy a Mac sent, `sent`,
 * is watched anyway: asked for again, the Mac would read the whole file again): the look's job is done when this starts. `src` is asked at once; the promise ends with the watch. A failure is kept on the version (tried
 * again RETRY_MS later) and never thrown. New words: its search by meaning is made again.
 * ponytail: a watch in flight when the server restarts is lost and asked again by the sweep, paid twice
 */
export function watchAfter(db: DatabaseSync, versionId: string, src: () => Promise<string>, actor: string | null, sent = false): Promise<void> {
  if (!actor || watching.has(versionId) || (!sent && watching.size >= WATCHES_AT_ONCE) || !wantsWatch(db, versionId, actor)) return Promise.resolve();
  const run = (async () => {
    try {
      const r = await watchVersion(db, versionId, await src(), actor);
      console.log(`[library] timeline of ${versionId}: ${r.events} events, $${r.usd.toFixed(4)}, ${Math.round(r.ms / 1000)} s`);
    } catch (e) {
      storeTimeline(db, versionId, { error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const lib = (db.prepare("SELECT a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(versionId) as { library_id: string } | undefined)?.library_id;
    if (lib && librarySetting(lib, "embed") && canEmbed(actor)) enqueueJob(db, lib, versionId, "embed", actor, true);
  })().finally(() => watching.delete(versionId));
  watching.set(versionId, run);
  return run;
}

/** When the sweep may look at a version again (ms). */
const swept = new Map<string, number>();

/**
 * Timelines as a background index: the next video whose look is done that wants a timeline (Timelines switched on, or a
 * key added, after its look; a level changed; a failed watch whose wait is over) gets its look queued again as its
 * uploader: the look finds its lines current and goes on to the watch. True when it queued one.
 */
export function sweepWatch(db: DatabaseSync, queueLook: (versionId: string, actor: string) => boolean, now = Date.now()): boolean {
  if (watching.size >= WATCHES_AT_ONCE) return false;
  const rows = db
    .prepare(
      `SELECT v.id, v.created_by AS actor FROM assets a JOIN asset_versions v ON v.id = a.current_version_id
         JOIN jobs j ON j.version_id = v.id AND j.kind = 'look' AND j.state = 'done'
         JOIN libraries l ON l.id = a.library_id LEFT JOIN timelines t ON t.version_id = v.id
       WHERE a.trashed_at IS NULL AND v.created_by IS NOT NULL AND IFNULL(json_extract(l.settings, '$.timeline'), 1)
         AND (t.version_id IS NULL OR (t.error IS NOT NULL AND t.at <= ?) OR (t.error IS NULL AND IFNULL(t.level, '') != IFNULL(json_extract(l.settings, '$.lookLevel'), 'standard')))
       ORDER BY v.created_at DESC LIMIT 50`,
    )
    .all(now - RETRY_MS) as { id: string; actor: string }[];
  for (const r of rows) {
    if ((swept.get(r.id) ?? 0) > now || watching.has(r.id)) continue;
    swept.set(r.id, now + RETRY_MS);
    if (!watchKey(r.actor)) continue;
    if (queueLook(r.id, r.actor)) return true;
  }
  return false;
}
