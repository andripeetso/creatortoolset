import type { DatabaseSync } from "node:sqlite";
import type { LibraryEstimate, LibraryProgress, LibraryStage, LibraryStep, LibraryStepEstimate, LibraryStepRoute } from "../../contracts/library";
import { aiFor, onApiKey } from "../ai-complete";
import { BACKGROUND_SLOTS, macUsageSince } from "../lib/mac-claude";
import { libraryDb, librarySetting } from "./db";
import { DESCRIBE_LABEL, whoFor } from "./describe";
import { embedRoute } from "./embed";
import { NeedsKey, transcribeRoute } from "./transcribe";
import { stillToCome } from "./jobs";
import { LANES, LIMIT_LIKE } from "./worker";

/**
 * How much processing clips will take, before they go in, and how much is left (GET /api/library/:id/estimate and
 * /progress). Per clip: the server's own file steps, a transcript, an AI description (when on), search by meaning (when
 * on: a key, else this computer). Pace is this server's own: the last 200 finished jobs of each kind, by what ran them.
 * Cost: a description's average in the usage tally (the CLI's API-equivalent on a connected AI, the real bill on a key),
 * and a transcription service's list price per minute. Until a step has run three times here, the starting guesses below.
 */

const STEP_OF: Record<string, LibraryStep> = {
  probe: "files",
  thumb: "files",
  wave: "files",
  proxy: "files",
  fingerprint: "files",
  transcribe: "transcript",
  describe: "describe",
  embed: "embed",
};

// ponytail: starting guesses (seconds a job, dollars a description) until this server has finished its own
// (a duplicate check reads the lighter copy: under 2 s a 4K clip, measured)
const GUESS_S: Record<string, number> = { probe: 1, thumb: 2, wave: 3, fingerprint: 1, embed: 2, deepgram: 5, openai: 15, provider: 30, api: 12 };
const GUESS_USD = { provider: 0.05, api: 0.02 };
/** On this computer, the speech model takes about a third of the clip's length. */
const DEVICE_PACE = 0.3;
// ponytail: list prices per minute (Deepgram Nova, OpenAI whisper-1), 2025; a plan's own rate may differ
const PER_MIN_USD = { deepgram: 0.0043, openai: 0.006 };
/** A phone's 1080p video, about 12 Mbit/s, until the library holds some of its own. */
const GUESS_BYTES_PER_S = 1.5e6;
/** A song or a voice memo: about 128 kbit/s. */
const AUDIO_BYTES_PER_S = 16_000;
const GUESS_PROXY_SHARE = 0.3;
/** A playable copy takes about the clip's own length to make. */
const PROXY_PACE = 1;
const MIN_RUNS = 3;

const laneSize = (name: (typeof LANES)[number]["name"]) => LANES.find((l) => l.name === name)!.size;

/**
 * The average seconds a finished `kind` job took here, by what ran it, or null under MIN_RUNS runs. `serial`: the jobs
 * run one at a time however many are claimed (this computer's transcripts), so each counts from when the one before it
 * ended, not the time it waited.
 */
function paceOf(db: DatabaseSync, kind: string, by?: { table: "transcripts" | "descriptions"; provider: string; not?: boolean }, serial = false): number | null {
  const join = by ? `JOIN ${by.table} t ON t.version_id = j.version_id` : "";
  const where = by ? `AND t.provider ${by.not ? "!=" : "="} ?` : "";
  const from = serial ? "MAX(j.started_at, IFNULL(LAG(j.done_at) OVER (ORDER BY j.done_at), 0))" : "j.started_at";
  const r = db
    .prepare(
      `SELECT AVG(d) AS s, COUNT(*) AS n FROM (SELECT j.done_at - ${from} AS d FROM jobs j ${join}
       WHERE j.kind = ? AND j.state = 'done' AND j.started_at IS NOT NULL AND j.done_at >= j.started_at ${where}
       ORDER BY j.done_at DESC LIMIT 200)`,
    )
    .get(kind, ...(by ? [by.provider] : [])) as { s: number | null; n: number };
  return r.n >= MIN_RUNS && r.s !== null ? r.s / 1000 : null;
}

/** The library's footage so far: seconds per byte, seconds per clip, and how many clips needed a playable copy. */
function footageOf(db: DatabaseSync, libraryId: string) {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(json_extract(v.probe, '$.duration')) AS secs, SUM(v.bytes) AS bytes,
         SUM(EXISTS (SELECT 1 FROM derivatives d WHERE d.version_id = v.id AND d.kind = 'proxy')) AS proxies
       FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? AND v.probe IS NOT NULL`,
    )
    .get(libraryId) as { n: number; secs: number | null; bytes: number | null; proxies: number | null };
  const known = r.n >= MIN_RUNS && !!r.secs && !!r.bytes;
  return {
    secondsPerByte: known ? r.secs! / r.bytes! : 1 / GUESS_BYTES_PER_S,
    secondsPerClip: known ? r.secs! / r.n : 60,
    proxyShare: known ? (r.proxies ?? 0) / r.n : GUESS_PROXY_SHARE,
  };
}

type Route = { route: LibraryStepRoute; missing?: string };

/** What each step runs on for `username` in this library, as the worker would pick it. */
export function routesOf(libraryId: string, username: string): Record<LibraryStep, Route> {
  let describe: Route = { route: "off" };
  if (librarySetting(libraryId, "describe")) {
    const r = onApiKey(username, "analyzer", DESCRIBE_LABEL) ?? aiFor(whoFor(username), "analyzer", DESCRIBE_LABEL);
    describe = r.off ? { route: "none", missing: r.off } : r.only?.includes("mac") ? { route: "provider" } : { route: r.bill ? "budget" : "api" };
  }
  let transcript: Route;
  try {
    transcript = { route: transcribeRoute(username).provider };
  } catch (e) {
    transcript = { route: "none", missing: e instanceof NeedsKey ? e.message : String(e) };
  }
  let embed: Route = { route: "off" };
  if (librarySetting(libraryId, "embed")) {
    try {
      embed = { route: "device" in embedRoute(username) ? "device" : "openai" };
    } catch (e) {
      embed = { route: "none", missing: e instanceof NeedsKey ? e.message : String(e) };
    }
  }
  return { files: { route: "server" }, transcript, describe, embed };
}

/** Average dollars a description cost on this route over the tally's 90 days, or null under MIN_RUNS. */
async function describeCost(api: boolean): Promise<number | null> {
  const label = api ? `${DESCRIBE_LABEL} (API)` : DESCRIBE_LABEL;
  let calls = 0;
  let usd = 0;
  for (const hour of Object.values(await macUsageSince(Date.now() - 90 * 86_400_000))) {
    calls += hour[label]?.calls ?? 0;
    usd += hour[label]?.costUsd ?? 0;
  }
  return calls >= MIN_RUNS ? usd / calls : null;
}

const filesGuess = (kind: string, clipSeconds: number) => (kind === "proxy" ? Math.max(5, clipSeconds * PROXY_PACE) : (GUESS_S[kind] ?? 2));

/** Seconds and dollars per clip for one step on its route, and whether this server measured them. */
async function perClip(db: DatabaseSync, step: LibraryStep, route: LibraryStepRoute, clipSeconds: number, proxyShare: number) {
  if (route === "off" || route === "none") return { seconds: 0, usd: 0, measured: true, at: 1 };
  if (step === "files") {
    const kinds = ["probe", "thumb", "wave", "fingerprint", "proxy"] as const;
    const paces = kinds.map((k) => paceOf(db, k));
    const seconds = kinds.reduce((t, k, i) => t + (paces[i] ?? filesGuess(k, clipSeconds)) * (k === "proxy" ? proxyShare : 1), 0);
    // a library whose clips never need a playable copy has measured all it does
    const measured = paces.every((p, i) => p !== null || (kinds[i] === "proxy" && proxyShare === 0));
    return { seconds, usd: 0, measured, at: laneSize("files") };
  }
  if (step === "transcript") {
    const pace = paceOf(db, "transcribe", { table: "transcripts", provider: route }, route === "device");
    const guess = route === "device" ? clipSeconds * DEVICE_PACE : GUESS_S[route]!;
    const usd = route === "deepgram" || route === "openai" ? (clipSeconds / 60) * PER_MIN_USD[route] : 0;
    return { seconds: pace ?? guess, usd, measured: pace !== null, at: route === "device" ? 1 : laneSize("transcripts") };
  }
  if (step === "describe") {
    const api = route !== "provider";
    const pace = paceOf(db, "describe", { table: "descriptions", provider: "anthropic", not: !api });
    const cost = await describeCost(api);
    return {
      seconds: pace ?? GUESS_S[api ? "api" : "provider"]!,
      usd: cost ?? GUESS_USD[api ? "api" : "provider"],
      measured: pace !== null && cost !== null,
      at: api ? laneSize("ai") : BACKGROUND_SLOTS,
    };
  }
  const pace = paceOf(db, "embed");
  return { seconds: pace ?? GUESS_S.embed!, usd: 0, measured: pace !== null, at: route === "device" ? 1 : laneSize("ai") };
}

const STEPS: LibraryStep[] = ["files", "transcript", "describe", "embed"];

/**
 * The whole run: steps run side by side, so the slowest, except that this computer's transcripts and search entries
 * share the one ffmpeg line with the files (media/run.ts ffmpegSlot), so those add up.
 * ponytail: a description waiting on its transcript is not counted
 */
function total(steps: { step: LibraryStep; route: LibraryStepRoute; seconds: number }[]): number {
  const inLine = (s: { step: LibraryStep; route: LibraryStepRoute }) => s.step === "files" || s.route === "device";
  const line = steps.filter(inLine).reduce((t, s) => t + s.seconds, 0);
  return Math.max(line, ...steps.filter((s) => !inLine(s)).map((s) => s.seconds));
}

/** What is going in: `clips` files of `bytes` in all, `audio` of them sound only (`audioBytes`), from a music folder or not. */
export interface Drop {
  clips: number;
  bytes: number;
  audio?: number;
  audioBytes?: number;
  music?: boolean;
}

/**
 * What a drop would take in this library for `username`. A music folder's files get the server's own steps only
 * (worker.ts: no transcript, description or search by meaning); sound-only files are never described.
 */
export async function estimate(libraryId: string, username: string, drop: Drop): Promise<LibraryEstimate> {
  const db = libraryDb();
  const { clips, music = false } = drop;
  const audio = Math.min(clips, drop.audio ?? 0);
  const audioBytes = Math.min(drop.bytes, drop.audioBytes ?? 0);
  const proxies = librarySetting(libraryId, "proxy");
  const { secondsPerByte, proxyShare: share } = footageOf(db, libraryId);
  const proxyShare = proxies ? share : 0;
  const footage = (drop.bytes - audioBytes) * secondsPerByte + audioBytes / AUDIO_BYTES_PER_S;
  const clipSeconds = clips ? footage / clips : 0;
  const routes = routesOf(libraryId, username);
  // how many files each step takes
  const count: Record<LibraryStep, number> = { files: clips, transcript: music ? 0 : clips, describe: music ? 0 : clips - audio, embed: music ? 0 : clips };
  const steps: LibraryStepEstimate[] = [];
  for (const step of STEPS) {
    const n = count[step];
    // a step no file here takes says nothing, as a step switched off
    const { route, missing } = n ? routes[step] : { route: "off" as const, missing: undefined };
    const p = await perClip(db, step, route, clipSeconds, proxyShare);
    // ponytail: a sound-only file is priced as a clip that never needs a playable copy; its thumbnail and duplicate check are counted anyway
    const files = step === "files" && audio ? await perClip(db, "files", route, clipSeconds, 0) : null;
    const seconds = files ? ((n - audio) * p.seconds + audio * files.seconds) / p.at : (p.seconds * n) / p.at;
    steps.push({ step, route, ...(missing ? { missing } : {}), usd: p.usd * n, seconds, measured: p.measured });
  }
  const seconds = total(steps);
  const out: LibraryEstimate = { clips, minutes: footage / 60, steps, seconds, proxies };
  if (count.describe && routes.describe.route === "provider") {
    const api = await perClip(db, "describe", "api", clipSeconds, proxyShare);
    const faster = total(steps.map((s) => (s.step === "describe" ? { ...s, seconds: (api.seconds * count.describe) / api.at } : s)));
    if (faster < seconds * 0.8) out.withApiKey = { seconds: faster, usd: api.usd * count.describe };
  }
  return out;
}

/** The steps a person sees go by, in the order they run (worker.ts LANES); probe and wave take a moment and go unsaid. */
const STAGES: LibraryStage["kind"][] = ["thumb", "proxy", "fingerprint", "transcribe", "describe", "embed"];

// the clips in each library's current run of the queue, added as they are seen with work left and kept until it is
// empty: every count below is over these, so no number goes down while the run lasts (a clip that is done stays counted)
// ponytail: in memory; a restart counts from the clips with work left then
const runs = new Map<string, Set<string>>();

// a description held back by the plan's limit (worker.ts holdForLimit): it waits, and takes no time, until one gets through
const HELD = "(kind = 'describe' AND state != 'needs_key' AND IFNULL(error, '') LIKE ?)";

/**
 * The library's processing still to do, for `username`'s view of the pace. The library page, Home's tile and the Activity
 * list all show these numbers, so they say the same. A step held back (for a key, an AI or the plan's limit) is not work
 * left: `waiting` says it, and a clip whose only step left is held is not being prepared.
 */
export async function progress(libraryId: string, username: string): Promise<LibraryProgress> {
  const db = libraryDb();
  const rows = db
    .prepare(
      `SELECT kind, state, ${HELD} AS held, COUNT(*) AS n, MIN(error) AS error
       FROM jobs WHERE library_id = ? AND state IN ('queued', 'running', 'needs_key') GROUP BY kind, state, held`,
    )
    .all(LIMIT_LIKE, libraryId) as { kind: string; state: string; held: number; n: number; error: string | null }[];
  const pending = rows.filter((r) => r.state !== "needs_key" && !r.held);
  // the files a watch folder has found and not handed over yet: each is a clip still to prepare, from the moment it is seen
  const toCome = stillToCome(libraryId);
  const left = pending.reduce((n, r) => n + r.n, 0) + toCome;
  const waiting: LibraryProgress["waiting"] = rows.filter((r) => r.state === "needs_key").map((r) => ({ step: STEP_OF[r.kind] ?? "files", count: r.n, missing: r.error ?? "" }));
  const held = rows.filter((r) => r.held);
  const heldN = held.reduce((n, r) => n + r.n, 0);
  if (heldN) waiting.unshift({ step: "describe", count: heldN, missing: `${held[0]!.error} They carry on by themselves then.`, limit: true });
  if (!left) {
    runs.delete(libraryId);
    return { done: 0, left: 0, clips: 0, share: 0, seconds: 0, waiting, stages: [] };
  }
  const open = db
    .prepare(`SELECT DISTINCT version_id AS v FROM jobs WHERE library_id = ? AND state IN ('queued', 'running') AND NOT ${HELD}`)
    .all(libraryId, LIMIT_LIKE) as { v: string }[];
  const run = runs.get(libraryId) ?? new Set<string>();
  runs.set(libraryId, run);
  // the run before is through (nobody looked while the queue was empty): this one counts from nothing
  if (![...run].some((v) => open.some((o) => o.v === v))) run.clear();
  for (const { v } of open) run.add(v);
  // how far: each clip of the run counts the same, by the share of its steps that are through (a held one is not counted:
  // it is not work here); a clip still to come, or not read yet, counts as not started. A clip's steps are only known once
  // it is read (probe), so counting clips, not steps, keeps the share from going back when ten clips' steps appear at once.
  // ponytail: search by meaning is queued after a transcript, so a clip's share steps back by one step of its six then
  const through = db
    .prepare(
      `SELECT SUM(CASE WHEN unread THEN 0 ELSE CAST(fin AS REAL) / n END) AS s, COUNT(*) AS clips FROM (SELECT SUM(state IN ('done', 'failed')) AS fin,
         COUNT(*) AS n, MAX(kind = 'probe' AND state IN ('queued', 'running')) AS unread FROM jobs
       WHERE library_id = ? AND version_id IN (SELECT value FROM json_each(?)) AND state != 'needs_key' AND NOT ${HELD} GROUP BY version_id)`,
    )
    .get(libraryId, JSON.stringify([...run]), LIMIT_LIKE) as { s: number | null; clips: number };
  // a clip of the run whose every step left is held is through, as far as this computer goes
  const share = ((through.s ?? 0) + run.size - through.clips) / (run.size + toCome);
  const counts = db
    .prepare(
      // still to do counts what waits for a key or a limit too (`waiting` says why), so a line never shrinks when one parks
      `SELECT kind, SUM(state = 'done') AS done, SUM(state = 'failed') AS failed, SUM(state IN ('queued', 'running', 'needs_key')) AS open
       FROM jobs WHERE library_id = ? AND version_id IN (SELECT value FROM json_each(?)) GROUP BY kind`,
    )
    .all(libraryId, JSON.stringify([...run])) as { kind: string; done: number; failed: number; open: number }[];
  const working = db
    .prepare(
      `SELECT j.kind, a.title FROM jobs j JOIN asset_versions v ON v.id = j.version_id JOIN assets a ON a.id = v.asset_id
       WHERE j.library_id = ? AND j.state = 'running' ORDER BY j.started_at`,
    )
    .all(libraryId) as { kind: string; title: string }[];
  const routes = routesOf(libraryId, username);
  const stages: LibraryStage[] = [];
  for (const kind of STAGES) {
    // a step with nothing to run it on says so in `waiting`, not as a line that never moves
    if (routes[STEP_OF[kind]!].route === "none") continue;
    const c = counts.find((r) => r.kind === kind);
    const of = c ? c.done + c.failed + c.open : 0;
    const now = working.find((w) => w.kind === kind)?.title;
    if (of) stages.push({ kind, done: c!.done, of, failed: c!.failed, ...(now ? { now } : {}) });
  }
  const done = counts.reduce((n, r) => n + r.done, 0);
  // time left: each step's jobs at this server's pace, the steps side by side
  const { proxyShare, secondsPerClip } = footageOf(db, libraryId);
  const parts: { step: LibraryStep; route: LibraryStepRoute; seconds: number }[] = [];
  for (const step of STEPS) {
    const mine = pending.filter((r) => STEP_OF[r.kind] === step);
    const n = mine.reduce((t, r) => t + r.n, 0);
    let { route } = routes[step];
    // switched off, yet asked for (Describe with AI on one clip): at the pace it would have on
    if (route === "off") route = step === "describe" ? "provider" : "openai";
    // nothing to run it on: those jobs stop as waiting for a key, they take no time
    if (!n || route === "none") continue;
    // the server's own steps each at their own pace: a lighter copy takes many pictures' time
    if (step === "files") {
      parts.push({ step, route, seconds: mine.reduce((t, r) => t + r.n * (paceOf(db, r.kind) ?? filesGuess(r.kind, secondsPerClip)), 0) / laneSize("files") });
      continue;
    }
    const p = await perClip(db, step, route, secondsPerClip, proxyShare);
    parts.push({ step, route, seconds: (p.seconds * n) / p.at });
  }
  // ponytail: a clip still to come adds no time until it is in; the time grows by its steps then
  return { done, left, clips: open.length + toCome, share, seconds: total(parts), waiting, stages };
}
