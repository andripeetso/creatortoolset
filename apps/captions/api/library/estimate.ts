import type { DatabaseSync } from "node:sqlite";
import type { LibraryEstimate, LibraryProgress, LibraryStep, LibraryStepEstimate, LibraryStepRoute } from "../../contracts/library";
import { aiFor, onApiKey } from "../ai-complete";
import { BACKGROUND_SLOTS, macUsageSince } from "../lib/mac-claude";
import { keyFor } from "../my-keys";
import { libraryDb, librarySetting } from "./db";
import { DESCRIBE_LABEL, whoFor } from "./describe";
import { NeedsKey, transcribeRoute } from "./transcribe";
import { LANES } from "./worker";

/**
 * How much processing clips will take, before they go in, and how much is left (GET /api/library/:id/estimate and
 * /progress). Per clip: the server's own file steps, a transcript, an AI description (when on), search by meaning (when
 * on and there is a key). Pace is this server's own: the last 200 finished jobs of each kind, by what ran them. Cost:
 * a description's average in the usage tally (the CLI's API-equivalent on a connected AI, the real bill on a key), and
 * a transcription service's list price per minute. Until a step has run three times here, the starting guesses below.
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
const GUESS_S: Record<string, number> = { probe: 1, thumb: 2, wave: 3, fingerprint: 4, embed: 2, deepgram: 5, openai: 15, provider: 30, api: 12 };
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

/** The average seconds a finished `kind` job took here, by what ran it, or null under MIN_RUNS runs. */
function paceOf(db: DatabaseSync, kind: string, by?: { table: "transcripts" | "descriptions"; provider: string; not?: boolean }): number | null {
  const join = by ? `JOIN ${by.table} t ON t.version_id = j.version_id` : "";
  const where = by ? `AND t.provider ${by.not ? "!=" : "="} ?` : "";
  const r = db
    .prepare(
      `SELECT AVG(d) AS s, COUNT(*) AS n FROM (SELECT j.done_at - j.started_at AS d FROM jobs j ${join}
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
  const k = keyFor(username, "OPENAI_API_KEY");
  const embed: Route = !librarySetting(libraryId, "embed") ? { route: "off" } : k.missing ? { route: "none", missing: k.missing } : { route: "openai" };
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

/** Seconds and dollars per clip for one step on its route, and whether this server measured them. */
async function perClip(db: DatabaseSync, step: LibraryStep, route: LibraryStepRoute, clipSeconds: number, proxyShare: number) {
  if (route === "off" || route === "none") return { seconds: 0, usd: 0, measured: true, at: 1 };
  if (step === "files") {
    const kinds = ["probe", "thumb", "wave", "fingerprint", "proxy"] as const;
    const paces = kinds.map((k) => paceOf(db, k));
    const guess = (k: string) => (k === "proxy" ? Math.max(5, clipSeconds * PROXY_PACE) : GUESS_S[k]!);
    const seconds = kinds.reduce((t, k, i) => t + (paces[i] ?? guess(k)) * (k === "proxy" ? proxyShare : 1), 0);
    // a library whose clips never need a playable copy has measured all it does
    const measured = paces.every((p, i) => p !== null || (kinds[i] === "proxy" && proxyShare === 0));
    return { seconds, usd: 0, measured, at: laneSize("files") };
  }
  if (step === "transcript") {
    const pace = paceOf(db, "transcribe", { table: "transcripts", provider: route });
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
  return { seconds: pace ?? GUESS_S.embed!, usd: 0, measured: pace !== null, at: laneSize("ai") };
}

const STEPS: LibraryStep[] = ["files", "transcript", "describe", "embed"];

/**
 * The whole run: steps run side by side, so the slowest, except that this computer's transcripts share the one ffmpeg
 * line with the files (media/run.ts ffmpegSlot), so those two add up.
 * ponytail: a description waiting on its transcript is not counted
 */
function total(steps: { step: LibraryStep; route: LibraryStepRoute; seconds: number }[]): number {
  const of = (step: LibraryStep) => steps.find((s) => s.step === step);
  const t = of("transcript");
  const line = (of("files")?.seconds ?? 0) + (t?.route === "device" ? t.seconds : 0);
  return Math.max(line, ...steps.filter((s) => s.step !== "files" && !(s.step === "transcript" && s.route === "device")).map((s) => s.seconds));
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
  const { secondsPerByte, proxyShare } = footageOf(db, libraryId);
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
  const out: LibraryEstimate = { clips, minutes: footage / 60, steps, seconds };
  if (count.describe && routes.describe.route === "provider") {
    const api = await perClip(db, "describe", "api", clipSeconds, proxyShare);
    const faster = total(steps.map((s) => (s.step === "describe" ? { ...s, seconds: (api.seconds * count.describe) / api.at } : s)));
    if (faster < seconds * 0.8) out.withApiKey = { seconds: faster, usd: api.usd * count.describe };
  }
  return out;
}

/** The library's processing still to do, for `username`'s view of the pace. */
export async function progress(libraryId: string, username: string): Promise<LibraryProgress> {
  const db = libraryDb();
  const rows = db
    .prepare(
      `SELECT kind, state, COUNT(*) AS n, COUNT(DISTINCT version_id) AS clips, MIN(id) AS first, MIN(error) AS error
       FROM jobs WHERE library_id = ? AND state IN ('queued', 'running', 'needs_key') GROUP BY kind, state`,
    )
    .all(libraryId) as { kind: string; state: string; n: number; clips: number; first: number; error: string | null }[];
  // descriptions held back by the plan's limit (worker.ts holdForLimit) wait, and take no time until it resets
  const held = db
    .prepare(`SELECT COUNT(*) AS n, MAX(error) AS error FROM jobs WHERE library_id = ? AND kind = 'describe' AND state = 'queued' AND run_after > ? AND error LIKE '%limit is reached%'`)
    .get(libraryId, Date.now()) as { n: number; error: string | null };
  for (const r of rows) if (r.kind === "describe" && r.state === "queued") r.n -= held.n;
  const pending = rows.filter((r) => r.state !== "needs_key" && r.n > 0);
  const left = pending.reduce((n, r) => n + r.n, 0);
  const waiting: LibraryProgress["waiting"] = rows.filter((r) => r.state === "needs_key").map((r) => ({ step: STEP_OF[r.kind] ?? "files", count: r.n, missing: r.error ?? "" }));
  if (held.n) waiting.unshift({ step: "describe", count: held.n, missing: `${held.error} They carry on by themselves then.`, limit: true });
  if (!left) return { done: 0, left: 0, clips: 0, seconds: 0, waiting };
  // done since the queue was last empty: jobs after the oldest one still to do
  const first = Math.min(...pending.map((r) => r.first));
  const { done } = db.prepare("SELECT COUNT(*) AS done FROM jobs WHERE library_id = ? AND state = 'done' AND id >= ?").get(libraryId, first) as { done: number };
  const { clips } = db
    .prepare("SELECT COUNT(DISTINCT version_id) AS clips FROM jobs WHERE library_id = ? AND state IN ('queued', 'running')")
    .get(libraryId) as { clips: number };
  // time left: each step's jobs at this server's pace, the steps side by side
  const { proxyShare, secondsPerClip } = footageOf(db, libraryId);
  const routes = routesOf(libraryId, username);
  const parts: { step: LibraryStep; route: LibraryStepRoute; seconds: number }[] = [];
  for (const step of STEPS) {
    const n = pending.filter((r) => STEP_OF[r.kind] === step).reduce((t, r) => t + r.n, 0);
    let { route } = routes[step];
    // switched off, yet asked for (Describe with AI on one clip): at the pace it would have on
    if (route === "off") route = step === "describe" ? "provider" : "openai";
    // nothing to run it on: those jobs stop as waiting for a key, they take no time
    if (!n || route === "none") continue;
    const p = await perClip(db, step, route, secondsPerClip, proxyShare);
    const perJob = step === "files" ? p.seconds / (4 + proxyShare) : p.seconds;
    parts.push({ step, route, seconds: (perJob * n) / p.at });
  }
  return { done, left, clips, seconds: total(parts), waiting };
}
