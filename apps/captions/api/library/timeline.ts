import { openAsBlob } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { LOOK_LEVELS, type LookLevel, type TimelineEvent } from "../../contracts/library";
import { keyFor } from "../my-keys";
import { recordUsage } from "../lib/mac-claude";
import { workspaceContext } from "../lib/workshop/context";
import { parseJsonObject } from "../lib/instagram/vision";
import { libraryLookLevel, librarySetting } from "./db";
import { WORKSPACE_MAX, workspaceIdOf } from "./describe";
import { canEmbed } from "./embed";
import { enqueueJob } from "./jobs";
import { clock, RULE } from "./look";
import { WATCH_LABEL } from "./shots";

/**
 * Timelines: Gemini watches a video with its sound and says what happens when (contracts TimelineEvent), on top of the
 * shot descriptions. It runs in the look job (worker.ts), after the look, as the look's actor and on their own Gemini
 * key (Settings → API keys); with no key, or the library's Timelines off, nothing here runs and the look is as before.
 * The file sent is the one the look read: the proxy when there is one. A file kept on a Mac with nothing uploaded is
 * sent by that Mac to this server as a small copy made for it (mac-look.ts), so the key stays on the server and the call
 * is counted in the usage tally and the library's monthly budget like the look's own. A watch that fails never fails the
 * look: its error is kept and it is tried again RETRY_MS later (sweepWatch).
 */

/** The cheapest model that watches video with sound per hour (paid tier, 2026-11-16: one rate for video, audio and text). */
export const WATCH_MODEL = "gemini-3.5-flash-lite";
/** Dollars per million tokens, in and out (thinking counted as out). */
const PRICE = { in: 0.3, out: 2.5 };
const BASE = "https://generativelanguage.googleapis.com";
/** Tokens a sampled frame costs at each media resolution, and a second of sound (Gemini's video docs). */
const FRAME_TOKENS = { MEDIA_RESOLUTION_LOW: 66, MEDIA_RESOLUTION_MEDIUM: 258 } as const;
const AUDIO_TOKENS_S = 32;
/** Per level (contracts LOOK_LEVELS): frames a second Gemini samples, at what resolution. */
export const WATCH_LEVELS: Record<LookLevel, { fps: number; res: keyof typeof FRAME_TOKENS }> = {
  light: { fps: 0.5, res: "MEDIA_RESOLUTION_LOW" },
  standard: { fps: 1, res: "MEDIA_RESOLUTION_LOW" },
  detailed: { fps: 2, res: "MEDIA_RESOLUTION_MEDIUM" },
};
/** One call covers this much of the video (its start and end offsets), so an hour's events fit one answer and Detailed fits the context. */
export const PART_S = 20 * 60;
/** Parts of one video asked at once. */
const PARTS_AT_ONCE = 3;
/** A watch that failed is tried again this long after. */
export const RETRY_MS = 6 * 3600_000;
/** Caps on an event's words. */
const WHAT_MAX = 200;
const NOTE_MAX = 120;
/** Output tokens a minute of footage takes, guessed for the estimate until a real run is measured. */
const OUT_TOKENS_MIN = 400;

/** What an hour of footage costs to watch at `level` (dollars), from the token rates. */
export function watchUsdPerHour(level: LookLevel): number {
  const { fps, res } = WATCH_LEVELS[level];
  const inTokens = 3600 * (fps * FRAME_TOKENS[res] + AUDIO_TOKENS_S);
  return (inTokens * PRICE.in + 60 * OUT_TOKENS_MIN * PRICE.out) / 1e6;
}

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
      ).run(versionId, t.error.slice(0, 500), Date.now());
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
export function parseTimeline(text: string, a: number, b: number): TimelineEvent[] {
  const o = parseJsonObject(text);
  const raw = Array.isArray(o.events) ? (o.events as Record<string, unknown>[]) : [];
  const cut = (x: unknown, n: number) => (typeof x === "string" ? x.trim().replace(/\s+/g, " ").slice(0, n) : "");
  let events = raw.flatMap((r) => {
    const s = secondsOf(r?.start);
    const e = secondsOf(r?.end);
    const what = cut(r?.what, WHAT_MAX);
    if (!what || !Number.isFinite(s)) return [];
    const sound = cut(r.sound, NOTE_MAX);
    const change = cut(r.change, NOTE_MAX);
    return [{ a: s, b: Number.isFinite(e) && e > s ? e : s, what, ...(sound ? { sound } : {}), ...(change ? { change } : {}) }];
  });
  if (a > 0 && events.length && events.every((e) => e.b <= b - a + 1) && events.some((e) => e.a < a - 1)) events = events.map((e) => ({ ...e, a: e.a + a, b: e.b + a }));
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return events
    .map((e) => ({ ...e, a: r2(Math.max(a, Math.min(b, e.a))), b: r2(Math.max(a, Math.min(b, e.b))) }))
    .filter((e) => e.b > e.a || e.a < b)
    .sort((x, y) => x.a - y.a);
}

/** The prompt for one part a..b of a video `dur` long. */
export function watchPrompt(o: { title: string; workspace: string; level: LookLevel; a: number; b: number; dur: number }): { system: string; user: string } {
  const long = LOOK_LEVELS.find((l) => l.value === o.level)!.long;
  return {
    system:
      "You watch a video with its sound for a video editor, so it can find moments by their time without watching it. List what " +
      "happens, in order, as events. Each has its start and end (M:SS, counted from the start of the whole video); what happens: " +
      "the subject, the action, the place and the kind of shot (wide, close, screen, text); what the sound adds, when it adds " +
      "something (a hit, an explosion, a line said, music rising or dropping, a silence); and what changed from the event before " +
      `(a cut, the camera moving, a new place, a new screen). A new event starts whenever something changes, and none is longer than ${long} seconds. ` +
      `${RULE} Answer with JSON only.`,
    user: [
      ...(o.workspace ? [`The workspace the footage is for. Use it to name what is seen and heard when the video shows it; never add what it doesn't:\n${o.workspace}`] : []),
      `“${o.title}”, ${clock(o.dur)} long. Watch it from ${clock(o.a)} to ${clock(o.b)}.`,
      'Answer as {"events": [{"start": "M:SS", "end": "M:SS", "what": "…", "sound": "…", "change": "…"}]}',
    ].join("\n\n"),
  };
}

const SCHEMA = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        properties: { start: { type: "string" }, end: { type: "string" }, what: { type: "string" }, sound: { type: "string" }, change: { type: "string" } },
        required: ["start", "end", "what"],
      },
    },
  },
  required: ["events"],
};

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".avi": "video/avi", ".mpg": "video/mpeg", ".mpeg": "video/mpeg", ".wmv": "video/wmv", ".3gp": "video/3gpp", ".flv": "video/x-flv" };

/** Gemini's error in a line: its own message when it gave one. */
async function failure(r: Response, what: string): Promise<Error> {
  const body = await r.text().catch(() => "");
  let said = "";
  try {
    said = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? "";
  } catch {
    /* not JSON */
  }
  return new Error(`Gemini ${what}: ${r.status}${said ? ` ${said.slice(0, 300)}` : ""}`);
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

/** One part's call: its events and what it cost. */
async function askPart(key: string, f: { uri: string; mimeType: string }, prompt: { system: string; user: string }, a: number, b: number, level: LookLevel) {
  const { fps, res } = WATCH_LEVELS[level];
  const r = await fetch(`${BASE}/v1beta/models/${WATCH_MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
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
      generationConfig: { mediaResolution: res, responseMimeType: "application/json", responseJsonSchema: SCHEMA },
    }),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!r.ok) throw await failure(r, "watch");
  const body = (await r.json()) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  };
  const text = (body.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join("");
  const u = body.usageMetadata ?? {};
  const out = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  const usage = { tokens: (u.promptTokenCount ?? 0) + out, costUsd: ((u.promptTokenCount ?? 0) * PRICE.in + out * PRICE.out) / 1e6 };
  return { events: parseTimeline(text, a, b), usage };
}

/**
 * Watches `file` (a version's proxy, else its original; a Mac's copy) on the actor's Gemini key and stores its
 * timeline: uploaded once, asked in parts of PART_S (PARTS_AT_ONCE at a time), each call tallied as WATCH_LABEL under
 * the version's workspace, the upload dropped after. Throws when it fails (watchAfter keeps the error).
 */
export async function watchVersion(db: DatabaseSync, versionId: string, file: string, actor: string): Promise<{ events: number; usd: number; ms: number }> {
  const key = watchKey(actor);
  if (!key) throw new Error("Needs a Gemini API key");
  const t0 = Date.now();
  const v = db
    .prepare("SELECT a.title, a.library_id, v.probe FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?")
    .get(versionId) as { title: string; library_id: string; probe: string | null };
  const dur = Number((JSON.parse(v.probe ?? "null") as { duration?: number } | null)?.duration) || 0;
  const level = libraryLookLevel(v.library_id);
  const wsId = await workspaceIdOf(db, versionId);
  const workspace = wsId ? await workspaceContext(wsId, WORKSPACE_MAX) : "";
  const parts: [number, number][] = [];
  for (let a = 0; a < Math.max(dur, 1); a += PART_S) parts.push([a, Math.min(Math.max(dur, 1), a + PART_S)]);
  const f = await uploadVideo(key, file, v.title);
  let usd = 0;
  try {
    const found: TimelineEvent[][] = [];
    for (let i = 0; i < parts.length; i += PARTS_AT_ONCE)
      found.push(
        ...(await Promise.all(
          parts.slice(i, i + PARTS_AT_ONCE).map(async ([a, b]) => {
            const r = await askPart(key, f, watchPrompt({ title: v.title, workspace, level, a, b, dur }), a, b, level);
            usd += r.usage.costUsd;
            void recordUsage(WATCH_LABEL, r.usage, undefined, "workspace", wsId ?? null);
            return r.events;
          }),
        )),
      );
    const events = found.flat();
    if (!events.length) throw new Error("Gemini named nothing that happens in the video");
    storeTimeline(db, versionId, { events, level, model: WATCH_MODEL });
    return { events: events.length, usd, ms: Date.now() - t0 };
  } finally {
    await deleteVideo(key, f.name);
  }
}

/**
 * After a look: the timeline of `versionId` when it wants one (wantsWatch), from the file `src` gives. A failure is
 * kept on the version (tried again RETRY_MS later) and never thrown, so the look stays done. New words: its search by
 * meaning is made again.
 */
export async function watchAfter(db: DatabaseSync, versionId: string, src: () => Promise<string>, actor: string | null): Promise<void> {
  if (!actor || !wantsWatch(db, versionId, actor)) return;
  try {
    const r = await watchVersion(db, versionId, await src(), actor);
    console.log(`[library] timeline of ${versionId}: ${r.events} events, $${r.usd.toFixed(4)}, ${Math.round(r.ms / 1000)} s`);
  } catch (e) {
    storeTimeline(db, versionId, { error: e instanceof Error ? e.message : String(e) });
    return;
  }
  const lib = (db.prepare("SELECT a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(versionId) as { library_id: string }).library_id;
  if (librarySetting(lib, "embed") && canEmbed(actor)) enqueueJob(db, lib, versionId, "embed", actor, true);
}

/** When the sweep may look at a version again (ms). */
const swept = new Map<string, number>();

/**
 * Timelines as a background index: the next video whose look is done that wants a timeline (Timelines switched on, or a
 * key added, after its look; a level changed; a failed watch whose wait is over) gets its look queued again as its
 * uploader: the look finds its lines current and goes on to the watch. True when it queued one.
 */
export function sweepWatch(db: DatabaseSync, queueLook: (versionId: string, actor: string) => boolean, now = Date.now()): boolean {
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
    if ((swept.get(r.id) ?? 0) > now) continue;
    swept.set(r.id, now + RETRY_MS);
    if (!watchKey(r.actor)) continue;
    if (queueLook(r.id, r.actor)) return true;
  }
  return false;
}
