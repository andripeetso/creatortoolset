import type { DatabaseSync } from "node:sqlite";
import { LOOK_LEVELS, MADE_KINDS, WATCH_MODELS, type LibraryEstimate, type LibraryMade, type MadeKind, type LibraryProgress, type LibraryStage, type LibraryStatus, type LibraryStep, type LibraryStepEstimate, type LibraryStepRoute } from "../../contracts/library";
import { aiFor, onApiKey } from "../ai-complete";
import { BACKGROUND_SLOTS, macUsageSince } from "../lib/mac-claude";
import { libraryDb, libraryLookLevel, librarySetting } from "./db";
import { DESCRIBE_LABEL, whoFor } from "./describe";
import { antigravityRoute, canWatch, watchStopped, libraryWatchModel, watchKey, watching, watchesToCome, watchUsdPerHour } from "./timeline";
import { LOOK_KEY_CALLS, LOOK_LABEL, LOOK_MIN_S, MAC_WAITS, RELOOK_WAITS, SHEETS_PER_CALL } from "./shots";
import { SHEET_STRETCHES } from "./look";
import { embedRoute } from "./embed";
import { NeedsKey, transcribeRoute } from "./transcribe";
import { ON_ORIGINAL } from "./blur-mirror";
import { BUDGET_STOP } from "../../contracts/service-usage";
import { NOT_TRASHED, stillToCome, WAITS_FOR_COMPUTER, WAITS_FOR_SERVER } from "./jobs";
import { LANES, LIMIT_LIKE, leaveToComputers, type WaitSnapshot } from "./worker";
import { deviceOf, isThisMachine, listDevices } from "../lib/devices";
import { ownerKeeps } from "../../src/lib/wording";
import { pluginDeviceJobs } from "../lib/plugin";

/**
 * How much processing clips will take, before they go in, and how much is left (GET /api/library/:id/estimate and
 * /progress). Per clip: the server's own file steps, a transcript, an AI description (when on), shot descriptions
 * (when on, for a video longer than LOOK_MIN_S), search by meaning (when on: a key, else this computer). Pace is this server's own: the last 200 finished jobs of each kind, by what ran them.
 * Cost: a description's average in the usage tally (the CLI's API-equivalent on a connected AI, the real bill on a key),
 * and a transcription service's list price per minute. Until a step has run three times here, the starting guesses below.
 */

const STEP_OF: Record<string, LibraryStep> = {
  probe: "files",
  thumb: "files",
  wave: "files",
  proxy: "files",
  sprite: "files",
  fingerprint: "files",
  transcribe: "transcript",
  describe: "describe",
  look: "look",
  embed: "embed",
};

/** Background calls a Mac runs at once while its person uses it (one slot kept, mac-claude.ts backgroundRoom): the slower case, so a run ends on time or early. */
const PROVIDER_AT_ONCE = BACKGROUND_SLOTS - 1;
// ponytail: starting guesses (seconds a job, dollars a description) until this server has finished its own
// (a duplicate check reads the lighter copy: under 2 s a 4K clip, measured)
const GUESS_S: Record<string, number> = { probe: 1, thumb: 2, wave: 3, fingerprint: 1, embed: 2, deepgram: 5, openai: 15, provider: 30, api: 12 };
const GUESS_USD = { provider: 0.05, api: 0.02 };
// shot descriptions, measured on 2026-11-15 (tasks/flywheel stage 1.0) until the tally has this server's own: about 9
// stretches a minute of gameplay (450 to 600 an hour), so 5 to 7 calls an hour of SHEETS_PER_CALL sheets of
// SHEET_STRETCHES; a full call about 17.5k tokens in and 17k out (thinking included), 160 s (1.65 s a stretch), $0.44 at
// API prices on a connected AI; the picture read about 1 s a minute of 720p footage on all cores (a 45-minute file: 41 s)
const STRETCHES_PER_MIN = 9;
const READ_S_PER_MIN = 1.05;
const GUESS_CALL_S = 160;
const GUESS_CALL_USD = 0.44;
/** On this computer, the speech model takes about a third of the clip's length; on a computer with a downloaded model, a tenth (Whisper large-v3 on a graphics card: a twentieth). */
const DEVICE_PACE = 0.3;
const COMPUTER_PACE = 0.1;
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

// a blurred copy's job for a step run on its original is marked done when the result is copied over (blur-mirror.ts),
// keeping the started_at of an older try: hours or days that are no work (a description priced at 2.8 h, 2026-11-25)
const RAN_HERE = `(bv.blurred_of IS NULL OR j.kind NOT IN (${[...ON_ORIGINAL].map((k) => `'${k}'`).join(", ")}))`;

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
      `SELECT AVG(d) AS s, COUNT(*) AS n FROM (SELECT j.done_at - ${from} AS d FROM jobs j ${join} LEFT JOIN asset_versions bv ON bv.id = j.version_id
       WHERE j.kind = ? AND j.state = 'done' AND j.started_at IS NOT NULL AND j.done_at >= j.started_at ${where} AND ${RAN_HERE}
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

/** What each step runs on for `username` in this library, as the worker would pick it. `all`: a step switched off too. */
export function routesOf(libraryId: string, username: string, all = false): Record<LibraryStep, Route> {
  let describe: Route = { route: "off" };
  if (all || librarySetting(libraryId, "describe")) {
    const r = onApiKey(username, "library", DESCRIBE_LABEL) ?? aiFor(whoFor(username), "library", DESCRIBE_LABEL);
    describe = r.off ? { route: "none", missing: r.off } : r.only?.includes("mac") ? { route: "provider" } : { route: r.bill ? "budget" : "api" };
  }
  let look: Route = { route: "off" };
  if (all || librarySetting(libraryId, "look")) {
    const r = onApiKey(username, "library", LOOK_LABEL) ?? aiFor(whoFor(username), "library", LOOK_LABEL);
    look = r.off ? { route: "none", missing: r.off } : r.only?.includes("mac") ? { route: "provider" } : { route: r.bill ? "budget" : "api" };
  }
  let transcript: Route;
  try {
    transcript = { route: transcribeRoute(username).provider };
  } catch (e) {
    transcript = { route: "none", missing: e instanceof NeedsKey ? e.message : String(e) };
  }
  let embed: Route = { route: "off" };
  if (all || librarySetting(libraryId, "embed")) {
    try {
      embed = { route: "device" in embedRoute(username) ? "device" : "openai" };
    } catch (e) {
      embed = { route: "none", missing: e instanceof NeedsKey ? e.message : String(e) };
    }
  }
  return { files: { route: "server" }, transcript, describe, look, embed };
}

/** Average dollars a description (or a shot description call, `of` LOOK_LABEL) cost on this route over the tally's 90 days, or null under MIN_RUNS. */
async function describeCost(api: boolean, of = DESCRIBE_LABEL): Promise<number | null> {
  const label = api ? `${of} (API)` : of;
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
    const pace = paceOf(db, "transcribe", { table: "transcripts", provider: route }, route === "device" || route === "computer");
    const guess = route === "device" ? clipSeconds * DEVICE_PACE : route === "computer" ? clipSeconds * COMPUTER_PACE : GUESS_S[route]!;
    const usd = route === "deepgram" || route === "openai" ? (clipSeconds / 60) * PER_MIN_USD[route] : 0;
    // a computer takes one transcript at a time, as this one does
    return { seconds: pace ?? guess, usd, measured: pace !== null, at: route === "device" || route === "computer" ? 1 : laneSize("transcripts") };
  }
  if (step === "describe") {
    const api = route !== "provider";
    const pace = paceOf(db, "describe", { table: "descriptions", provider: "anthropic", not: !api });
    const cost = await describeCost(api);
    return {
      seconds: pace ?? GUESS_S[api ? "api" : "provider"]!,
      usd: cost ?? GUESS_USD[api ? "api" : "provider"],
      measured: pace !== null && cost !== null,
      at: api ? laneSize("ai") : PROVIDER_AT_ONCE,
    };
  }
  if (step === "look") return lookPerClip(db, route, clipSeconds);
  const pace = paceOf(db, "embed");
  return { seconds: pace ?? GUESS_S.embed!, usd: 0, measured: pace !== null, at: route === "device" ? 1 : laneSize("ai") };
}

/**
 * What making `kind` for `n` files of `seconds` each (on average) costs `username`, the switches aside (made.ts): tokens
 * (an AI provider or an AI key), paid (an outside service's key) or free (this server, the person's own computer).
 */
export async function makeCost(libraryId: string, username: string, kind: MadeKind, n: number, seconds: number): Promise<Pick<LibraryMade, "cost" | "usd" | "needs">> {
  const db = libraryDb();
  if (kind === "timeline") {
    if (!canWatch(db, libraryId, username)) return { cost: "tokens", needs: "Needs a Gemini API key" };
    const model = libraryWatchModel(db, libraryId);
    return { cost: "tokens", usd: model === "antigravity" ? 0 : ((n * seconds) / 3600) * watchUsdPerHour(libraryLookLevel(libraryId), model) };
  }
  if (kind === "blur") return { cost: "tokens" }; // the faces to cover are picked by the person's AI provider (editor-steps/blur-faces)
  if (kind !== "describe" && kind !== "look" && kind !== "transcribe" && kind !== "embed") return { cost: "free" };
  const step: LibraryStep = kind === "transcribe" ? "transcript" : kind;
  const { route, missing } = routesOf(libraryId, username, true)[step];
  const cost = route === "deepgram" || route === "openai" || (route === "none" && (kind === "transcribe" || kind === "embed")) ? "paid" : "tokens";
  if (route === "none" || route === "off") return { cost, ...(missing ? { needs: missing } : {}) };
  if (route === "device" || route === "computer") return { cost: "free" };
  const each = kind === "look" ? await lookPerClip(db, route, seconds, levelShare(libraryLookLevel(libraryId))) : await perClip(db, step, route, seconds, 0);
  return { cost, usd: n * each.usd };
}

/** About how long making `kind` for `n` files of `seconds` each takes on its route, in minutes, at this server's pace (made.ts). */
export async function makeMinutes(libraryId: string, username: string, kind: MadeKind, n: number, seconds: number): Promise<number> {
  if (!n) return 0;
  const db = libraryDb();
  if (["thumb", "sprite", "wave", "fingerprint", "proxy"].includes(kind)) return (n * (paceOf(db, kind) ?? filesGuess(kind, seconds))) / 60;
  if (kind !== "transcribe" && kind !== "describe" && kind !== "look" && kind !== "embed") return 0;
  const step: LibraryStep = kind === "transcribe" ? "transcript" : kind;
  const { route } = routesOf(libraryId, username, true)[step];
  const each = kind === "look" ? await lookPerClip(db, route, seconds, levelShare(libraryLookLevel(libraryId))) : await perClip(db, step, route, seconds, 0);
  return (n * each.seconds) / Math.max(1, each.at) / 60;
}

/** About how many lines a level writes against Standard's (contracts LOOK_LEVELS: a long take is cut every `long` seconds at most). */
const levelShare = (level: string) => 8 / (LOOK_LEVELS.find((l) => l.value === level)?.long ?? 8);

/**
 * A look of `clipSeconds` of footage at `share` of Standard's lines (levelShare): its calls at the tally's average cost,
 * its time at this server's measured pace, else the picture read plus its calls spread over the calls that run at once
 * (PROVIDER_AT_ONCE on an AI provider, six on a key: shots.ts callsAtOnce).
 * ponytail: the measured pace is of every level run here, scaled by `share` against the library's own level
 */
async function lookPerClip(db: DatabaseSync, route: LibraryStepRoute, clipSeconds: number, share = 1, paceShare = 1) {
  const api = route !== "provider";
  const atOnce = api ? LOOK_KEY_CALLS : PROVIDER_AT_ONCE;
  // a call carries up to SHEETS_PER_CALL × SHEET_STRETCHES stretches; a part-full one costs its share
  const calls = Math.max(1 / (SHEETS_PER_CALL * SHEET_STRETCHES), ((clipSeconds / 60) * STRETCHES_PER_MIN * share) / (SHEETS_PER_CALL * SHEET_STRETCHES));
  const pace = lookPace(db);
  const cost = await describeCost(api, LOOK_LABEL);
  return {
    seconds: pace !== null ? (pace * clipSeconds * share) / paceShare : (clipSeconds / 60) * READ_S_PER_MIN + calls * GUESS_CALL_S,
    usd: calls * (cost ?? GUESS_CALL_USD),
    measured: pace !== null && cost !== null,
    // a measured pace already counts a file's calls side by side; the guess spreads every call over the ones at once
    at: pace !== null ? Math.min(atOnce, laneSize("looks")) : atOnce,
  };
}

/** Seconds a finished look took here per second of its footage (the last 200), or null under MIN_RUNS. */
function lookPace(db: DatabaseSync): number | null {
  const r = db
    .prepare(
      `SELECT SUM(d) AS s, SUM(len) AS len, COUNT(*) AS n FROM (SELECT j.done_at - j.started_at AS d, json_extract(v.probe, '$.duration') AS len
       FROM jobs j JOIN asset_versions v ON v.id = j.version_id
       WHERE j.kind = 'look' AND j.state = 'done' AND j.started_at IS NOT NULL AND j.done_at >= j.started_at AND len > 0 AND v.blurred_of IS NULL ORDER BY j.done_at DESC LIMIT 200)`,
    )
    .get() as { s: number | null; len: number | null; n: number };
  return r.n >= MIN_RUNS && r.s !== null && r.len ? r.s / 1000 / r.len : null;
}

const STEPS: LibraryStep[] = ["files", "transcript", "describe", "look", "embed"];

/**
 * The whole run: steps run side by side, so the slowest, except that this computer's transcripts and search entries
 * share the one line of heavy runs with the files (media/run.ts), so those add up.
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
  // a shot description's time and cost follow the length of the videos, not of the drop's sound files
  const videoSeconds = clips - audio ? (footage - audioBytes / AUDIO_BYTES_PER_S) / (clips - audio) : 0;
  // ponytail: shot descriptions counted for every video of the drop when they average over LOOK_MIN_S; a talking take
  // gets none, and the drop can't tell those apart yet, so this is the most they take
  const count: Record<LibraryStep, number> = {
    files: clips,
    transcript: music ? 0 : clips,
    describe: music ? 0 : clips - audio,
    look: music || videoSeconds <= LOOK_MIN_S ? 0 : clips - audio,
    embed: music ? 0 : clips,
  };
  const steps: LibraryStepEstimate[] = [];
  for (const step of STEPS) {
    const n = count[step];
    // a step no file here takes says nothing, as a step switched off
    const { route, missing } = n ? routes[step] : { route: "off" as const, missing: undefined };
    const p = await perClip(db, step, route, step === "look" ? videoSeconds : clipSeconds, proxyShare);
    // ponytail: a sound-only file is priced as a clip that never needs a playable copy; its thumbnail and duplicate check are counted anyway
    const files = step === "files" && audio ? await perClip(db, "files", route, clipSeconds, 0) : null;
    const seconds = files ? ((n - audio) * p.seconds + audio * files.seconds) / p.at : (p.seconds * n) / p.at;
    steps.push({ step, route, ...(missing ? { missing } : {}), usd: p.usd * n, seconds, measured: p.measured });
  }
  const seconds = total(steps);
  const out: LibraryEstimate = { clips, minutes: footage / 60, steps, seconds, proxies };
  const look = routes.look.route;
  if (look !== "off" && look !== "none") {
    // an hour of footage at each level, so the person picks with the time and cost in front of them
    const mine = levelShare(libraryLookLevel(libraryId));
    out.lookLevels = [];
    // with a Gemini key and Timelines on, each level's hour also pays for its timeline (timeline.ts, from measured tokens; Antigravity's costs nothing a call)
    const watching = librarySetting(libraryId, "timeline") && canWatch(db, libraryId, username);
    const model = libraryWatchModel(db, libraryId);
    for (const l of LOOK_LEVELS) {
      const p = await lookPerClip(db, look, 3600, levelShare(l.value), mine);
      out.lookLevels.push({ level: l.value, seconds: p.seconds / p.at, usd: p.usd + (watching ? watchUsdPerHour(l.value, model) : 0) });
    }
  }
  out.timelineKey = !!watchKey(username);
  // each model's timeline of an hour at the library's level, so the person picks one with its cost in front of them
  const stopped = out.timelineKey ? watchStopped(db, libraryId) : null;
  if (stopped) out.timelineStopped = stopped;
  if (out.timelineKey) out.timelineModels = WATCH_MODELS.filter((m) => m.value !== "antigravity").map((m) => ({ model: m.value, usd: watchUsdPerHour(libraryLookLevel(libraryId), m.value) }));
  if (antigravityRoute(username)) out.timelineAntigravity = true;
  if (count.describe && routes.describe.route === "provider") {
    const api = await perClip(db, "describe", "api", clipSeconds, proxyShare);
    const faster = total(steps.map((s) => (s.step === "describe" ? { ...s, seconds: (api.seconds * count.describe) / api.at } : s)));
    if (faster < seconds * 0.8) out.withApiKey = { seconds: faster, usd: api.usd * count.describe };
  }
  // the Effort row (UNIFIED-PRD §3.1): the footage not analyzed yet at the library's level, and an hour's cost there
  if (librarySetting(libraryId, "look") || librarySetting(libraryId, "describe")) {
    const step = librarySetting(libraryId, "look") ? "look" : "describe";
    // shortcut: an hour at Medium and up is priced from its shot descriptions alone (the timeline's cost is left out)
    const hourUsd = step === "look" ? (out.lookLevels?.find((l) => l.level === libraryLookLevel(libraryId))?.usd ?? 0) : (await perClip(db, "describe", routes.describe.route, 3600, 0)).usd;
    out.unanalyzed = { seconds: unanalyzedSeconds(db, libraryId, step), hourUsd };
  }
  return out;
}

/** Seconds of this library's ready footage with no `step` job done yet, counted once per version. */
function unanalyzedSeconds(db: DatabaseSync, libraryId: string, step: "describe" | "look"): number {
  const row = db
    .prepare(
      `SELECT IFNULL(SUM(json_extract(v.probe, '$.duration')), 0) AS s FROM asset_versions v JOIN assets a ON a.id = v.asset_id
       WHERE a.library_id = ? AND a.trashed_at IS NULL AND v.state = 'ready'
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.version_id = v.id AND j.kind = ? AND j.state = 'done')`,
    )
    .get(libraryId, step) as { s: number };
  return row.s;
}

/** The steps a person sees go by, in the order they run (worker.ts LANES); probe and wave take a moment and go unsaid. */
const STAGES: LibraryStage["kind"][] = ["thumb", "proxy", "fingerprint", "transcribe", "describe", "look", "embed"];

// the clips in each library's current run of the queue, added as they are seen with work left and kept until it is
// empty: every count below is over these, so no number goes down while the run lasts (a clip that is done stays counted)
// ponytail: in memory; a restart counts from the clips with work left then
const runs = new Map<string, Set<string>>();
// the files a computer made ready (Face Blur's blurred copies) during each run, kept the same way, for its step line
const madeRuns = new Map<string, Set<string>>();
// when each run began: a clip in it counts the steps queued for this run, not the ones it finished before (a clip that
// joins for one duplicate check is one step, not its old transcript and descriptions shown again)
const runSince = new Map<string, number>();
const runEnded = new Map<string, number>();
// a step that ended before the run began; a moment's margin keeps one that ended between the queue and the first look
const FRESH = "(state NOT IN ('done', 'failed', 'stopped') OR IFNULL(done_at, started_at) >= $since)";

// a description or look held back by the plan's limit (worker.ts holdForLimit): it waits, and takes no time, until one gets through
const HELD = `(kind IN ('describe', 'look') AND state != 'needs_key' AND IFNULL(error, '') LIKE ?)`;
// a step this server leaves for one of the person's computers while none can take it, or that waits for video work this
// server does not do (worker.ts leftToComputers): nothing runs it until a computer of theirs is on, so it is waiting, not
// time left (a library stuck at "about 20 min left" for days, 2026-11-17)
// The lines that name the folder (work/library-package.ts libraryWaitLine) wait the same way.
const AWAY_TEXT = `(IFNULL(error, '') IN (${[WAITS_FOR_SERVER, WAITS_FOR_COMPUTER].map((w) => `'${w.replace(/'/g, "''")}'`).join(", ")}) OR IFNULL(error, '') LIKE 'Only % can read %' OR IFNULL(error, '') LIKE 'No computer can read %')`;
// With the computers' status (work/waits.ts, leaveToComputers.status) the snapshot decides instead, by job id: `$waits` are
// the jobs no computer takes now (offline, needs, set, cannot, stuck), `$seen` every job it classified. A job it says a
// computer will take is work left whatever its line; a job taken since is no longer queued; one it did not see keeps the line.
const CW = `(id IN (SELECT value FROM json_each($waits)) AND (state = 'queued' OR (kind = 'look' AND state = 'needs_key' AND error = $mac)))`;
const AWAY = `(${CW} OR (state = 'queued' AND id NOT IN (SELECT value FROM json_each($seen)) AND ${AWAY_TEXT}))`;
// a parked shot description a computer of its person will take (work/waits.ts): work left, never "needs an AI provider"
const QL = `(kind = 'look' AND state = 'needs_key' AND error = $mac AND id IN (SELECT value FROM json_each($looks)))`;

/** The computers' status of the library's waiting jobs (work/waits.ts), when this server has it; a failure keeps today's rule. */
function statusOf(libraryId: string): WaitSnapshot | undefined {
  try {
    return leaveToComputers.status?.(libraryId);
  } catch (e) {
    console.warn(`[library] status of ${libraryId}:`, e);
    return undefined;
  }
}

/** The whole library's state per step, for "how far is indexing, is anything broken": every clip in it, not one run. */
export function libraryStatus(libraryId: string): LibraryStatus {
  const db = libraryDb();
  const live = "FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE a.library_id = ? AND a.trashed_at IS NULL";
  const head = db.prepare(`SELECT COUNT(*) AS clips, IFNULL(SUM(v.state = 'failed'), 0) AS unreadable ${live}`).get(libraryId) as { clips: number; unreadable: number };
  const rows = db
    .prepare(
      `SELECT j.kind, SUM(j.state = 'done') AS done, SUM(j.state = 'failed') AS failed, SUM(j.state IN ('queued', 'running', 'needs_key')) AS open
       FROM jobs j JOIN assets a ON a.current_version_id = j.version_id WHERE a.library_id = ? AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL GROUP BY j.kind`,
    )
    .all(libraryId) as { kind: string; done: number; failed: number; open: number }[];
  const stages = STAGES.flatMap((kind) => {
    const r = rows.find((x) => x.kind === kind);
    return r ? [{ kind, done: r.done, failed: r.failed, open: r.open, of: r.done + r.failed + r.open }] : [];
  });
  // clips hidden on a computer that went silent and so went to the trash (report.ts settleSilent), by computer
  const leftOut = db
    .prepare("SELECT left_trashed_from AS computer, COUNT(*) AS clips FROM assets WHERE library_id = ? AND trashed_at IS NOT NULL AND left_trashed_from IS NOT NULL GROUP BY left_trashed_from ORDER BY computer")
    .all(libraryId) as { computer: string; clips: number }[];
  // clips hidden while they wait on a folder not read (report.ts hideLeft; the watch's on this server), by computer
  const here = listDevices((x) => isThisMachine(x.id))[0]?.name ?? "this server";
  const hidden = (
    db
      .prepare("SELECT left_hidden_on AS device, COUNT(*) AS clips FROM assets WHERE library_id = ? AND trashed_at IS NULL AND left_hidden_at IS NOT NULL GROUP BY left_hidden_on")
      .all(libraryId) as { device: string | null; clips: number }[]
  ).map((r) => ({ computer: r.device ? (deviceOf(r.device)?.name ?? "a computer no longer paired") : here, clips: r.clips }));
  return { ...head, stages, ...(leftOut.length ? { leftOut } : {}), ...(hidden.length ? { hidden } : {}) };
}

/**
 * The library's processing still to do, for `username`'s view of the pace. The library page, Home's tile and the Activity
 * list all show these numbers, so they say the same. A step held back (for a key, an AI or the plan's limit) is not work
 * left: `waiting` says it, and a clip whose only step left is held is not being prepared.
 */
// the job kinds the library's Stop takes off the queue: a job is named as its kind (made.ts SPEC)
const STOPPED: ReadonlySet<string> = new Set(MADE_KINDS.filter((k) => !k.auto && !k.ready).map((k) => k.kind));

/**
 * Seconds a timeline in `libraryId`, from the last thirty made (each clip once: a blurred copy's is its original's): the
 * time between one and the next, a pause between two runs left out, so a run has its pace from its first clip (read off
 * the last quarter of an hour only, a run that began after a pause said "under a minute" for its first minutes). Null
 * with fewer than three made in a row.
 */
function watchPace(db: DatabaseSync, libraryId: string): number | null {
  const at = (
    db
      .prepare(
        `SELECT t.at FROM timelines t JOIN asset_versions v ON v.id = t.version_id JOIN assets a ON a.id = v.asset_id
         WHERE a.library_id = ? AND t.error IS NULL AND v.blurred_of IS NULL ORDER BY t.at DESC LIMIT 30`,
      )
      .all(libraryId) as { at: number }[]
  ).map((r) => r.at);
  const gaps = at.slice(1).map((t, i) => at[i]! - t).filter((g) => g < 5 * 60_000);
  const all = gaps.reduce((s, g) => s + g, 0);
  return gaps.length >= 2 && all > 0 ? all / gaps.length / 1000 : null;
}

export async function progress(libraryId: string, username: string): Promise<LibraryProgress> {
  const db = libraryDb();
  const snap = statusOf(libraryId);
  const waitIds = snap ? [...snap.byJob].flatMap(([id, c]) => (c.wait === "queued" ? [] : [id])) : [];
  const ids = { waits: JSON.stringify(waitIds), mac: MAC_WAITS };
  const away = { ...ids, seen: JSON.stringify(snap ? [...snap.byJob.keys()] : []) };
  const look = { mac: MAC_WAITS, looks: JSON.stringify(snap?.queuedLookIds ?? []) };
  const rows = db
    .prepare(
      `SELECT kind, state, ${HELD} AS held, ${AWAY} AS away, ${CW} AS cw, ${QL} AS ql, (kind = 'look' AND state = 'needs_key' AND error = $mac) AS mac, COUNT(*) AS n, MIN(error) AS error
       FROM jobs j WHERE library_id = ? AND state IN ('queued', 'running', 'needs_key') AND ${NOT_TRASHED} GROUP BY kind, state, held, away, cw, ql, mac`,
    )
    .all({ ...away, ...look }, LIMIT_LIKE, libraryId) as { kind: string; state: string; held: number; away: number; cw: number; ql: number; mac: number; n: number; error: string | null }[];
  const pending = rows.filter((r) => (r.state !== "needs_key" || r.ql) && !r.held && !r.away);
  // the files a watch folder has found and not handed over yet: each is a clip still to prepare, from the moment it is seen
  // the clips whose timeline is still to queue (timeline.ts sweepWatch takes one while there is room to watch it): part
  // of the run from its start, as a watch folder's files are, so its total and what is left never wait for the sweep
  const watches = watchesToCome(db, libraryId);
  const toCome = stillToCome(db, libraryId) + watches;
  // the files a computer is still making ready (Face Blur's blurred copies): their clips count from the start too, not
  // one by one as each copy comes in
  const made = pluginDeviceJobs().flatMap((j) => j.preparing?.(libraryId) ?? []);
  const comingRows = (
    db
      .prepare("SELECT v.id, a.title FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id IN (SELECT value FROM json_each(?)) AND a.library_id = ? AND a.trashed_at IS NULL")
      .all(JSON.stringify(made.filter((m) => !m.failed && !m.waiting).map((m) => m.versionId)), libraryId) as { id: string; title: string }[]
  );
  const coming = comingRows.map((r) => r.id);
  const left = pending.reduce((n, r) => n + r.n, 0) + toCome + coming.length;
  // what the library's Stop reaches (made.ts stopQueued): a queued job of a kind with a Cancel, a file still on its way
  // and a look waiting to run again for its timeline (in the queue, or for its Mac): Stop puts it back as done
  const relooks = (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE library_id = ? AND ${RELOOK_WAITS}`).get(libraryId, MAC_WAITS) as { n: number }).n;
  const canStop = toCome > 0 || coming.length > 0 || pending.some((r) => r.state === "queued" && STOPPED.has(r.kind)) || relooks > 0;
  const waiting: LibraryProgress["waiting"] = rows
    .filter((r) => r.state === "needs_key" && !r.ql && !r.cw)
    .map((r) => ({
      step: STEP_OF[r.kind] ?? "files",
      count: r.n,
      missing: r.error ?? "",
      ...(r.mac ? { computer: true } : {}),
      // a key's spent budget says so and opens the keys, not "needs a key" (it has one)
      ...(r.error?.includes(BUDGET_STOP) ? { reason: r.error, href: "/settings/keys" } : {}),
    }));
  // waiting for one of the person's computers, per step: "6 descriptions wait for one of your computers"
  for (const r of rows.filter((x) => x.away && !x.cw)) {
    const step = STEP_OF[r.kind] ?? "files";
    const same = waiting.find((w) => w.away && w.step === step);
    if (same) same.count += r.n;
    else waiting.push({ step, count: r.n, missing: r.error ?? "", away: true });
  }
  // the ones the status classified, by step, class, reason, person and computer: "6 files · Mac Studio is offline"
  if (waitIds.length) {
    const byGroup = new Map<string, LibraryProgress["waiting"][number]>();
    for (const { id, kind } of db.prepare(`SELECT id, kind FROM jobs WHERE library_id = ? AND ${CW}`).all(ids, libraryId) as { id: number; kind: string }[]) {
      const c = snap!.byJob.get(id)!;
      if (c.wait === "queued") continue;
      const step = STEP_OF[kind] ?? "files";
      const mine = c.actor === username;
      // another person's computers are never named to this viewer, except that one is offline (PLAN-final D12)
      const reason = mine ? c.reason : ownerKeeps(c.wait === "offline" && c.device ? deviceOf(c.device)?.name : undefined);
      const key = [step, c.wait, reason, c.actor, mine ? c.device : ""].join("\0");
      const same = byGroup.get(key);
      if (same) same.count++;
      else
        byGroup.set(key, {
          step,
          count: 1,
          missing: reason ?? "",
          away: true,
          wait: c.wait,
          ...(reason ? { reason } : {}),
          ...(mine && c.href ? { href: c.href } : {}),
          mine,
          ...(mine && c.device ? { device: c.device } : {}),
          ...(mine && c.devices ? { devices: c.devices } : {}),
        });
    }
    waiting.push(...byGroup.values());
  }
  // held for the plan's limit, per step: "4 descriptions paused", "2 shot descriptions paused"
  for (const step of ["look", "describe"] as const) {
    const held = rows.filter((r) => r.held && STEP_OF[r.kind] === step);
    const heldN = held.reduce((n, r) => n + r.n, 0);
    if (heldN) waiting.unshift({ step, count: heldN, missing: `${held[0]!.error} They continue then.`, limit: true });
  }
  if (!left) {
    runs.delete(libraryId);
    madeRuns.delete(libraryId);
    runSince.delete(libraryId);
    runEnded.set(libraryId, Date.now());
    return { done: 0, left: 0, clips: 0, share: 0, seconds: 0, waiting, stages: [] };
  }
  const open = db
    .prepare(`SELECT DISTINCT version_id AS v FROM jobs j WHERE library_id = ? AND ${NOT_TRASHED} AND ((state IN ('queued', 'running') AND NOT ${HELD} AND NOT ${AWAY}) OR ${QL})`)
    .all({ ...away, ...look }, libraryId, LIMIT_LIKE) as { v: string }[];
  const run = runs.get(libraryId) ?? new Set<string>();
  runs.set(libraryId, run);
  // the run before is through (nobody looked while the queue was empty): this one counts from nothing
  // while a computer is still making files ready (coming), the run goes on between them
  const madeRun = madeRuns.get(libraryId) ?? new Set<string>();
  madeRuns.set(libraryId, madeRun);
  // a clip blurred in this run and analyzed now is the same run
  if (!coming.length && ![...run, ...madeRun].some((v) => open.some((o) => o.v === v))) {
    run.clear();
    madeRun.clear();
  }
  for (const v of coming) madeRun.add(v);
  if (!run.size) runSince.set(libraryId, Math.max(Date.now() - 60_000, runEnded.get(libraryId) ?? 0));
  for (const { v } of open) run.add(v);
  // a clip, not a file: its original and its blurred copy are one clip
  const clips = (
    db.prepare("SELECT COUNT(DISTINCT asset_id) AS n FROM asset_versions WHERE id IN (SELECT value FROM json_each(?))").get(JSON.stringify([...open.map((o) => o.v), ...coming])) as { n: number }
  ).n;
  const ahead = toCome + coming.filter((v) => !run.has(v)).length;
  const since = { $since: runSince.get(libraryId) ?? 0 };
  // how far: each clip of the run counts the same, by the share of its steps that are through (a held one is not counted:
  // it is not work here); a clip still to come, or not read yet, counts as not started. A clip's steps are only known once
  // it is read (probe), so counting clips, not steps, keeps the share from going back when ten clips' steps appear at once.
  // ponytail: search by meaning is queued after a transcript, so a clip's share steps back by one step of its six then
  const through = db
    .prepare(
      `SELECT SUM(CASE WHEN unread THEN 0 ELSE CAST(fin AS REAL) / n END) AS s, COUNT(*) AS clips FROM (SELECT SUM(state IN ('done', 'failed', 'stopped')) AS fin,
         COUNT(*) AS n, MAX(kind = 'probe' AND state IN ('queued', 'running')) AS unread FROM jobs j
       WHERE library_id = ? AND version_id IN (SELECT value FROM json_each(?)) AND ${NOT_TRASHED} AND ${FRESH} AND ((state != 'needs_key' AND NOT ${HELD} AND NOT ${AWAY}) OR ${QL}) GROUP BY version_id)`,
    )
    .get({ ...away, ...look, ...since }, libraryId, JSON.stringify([...run]), LIMIT_LIKE) as { s: number | null; clips: number };
  // a clip of the run whose every step left is held, or that went to the trash, is through, as far as this computer goes
  const share = ((through.s ?? 0) + run.size - through.clips) / (run.size + ahead);
  const counts = db
    .prepare(
      // still to do counts what waits for a key or a limit too (`waiting` says why), so a line never shrinks when one parks
      `SELECT kind, SUM(state = 'done') AS done, SUM(state = 'failed') AS failed, SUM(state IN ('queued', 'running', 'needs_key')) AS open
       FROM jobs j WHERE library_id = ? AND version_id IN (SELECT value FROM json_each(?)) AND ${NOT_TRASHED} AND ${FRESH} GROUP BY kind`,
    )
    .all(since, libraryId, JSON.stringify([...run])) as { kind: string; done: number; failed: number; open: number }[];
  const working = db
    .prepare(
      `SELECT j.kind, a.title FROM jobs j JOIN asset_versions v ON v.id = j.version_id JOIN assets a ON a.id = v.asset_id
       WHERE j.library_id = ? AND j.state = 'running' AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL ORDER BY j.started_at`,
    )
    .all(libraryId) as { kind: string; title: string }[];
  const routes = routesOf(libraryId, username);
  const stages: LibraryStage[] = [];
  // shortcut: every plug-in's computer files are one line, named for Face Blur, the only slot with them; a name from the slot when there is a second
  if (madeRun.size) {
    const listed = new Map(made.map((m) => [m.versionId, m]));
    const failed = [...madeRun].filter((v) => listed.get(v)?.failed).length;
    const now = comingRows.find((r) => listed.get(r.id)?.running)?.title;
    stages.push({ kind: "blur", done: [...madeRun].filter((v) => !listed.has(v)).length, of: madeRun.size, failed, ...(now ? { now } : {}) });
  }
  for (const kind of STAGES) {
    // a step with nothing to run it on says so in `waiting`, not as a line that never moves
    if (routes[STEP_OF[kind]!].route === "none") continue;
    const c = counts.find((r) => r.kind === kind);
    // a look runs again for each timeline still to queue
    const of = (c ? c.done + c.failed + c.open : 0) + (kind === "look" ? watches : 0);
    const now = working.find((w) => w.kind === kind)?.title;
    if (of) stages.push({ kind, done: c?.done ?? 0, of, failed: c?.failed ?? 0, ...(now ? { now } : {}) });
    // Timelines are no job of their own: Gemini watches each clip after its shot descriptions (timeline.ts watchAfter)
    if (kind === "look" && of && librarySetting(libraryId, "timeline") && canWatch(db, libraryId, username)) {
      const t = db
        .prepare(`SELECT IFNULL(SUM(error IS NULL), 0) AS done, IFNULL(SUM(error IS NOT NULL), 0) AS failed FROM timelines WHERE version_id IN (SELECT value FROM json_each(?)) AND at >= ?`)
        .get(JSON.stringify([...run]), since.$since) as { done: number; failed: number };
      const on = [...run].find((v) => watching.has(v));
      const title = on && (db.prepare("SELECT a.title FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(on) as { title: string } | undefined)?.title;
      stages.push({ kind: "timeline", done: t.done, of: Math.max(of, t.done + t.failed), failed: t.failed, ...(title ? { now: title } : {}) });
    }
  }
  const done = counts.reduce((n, r) => n + r.done, 0);
  // time left: each step's jobs at this server's pace, the steps side by side
  const { proxyShare, secondsPerClip } = footageOf(db, libraryId);
  const parts: { step: LibraryStep; route: LibraryStepRoute; seconds: number }[] = [];
  for (const step of STEPS) {
    const mine = pending.filter((r) => STEP_OF[r.kind] === step);
    const n = mine.reduce((t, r) => t + r.n, 0) + (step === "look" ? watches : 0);
    let { route } = routes[step];
    // switched off, yet asked for (Describe with AI on one clip): at the pace it would have on
    if (route === "off") route = step === "describe" || step === "look" ? "provider" : "openai";
    // nothing to run it on: those jobs stop as waiting for a key, they take no time
    if (!n || route === "none") continue;
    // the server's own steps each at their own pace: a lighter copy takes many pictures' time
    if (step === "files") {
      parts.push({ step, route, seconds: mine.reduce((t, r) => t + r.n * (paceOf(db, r.kind) ?? filesGuess(r.kind, secondsPerClip)), 0) / laneSize("files") });
      continue;
    }
    // a run of timelines goes at the pace timelines come in, end to end (a computer reads each file, Gemini watches
    // it): a look that runs again for one is over in a moment here, and its pace would say a minute for an hour's work
    // (the sweep may have queued them all already: the looks waiting to run again are the run then, not `watches`)
    const each = step === "look" && watches + relooks ? watchPace(db, libraryId) : null;
    if (each) {
      parts.push({ step, route, seconds: each * Math.max(n, watches + relooks) });
      continue;
    }
    const p = await perClip(db, step, route, secondsPerClip, proxyShare);
    parts.push({ step, route, seconds: (p.seconds * n) / p.at });
  }
  // ponytail: a clip a folder has still to hand over adds no time until it is in; the time grows by its steps then
  return { done, left, clips: clips + toCome, share, seconds: total(parts), canStop, waiting, stages };
}
