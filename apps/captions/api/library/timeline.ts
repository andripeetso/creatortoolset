import { openAsBlob } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { LOOK_LEVELS, watchModelOf, type GeminiModel, type LookLevel, type TimelineEvent, type WatchModel } from "../../contracts/library";
import { completeWithFallback, type ProviderOpts } from "../ai-complete";
import { creditBack, creditChoice, creditOut, type CreditChoice } from "../credits";
import { keyFor } from "../my-keys";
import { MacClaudeError, recordUsage, usageIn } from "../lib/mac-claude";
import { recordService } from "../lib/service-usage";
import { ownSettings, providerSettings, routeForInstance, runFields } from "../lib/providers";
import { findUser } from "../users";
import { workspaceContext } from "../lib/workshop/context";
import { parseJsonObject } from "../lib/instagram/vision";
import { libraryChanged, libraryRole } from "./access";
import { libraryLookLevel, librarySetting, sinceSql } from "./db";
import { WORKSPACE_MAX, workspaceIdOf } from "./describe";
import { canEmbed } from "./embed";
import { enqueueJob } from "./jobs";
import { clock, RULE } from "./look";
import { hasSound } from "./media/probe";
import { ffmpeg } from "./media/run";
import { LOOK_LABEL, WATCH_LABEL } from "./shots";

/**
 * Timelines: Gemini watches a video with its sound and says what happens when (contracts TimelineEvent), on top of the
 * shot descriptions. It runs in the look job (worker.ts), after the look, as the look's actor and on their own Gemini
 * key (Settings → API keys); with no key, or the library's Timelines off, nothing here runs and the look is as before.
 * The file sent is the one the look read: the proxy when there is one. A file kept on a Mac with nothing uploaded is
 * sent by that Mac to this server as a small copy made for it (mac-look.ts), so the key stays on the server and the call
 * is counted in the usage tally like the look's own. A watch that fails never fails the
 * look: its error is kept and it is tried again RETRY_MS later (sweepWatch). A watch runs beside the look lane, never in
 * it (watchAfter): a busy model can keep one call waiting for minutes.
 * The library's Timelines may watch on Antigravity instead (WATCH_MODELS), the person's own AI provider signed in with
 * Google, no key: picture only (askAntigravity).
 */

/**
 * Dollars per million tokens, in and out (thinking counted as out), paid tier, one rate for video, audio and text.
 * Read 2026-11-16 off Google's price list; 3.8 Flash's doubles on 2027-01-01 (1.5 in, 7.5 out).
 */
export const GEMINI_PRICE: Record<GeminiModel, { in: number; out: number }> = {
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
 * Keys whose quota ran out (Gemini's 429 with a wait longer than ours) or whose prepaid credit did (CREDIT_GONE, until the
 * next try RETRY_MS later), until when and Gemini's words: no call is made on one before then, not the next part's, not
 * another video's (parked).
 * ponytail: in memory; a restart asks once more and is told again
 */
export const parked = new Map<string, { until: number; said: string }>();
const parkedOf = (key: string) => {
  const p = parked.get(key);
  return p && p.until > Date.now() ? p : null;
};
/**
 * Videos watched at once on a Gemini key: a call can wait minutes in Gemini's queue, so many run side by side (a key's
 * rate limit answers 429, which backs off and parks the key). On Antigravity three: each run starts a program on the Mac.
 */
const WATCHES_AT_ONCE = 16;
const ANTIGRAVITY_AT_ONCE = 3;
const watchesAtOnce = (db: DatabaseSync, libraryId: string, actor: string | null): number =>
  libraryWatchModel(db, libraryId) === "antigravity" || onAntigravity(actor) ? ANTIGRAVITY_AT_ONCE : WATCHES_AT_ONCE;
/** Parts of one video asked at once. */
const PARTS_AT_ONCE = 3;
/** A watch that failed is tried again this long after. */
export const RETRY_MS = 6 * 3600_000;
/**
 * A key's prepaid credit ran out (Google AI Studio's prepay: a 402, or before a 429, "Your prepayment credits are
 * depleted"). Not Gemini's own "exceeded your current quota": that is a rate or a free tier, said with a wait.
 */
const DEPLETED = /prepayment credits|credits are depleted/i;
/** How a watch stopped by an empty credit starts its error (watchStopped reads it). */
const CREDIT_GONE = "The Gemini credit ran out";
/** Caps on an event's words. */
const WHAT_MAX = 200;
const NOTE_MAX = 120;
/**
 * Tokens in a second of footage and out a minute of it (thinking included), by model and level, on an 11:39
 * public-domain NASA video with sound (720p proxy), each level one whole watch through watchVersion, the stretches asked
 * again included. Flash-Lite, 2026-11-16/17: Light $0.10, Standard $0.14, Detailed $0.22 an hour of footage. 3.8 Flash,
 * 2026-11-17 on a key with billing on: Light $0.29, Standard $0.38, Detailed $0.81 (its Detailed watch asked a stretch
 * again, hence the more tokens in). An earlier 1733 out a minute at Standard came from the video's first 3 minutes only.
 */
const MEASURED: Record<GeminiModel, Record<LookLevel, { inS: number; outMin: number }>> = {
  "gemini-3.8-flash": {
    light: { inS: 59, outMin: 569 },
    standard: { inS: 92, outMin: 593 },
    detailed: { inS: 185, outMin: 1363 },
  },
  "gemini-3.5-flash-lite": {
    light: { inS: 59, outMin: 214 },
    standard: { inS: 92, outMin: 275 },
    detailed: { inS: 158, outMin: 350 },
  },
};

/** What an hour of footage costs to watch at `level` with `model` (dollars), from the measured tokens; nothing on Antigravity (a subscription). */
export function watchUsdPerHour(level: LookLevel, model: WatchModel = watchModelOf(undefined)): number {
  if (model === "antigravity") return 0;
  const m = MEASURED[model][level];
  return (3600 * m.inS * GEMINI_PRICE[model].in + 60 * m.outMin * GEMINI_PRICE[model].out) / 1e6;
}

/**
 * What stopped the library's last watch, so its Timelines say so once: a free Gemini key's daily quota (Google names the
 * quota "…free_tier…" in its answer), or the key's prepaid credit running out.
 */
export function watchStopped(db: DatabaseSync, libraryId: string): "free" | "credit" | null {
  const t = db
    .prepare("SELECT t.error FROM timelines t JOIN asset_versions v ON v.id = t.version_id JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? ORDER BY t.at DESC LIMIT 1")
    .get(libraryId) as { error: string | null } | undefined;
  return t?.error?.startsWith(CREDIT_GONE) ? "credit" : t?.error && /free_tier/.test(t.error) ? "free" : null;
}

/** The model a library's Timelines watch with (contracts WATCH_MODELS). */
export const libraryWatchModel = (db: DatabaseSync, libraryId: string): WatchModel =>
  watchModelOf((db.prepare("SELECT json_extract(settings, '$.timelineModel') AS v FROM libraries WHERE id = ?").get(libraryId) as { v: unknown } | undefined)?.v);

/** The actor's Gemini key, or "" (keyFor: their own, else the server's for an admin). */
export const watchKey = (actor: string | null): string => (actor ? keyFor(actor, "GEMINI_API_KEY").key : "");

/**
 * The actor's Antigravity as the route of one watch, or null when they have none that runs: their own provider, else
 * for an admin the workspace's. `fixed`: a quota never moves the call to another AI. `once`: the video part goes with
 * the request and is not kept on the Mac.
 */
export function antigravityRoute(actor: string | null): ProviderOpts | null {
  if (!actor) return null;
  const admin = findUser(actor)?.role === "admin";
  for (const inst of [ownSettings(actor), admin ? providerSettings() : null].flatMap((s) => s?.instances ?? [])) {
    if (inst.driver !== "antigravity" || !inst.enabled) continue;
    const r = routeForInstance(actor, admin, "library", { instance: inst.id, model: inst.model ?? "", effort: "medium" });
    if (r?.instance.id !== inst.id) continue;
    return {
      only: ["mac"],
      fixed: true,
      mac: {
        label: AGY_LABEL,
        background: true,
        once: true,
        provider: { instance: inst.id, driver: inst.driver, home: inst.home, model: r.selection.model, effort: r.selection.effort, device: r.device, scope: r.scope, ...runFields(inst) },
      },
    };
  }
  return null;
}
const AGY_LABEL = `${LOOK_LABEL} (Antigravity)`;

/**
 * Whether `actor`'s watches go to their Antigravity while their Gemini key's credit is out: its owner picked it on Home's
 * Activity (credits.ts), the key is parked and Antigravity runs. Once the key works again (creditBack), back to the key.
 */
function onAntigravity(actor: string | null): boolean {
  const key = watchKey(actor);
  return !!parkedOf(key) && creditChoice("GEMINI_API_KEY", key, actor) === "antigravity" && !!antigravityRoute(actor);
}

/**
 * `username` picked what happens to their own timelines waiting on their Gemini credit (chooseCredit; a key's other
 * owners pick for theirs): on Antigravity, those waits end now (the sweep asks them again); without, Timelines are switched off in the libraries
 * `username` owns that hold one. Answers those libraries.
 */
export function creditWaitsChosen(db: DatabaseSync, username: string, choice: CreditChoice): string[] {
  const rows = db
    .prepare(
      `SELECT t.version_id AS v, a.library_id AS lib FROM timelines t JOIN asset_versions v ON v.id = t.version_id JOIN assets a ON a.id = v.asset_id
       WHERE t.error LIKE ? AND v.created_by = ?`,
    )
    .all(`${CREDIT_GONE}%`, username) as { v: string; lib: string }[];
  if (choice === "antigravity") {
    for (const r of rows) {
      db.prepare("UPDATE timelines SET at = 0 WHERE version_id = ?").run(r.v);
      swept.delete(r.v);
    }
    return [];
  }
  const libs = [...new Set(rows.map((r) => r.lib))].filter((lib) => libraryRole(username, lib) === "owner");
  for (const lib of libs) {
    db.prepare("UPDATE libraries SET settings = json_set(settings, '$.timeline', json('false')) WHERE id = ?").run(lib);
    libraryChanged(lib);
  }
  return libs;
}

/** Whether `actor` can watch in this library: a Gemini key, or with Antigravity picked, an Antigravity that runs. */
export const canWatch = (db: DatabaseSync, libraryId: string, actor: string | null): boolean =>
  libraryWatchModel(db, libraryId) === "antigravity" ? !!antigravityRoute(actor) : !!watchKey(actor);

/** A version's timeline row. */
interface Row {
  events: string;
  level: string | null;
  model: string | null;
  error: string | null;
  at: number;
}
const rowOf = (db: DatabaseSync, versionId: string) => db.prepare("SELECT events, level, model, error, at FROM timelines WHERE version_id = ?").get(versionId) as Row | undefined;

/**
 * Clips someone asked a timeline for by name (Make timeline on the clip): watched with the library's Timelines off too,
 * a failed one at once, and past WATCHES_AT_ONCE. Taken off when its watch ends.
 * shortcut: kept in memory, so a restart before the look job runs forgets the ask; store it if that is ever seen
 */
export const askedWatch = new Set<string>();

const PRESSED_AT = "IFNULL(json_extract(l.settings, '$.timelineAsked'), -1)";
/**
 * SQL on the library `l`, the version `v` and its timeline `t` (LEFT JOIN): Make for the missing timelines (made.ts) covers
 * `v`: it was in the library then, with no timeline or one whose watch had failed. A watch that fails after it is not tried again.
 */
const PRESSED = `(v.created_at <= ${PRESSED_AT} AND (t.version_id IS NULL OR (t.error IS NOT NULL AND t.at < ${PRESSED_AT})))`;
/** SQL, the same: Timelines is on and `v` was added since it went on (db.ts SINCE). */
const AUTO = `(IFNULL(json_extract(l.settings, '$.timeline'), 1) AND ${sinceSql("timeline")})`;

/**
 * Whether `versionId` should be watched now as `actor`: asked for by name (askedWatch), covered by Make for the missing,
 * or added since Timelines went on; what watches (canWatch); and no timeline at the library's level (one that failed:
 * RETRY_MS later, or at once when Make for the missing was pressed since).
 */
export function wantsWatch(db: DatabaseSync, versionId: string, actor: string | null, now = Date.now()): boolean {
  const r = db
    .prepare(
      `SELECT a.library_id, ${PRESSED} AS pressed, ${AUTO} AS auto FROM asset_versions v JOIN assets a ON a.id = v.asset_id
         JOIN libraries l ON l.id = a.library_id LEFT JOIN timelines t ON t.version_id = v.id WHERE v.id = ?`,
    )
    .get(versionId) as { library_id: string; pressed: number; auto: number } | undefined;
  const asked = askedWatch.has(versionId);
  if (!r || !(asked || r.pressed || r.auto) || !canWatch(db, r.library_id, actor)) return false;
  const t = rowOf(db, versionId);
  if (!t) return true;
  if (t.error) return asked || !!r.pressed || now - t.at >= RETRY_MS;
  // a picture-only timeline is made again with its sound once the library watches on a Gemini key that has credit
  return (
    t.level !== libraryLookLevel(r.library_id) ||
    (t.model === "antigravity" && libraryWatchModel(db, r.library_id) !== "antigravity" && creditChoice("GEMINI_API_KEY", watchKey(actor), actor) !== "antigravity")
  );
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
export function watchPrompt(o: { title: string; workspace: string; level: LookLevel; a: number; b: number; dur: number; sound: boolean; file?: string }): { system: string; user: string } {
  const long = LOOK_LEVELS.find((l) => l.value === o.level)!.long;
  return {
    system:
      (o.sound
        ? "You watch a video with its sound for a video editor, so it can find moments by their time without watching it. "
        : "You watch a video for a video editor, so it can find moments by their time without watching it. The video has no " +
          "sound track: say nothing about what is heard, and never guess a sound from the picture. ") +
      `List what happens, in order, as events. Each has its start and end (M:SS, counted from the start of the ${o.file ? "file" : "whole video"}); what happens: ` +
      "the subject, the action, the place and the kind of shot (wide, close, screen, text); " +
      (o.sound ? "what the sound adds, when it adds something (a hit, an explosion, a line said, music rising or dropping, a silence); " : "") +
      "and what changed from the event before " +
      `(a cut, the camera moving, a new place, a new screen). A new event starts whenever something changes, and none is longer than ${long} seconds. ` +
      `${RULE} Answer with JSON only.`,
    user: [
      ...(o.workspace ? [`The workspace the footage is for. Use it to name what is seen${o.sound ? " and heard" : ""} when the video shows it; never add what it doesn't:\n${o.workspace}`] : []),
      o.file
        ? `“${o.title}”, ${clock(o.dur)} long. The file ${o.file} in the current folder is its part from ${clock(o.a)} to ${clock(o.b)}, with no sound: open it with your file-reading tool and watch all of it.`
        : `“${o.title}”, ${clock(o.dur)} long${o.sound ? "" : ", with no sound"}. Watch it from ${clock(o.a)} to ${clock(o.b)}.`,
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
async function askPart(key: string, model: GeminiModel, f: { uri: string; mimeType: string }, prompt: { system: string; user: string }, a: number, b: number, level: LookLevel, sound: boolean) {
  const { fps, res } = WATCH_LEVELS[level];
  // a busy model (measured: a 503 "high demand" after 109 s at Detailed) or a dropped connection is asked again later
  for (let i = 0; ; i++) {
    const p = parkedOf(key);
    if (p) throw new Error(p.said);
    const r = await callPart(key, model, f, prompt, a, b, fps, res, sound).catch((e: unknown) => {
      if (i >= RETRIES) throw new Error(`Gemini watch: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    if (r?.ok) {
      creditBack("GEMINI_API_KEY", key);
      return answerOf(r, model, a, b, sound);
    }
    if (r) {
      const e = await failure(r, "watch");
      // an empty credit: no call on the key until the watch is tried again, and its owner is told (credits.ts)
      if (r.status === 402 || DEPLETED.test(e.message)) {
        const said = `${CREDIT_GONE}: ${e.message}`;
        parked.set(key, { until: Date.now() + RETRY_MS, said });
        creditOut("GEMINI_API_KEY", key, "Media Library video breakdowns");
        throw new Error(said);
      }
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

const callPart = (key: string, model: GeminiModel, f: { uri: string; mimeType: string }, prompt: { system: string; user: string }, a: number, b: number, fps: number, res: string, sound: boolean) =>
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
async function answerOf(r: Response, model: GeminiModel, a: number, b: number, sound: boolean) {
  const body = (await r.json()) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  };
  const text = (body.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join("");
  const u = body.usageMetadata ?? {};
  const out = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  const usage = { tokens: (u.promptTokenCount ?? 0) + out, costUsd: ((u.promptTokenCount ?? 0) * GEMINI_PRICE[model].in + out * GEMINI_PRICE[model].out) / 1e6, input: u.promptTokenCount ?? 0, output: out, model };
  return { events: parseTimeline(text, a, b, sound), usage, inTokens: u.promptTokenCount ?? 0, outTokens: out };
}

/** The name of the part's copy in the Antigravity run's folder. */
const AGY_FILE = "video.mp4";
/** How long a used-up Antigravity quota parks its watches when the refusal names no time. */
const AGY_PARK_MS = 3600_000;
const QUOTA = /quota|resource.?exhausted|rate.?limit|\b429\b|usage limit/i;
const TOO_BIG = /too (large|big)|exceeds|\b413\b|payload/i;

/**
 * The part a..b of `file`, watched by Antigravity: a copy of it at 360 lines, 5 frames a second and no sound goes into
 * the run's own folder on the person's Mac (removed with the run), and Antigravity reads it with its file tool.
 * Measured 2026-11-17 on screen-recorded gameplay: 3 to 39 minutes in one file (3 to 38 MB) came back with the right
 * times, and a 10-minute part as made here is about 8 MB. It sees the picture only (it said so of a test beep), so no
 * sound note is kept. Times come back from the file's start and are moved to the video's. A file too big for it is asked
 * as two halves; a used-up quota parks `park` (no next part, no other video) and the watch is tried again later.
 * `whole`: the small copy a Mac made for watching (LibraryLookJob.swift watchCopy), sent as it is in one part: this
 * server encodes nothing for it (local-first plan D7); one too big for Antigravity fails, saying so.
 */
export async function askAntigravity(
  route: ProviderOpts,
  park: string,
  file: string,
  o: { title: string; workspace: string; level: LookLevel; a: number; b: number; dur: number },
  workspace?: string,
  whole = false,
): Promise<TimelineEvent[]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ct-watch-"));
  try {
    const part = whole ? file : path.join(dir, AGY_FILE);
    if (!whole) await ffmpeg(["-ss", String(o.a), "-i", file, "-t", String(o.b - o.a), "-vf", "scale=-2:'min(360,ih)',fps=5", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "32", part]);
    const files = { [AGY_FILE]: `base64:${(await readFile(part)).toString("base64")}` };
    if (!whole) await rm(part);
    const prompt = watchPrompt({ ...o, sound: false, file: AGY_FILE });
    const text = await usageIn(workspace, () => completeWithFallback(prompt.system, prompt.user, undefined, (t) => t, { ...route, mac: { ...route.mac, files } }));
    const r2 = (x: number) => Math.round(x * 100) / 100;
    return parseTimeline(text, 0, o.b - o.a, false).map((e) => ({ ...e, a: r2(e.a + o.a), b: r2(e.b + o.a) }));
  } catch (e) {
    const said = e instanceof Error ? e.message : String(e);
    if (/authenticat|signed out|not signed in|log ?in required/i.test(said)) throw new Error("Antigravity is signed out: sign in to it again in Settings → Providers");
    if ((e instanceof MacClaudeError && e.kind === "limit") || QUOTA.test(said)) {
      const msg = "Antigravity's quota is used up for now: the watch is tried again later";
      parked.set(park, { until: (e instanceof MacClaudeError && e.limited?.until) || Date.now() + AGY_PARK_MS, said: msg });
      throw new Error(msg);
    }
    if (TOO_BIG.test(said)) {
      if (whole) throw new Error("The Mac's copy of the video is too big for Antigravity in one piece");
      if (o.b - o.a <= 60) throw new Error("The video is too big for Antigravity, even a minute at a time");
      const m = Math.round((o.a + o.b) / 2);
      return [...(await askAntigravity(route, park, file, { ...o, b: m }, workspace)), ...(await askAntigravity(route, park, file, { ...o, a: m }, workspace))];
    }
    throw new Error(`Antigravity: ${said}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Watches `file` (a version's proxy, else its original; a Mac's copy) and stores its timeline, with the library's model
 * (contracts WATCH_MODELS). On a Gemini key: uploaded once, asked in parts of PART_S (PARTS_AT_ONCE at a time), each
 * call tallied as WATCH_LABEL under the version's workspace, the upload dropped after; a file with no sound track is
 * watched as one (watchPrompt). On Antigravity: the same parts one at a time, picture only (askAntigravity). Throws
 * when it fails (watchAfter keeps the error).
 */
export async function watchVersion(
  db: DatabaseSync,
  versionId: string,
  file: string,
  actor: string,
  sent = false,
): Promise<{ events: number; usd: number; ms: number; sound: boolean; inTokens: number; outTokens: number }> {
  const t0 = Date.now();
  const v = db
    .prepare("SELECT a.title, a.library_id, v.probe FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?")
    .get(versionId) as { title: string; library_id: string; probe: string | null };
  const model = onAntigravity(actor) ? "antigravity" : libraryWatchModel(db, v.library_id);
  const route = model === "antigravity" ? antigravityRoute(actor) : null;
  const key = model === "antigravity" ? "" : watchKey(actor);
  if (model === "antigravity" && !route) throw new Error("Needs Antigravity in Settings → Providers");
  if (model !== "antigravity" && !key) throw new Error("Needs a Gemini API key");
  // a quota that ran out: nothing is uploaded or asked until its wait is over (the watch is tried again RETRY_MS later)
  const park = route ? `antigravity:${actor}` : key;
  const p = parkedOf(park);
  if (p) throw new Error(p.said);
  const dur = Number((JSON.parse(v.probe ?? "null") as { duration?: number } | null)?.duration) || 0;
  const level = libraryLookLevel(v.library_id);
  const sound = !route && (await hasSound(file));
  const wsId = await workspaceIdOf(db, versionId);
  const workspace = wsId ? await workspaceContext(wsId, WORKSPACE_MAX) : "";
  const length = Math.max(dur, 1);
  const f = route ? null : await uploadVideo(key, file, v.title);
  let usd = 0;
  let inTokens = 0;
  let outTokens = 0;
  const one = async ([a, b]: [number, number]): Promise<TimelineEvent[]> => {
    if (route) return askAntigravity(route, park, file, { title: v.title, workspace, level, a, b, dur }, wsId, whole);
    const r = await askPart(key, model as GeminiModel, f!, watchPrompt({ title: v.title, workspace, level, a, b, dur, sound }), a, b, level, sound);
    usd += r.usage.costUsd;
    inTokens += r.inTokens;
    outTokens += r.outTokens;
    void recordUsage(WATCH_LABEL, r.usage, undefined, "workspace", wsId ?? null);
    void recordService({ service: "GEMINI_API_KEY", key, actor, label: "Media Library: timelines", units: r.usage.tokens, unit: "tokens", costUsd: r.usage.costUsd, workspace: wsId ?? null });
    return r.events;
  };
  // Antigravity runs one part at a time: each run starts its program afresh on the person's Mac
  const atOnce = route ? 1 : PARTS_AT_ONCE;
  /** The events of each range, asked `atOnce` at a time. */
  const ask = async (ranges: [number, number][]) => {
    const found: TimelineEvent[] = [];
    for (let i = 0; i < ranges.length; i += atOnce) for (const events of await Promise.all(ranges.slice(i, i + atOnce).map(one))) found.push(...events);
    return found;
  };
  // a Mac's copy goes to Antigravity whole: no part of it is cut here
  const whole = !!route && sent;
  try {
    let events = await ask(whole ? [[0, length]] : holesOf([], length, 0));
    // a stretch the answers left without an event is asked once more on its own (a whole copy only once: nothing is cut)
    const holes = whole ? [] : holesOf(events, length, holeS(level));
    if (holes.length) events = [...events, ...(await ask(holes))].sort((x, y) => x.a - y.a);
    if (!events.length) throw new Error(`${route ? "Antigravity" : "Gemini"} named nothing that happens in the video`);
    storeTimeline(db, versionId, { events, level, model });
    return { events: events.length, usd, ms: Date.now() - t0, sound, inTokens, outTokens };
  } finally {
    if (f) await deleteVideo(key, f.name);
  }
}

/**
 * After a look: the timeline of `versionId` when it wants one (wantsWatch), from the file `src` gives. It runs beside
 * the look lane, at most watchesAtOnce at a time (one more waits for the sweep, sweepWatch; a copy a Mac sent, `sent`,
 * is watched anyway: asked for again, the Mac would read the whole file again): the look's job is done when this starts. `src` is asked at once; the promise ends with the watch. A failure is kept on the version (tried
 * again RETRY_MS later) and never thrown. New words: its search by meaning is made again.
 * ponytail: a watch in flight when the server restarts is lost and asked again by the sweep, paid twice
 */
export function watchAfter(db: DatabaseSync, versionId: string, src: () => Promise<string>, actor: string | null, sent = false): Promise<void> {
  const lib = (db.prepare("SELECT a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(versionId) as { library_id: string } | undefined)?.library_id;
  if (!actor || !lib || watching.has(versionId) || (!sent && !askedWatch.has(versionId) && watching.size >= watchesAtOnce(db, lib, actor)) || !wantsWatch(db, versionId, actor)) {
    if (!watching.has(versionId)) askedWatch.delete(versionId); // an ask this look cannot answer is not kept forever
    return Promise.resolve();
  }
  const run = (async () => {
    try {
      const file = await src();
      // the key's credit ran out on this watch and its owner picked Antigravity until then: watched there at once
      const r = await watchVersion(db, versionId, file, actor, sent).catch((e: unknown) => {
        if (e instanceof Error && e.message.startsWith(CREDIT_GONE) && onAntigravity(actor)) return watchVersion(db, versionId, file, actor, sent);
        throw e;
      });
      console.log(`[library] timeline of ${versionId}: ${r.events} events, $${r.usd.toFixed(4)}, ${Math.round(r.ms / 1000)} s`);
    } catch (e) {
      storeTimeline(db, versionId, { error: e instanceof Error ? e.message : String(e) });
      return;
    }
    libraryChanged(lib); // an open clip panel shows the new timeline
    if (librarySetting(lib, "embed") && canEmbed(actor)) enqueueJob(db, lib, versionId, "embed", actor, true);
  })().finally(() => {
    watching.delete(versionId);
    askedWatch.delete(versionId);
  });
  watching.set(versionId, run);
  return run;
}

/** When the sweep last queued a version (ms): it looks again RETRY_MS later, or at once after a press of Make for the missing. */
const swept = new Map<string, number>();

/**
 * Timelines as a background index: the next video whose look is done that wants a timeline (Timelines switched on, or a
 * key or Antigravity added, after its look; a level changed; a picture-only timeline once the library watches on a key;
 * a failed watch whose wait is over) gets its look queued again as its
 * uploader: the look finds its lines current and goes on to the watch. Only a file added since Timelines went on (db.ts
 * SINCE), or one Make for the missing covers (PRESSED). True when it queued one.
 */
export function sweepWatch(db: DatabaseSync, queueLook: (versionId: string, actor: string) => boolean, now = Date.now()): boolean {
  if (watching.size >= WATCHES_AT_ONCE) return false;
  const rows = db
    .prepare(
      `SELECT v.id, v.created_by AS actor, a.library_id AS lib, ${PRESSED_AT} AS pressed FROM assets a JOIN asset_versions v ON v.id = a.current_version_id
         JOIN jobs j ON j.version_id = v.id AND j.kind = 'look' AND j.state = 'done'
         JOIN libraries l ON l.id = a.library_id LEFT JOIN timelines t ON t.version_id = v.id
       WHERE a.trashed_at IS NULL AND a.left_hidden_at IS NULL AND v.created_by IS NOT NULL AND (${AUTO} OR ${PRESSED})
         AND (t.version_id IS NULL OR (t.error IS NOT NULL AND (t.at <= ? OR ${PRESSED})) OR (t.error IS NULL AND IFNULL(t.level, '') != IFNULL(json_extract(l.settings, '$.lookLevel'), 'standard'))
              OR (t.error IS NULL AND t.model = 'antigravity' AND IFNULL(json_extract(l.settings, '$.timelineModel'), '') != 'antigravity'))
       ORDER BY v.created_at DESC LIMIT 50`,
    )
    .all(now - RETRY_MS) as { id: string; actor: string; lib: string; pressed: number }[];
  for (const r of rows) {
    const at = swept.get(r.id);
    // a failed watch waits RETRY_MS, unless Make for the missing was pressed since (What's made counts it queued then)
    if ((at !== undefined && at + RETRY_MS > now && r.pressed <= at) || watching.has(r.id)) continue;
    // no key or Antigravity for its uploader yet: passed over, not set aside, so a key saved later starts it on the next sweep
    if (!canWatch(db, r.lib, r.actor) || watching.size >= watchesAtOnce(db, r.lib, r.actor)) continue;
    swept.set(r.id, now);
    if (queueLook(r.id, r.actor)) return true;
  }
  return false;
}
