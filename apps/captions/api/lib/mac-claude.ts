import { Hono, type Context } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DRIVERS, parseMachine, type AcpCommand, type Driver, type Effort, type MacReport, type Scope } from "../../contracts/providers";
import { EDITOR_HINT } from "../../contracts/devices";
import { limitLine, limitMessage, limitResetAt } from "../../contracts/plans";
import { env, keepsOverRestart } from "./env";
import { deviceName, isOnline, saveReport, touchDevice } from "./devices";
import { saveLimits } from "./limits";
import { noteCallOutcome } from "./providers";

/**
 * The AI providers on the paired Macs (contracts/providers.ts). A request waits
 * here in memory for the device its provider runs on (devices.ts): that Mac's
 * Creator Toolset app long-polls /api/devices/relay/wait with its own token.
 * It runs the request's provider CLI (`claude -p` with its identity folder, model
 * and effort; no tools, or web search for research, or a folder to read for a
 * Workshop turn) and posts the text as it is written. A device counts as on while
 * it has polled in the last 40 s (paused = it stops). What a person waits on goes
 * first; background work (deep research) waits up to 10 min and takes at most 2
 * of a Mac's 4.
 *
 * A restart of this server (a deploy) must not lose an answer the Mac is still writing. A caller that can take its
 * answer up again says so (MacOpts.keep): its request is then also kept on disk from the moment a Mac claims it
 * (DATA_DIR/mac-claude-open, never the prompt, a file or a token). The next process gives it back to that caller
 * (onAdopt) when the Mac's next post about it arrives (adoptKept), not at boot: a deploy's reload runs the old and
 * the new process side by side for some seconds, and the old one may still be answering it. The Mac notices nothing.
 * A request nobody keeps is gone with the process, as before: the Mac's next post gets 404 and it stops.
 */

export interface MacUsage {
  tokens: number;
  /** what the API would have charged (the CLI's total_cost_usd) */
  costUsd: number;
  /** input tokens read from Claude's prompt cache */
  cacheRead?: number;
  /** how big a kept Claude session is after this answer (its last message's whole input), from the Mac relay */
  context?: number;
}

/** The Claude session an answer ran in: "new" (kept for next time), "resumed", or "lost" (asked to resume, gone, ran fresh). */
export interface MacSession {
  id: string;
  state: "new" | "resumed" | "lost";
}

export interface MacOpts {
  /** Claude may search and read the web (WebSearch, WebFetch). */
  web?: boolean;
  /** Long work nobody watches word by word: queued behind what a person waits on. */
  background?: boolean;
  /** What it is for, in the usage tally ("Workshop", "Idea board"…). */
  label?: string;
  /** A working folder (path → text): Claude reads it with Read, Glob and Grep before answering (the Workshop's chat). */
  files?: Record<string, string>;
  /** Another Claude than the provider's model, e.g. Fable for a reader's review. Only for a Claude provider: any other keeps its own model. */
  model?: string;
  /** The provider instance that answers (contracts/providers.ts): its CLI, identity folder, model and effort, the device it runs on and whose settings it is. */
  provider?: { instance: string; driver: Driver; home?: string; model: string; effort: Effort; device?: string; scope?: Scope;
    /** the endpoint a plug-in instance sends its Claude requests to (ANTHROPIC_BASE_URL on the Mac); none = the CLI's own */
    baseUrl?: string;
    /** the names of the instance's environment variables; the Mac sends each its value from its own Keychain */
    envNames?: string[];
    /** ACP kinds: the launch arguments, the local command for driver "acp", and the program a manual setup gave */
    launchArgs?: string[];
    acp?: AcpCommand;
    binaryPath?: string; };
  /** Each tool call as Claude makes it ("Searched the web: …", "Read my-posts/INDEX.md"). */
  onStep?: (label: string) => void;
  /** A Workshop session's folder, kept on the Mac with its Claude session. resume = that session's id from the last turn
   * (a "gone" failure when the Mac no longer has it: the caller runs the turn again without it). */
  session?: { key: string; resume?: string };
  /** The Claude session the answer ran in (only when `session` is given). */
  onSession?: (s: MacSession) => void;
  /**
   * Creator Toolset's own MCP server for this run (the assistant): `url` is this server's /api/mcp, `token` a job token
   * (auth.ts, ctj_…, 30 min, one turn). The job body carries both as `mcp`. What the Mac must do with it (not built yet):
   * write an --mcp-config file with { "mcpServers": { "creator-toolset": { "type": "http", "url": url,
   * "headers": { "Authorization": "Bearer " + token } } } }, pass --mcp-config <that file> --strict-mcp-config, add
   * "mcp__creator-toolset__*" to --allowedTools, and never log, persist or echo the token. The server's MCP name is
   * "creator-toolset" (mcp.ts initialize). Nothing else changes for a job without it.
   */
  mcp?: { url: string; token: string };
  /**
   * The assistant's turns only: Claude also gets this Mac's tools (Bash, Edit, Write…) with Claude Code's own
   * permission rules, and each question it would ask a person comes here. The Mac posts the same ask every few
   * seconds (/:id/ask) until the answer is no longer "waiting"; anything but "allowed" is a no.
   */
  onAsk?: (ask: MacAsk) => MacAskStatus;
  /** The caller can take this answer up again after a restart of the server: what it needs for that (onAdopt). */
  keep?: Kept;
}

/** What a caller keeps with its request to take the answer up again after a restart; `kind` names the caller. Never a prompt, a file or a token. */
export type Kept = { kind: string } & Record<string, string | number | boolean>;

/** A permission question from Claude on the Mac: the tool, Claude's own words for it and the exact command or path. */
export interface MacAsk {
  id: string;
  tool: string;
  description: string;
  reason: string;
  detail: string;
}
export type MacAskStatus = "waiting" | "allowed" | "denied" | "expired";

/* ---- usage: every answer's tokens and API-equivalent cost, by hour (UTC) and what it was for ---- */

type Tally = { calls: number; tokens: number; costUsd: number };
/**
 * hour → label → totals, and the same split by `${scope}:${instance}` (`by`). Entries from before scopes have a bare
 * instance id: those are the workspace's.
 */
export type UsageTally = Record<string, Record<string, Tally & { by?: Record<string, Tally> }>>;
const USAGE_FILE = () => path.join(env.dataDir, "mac-claude-usage.json");
let tally: Promise<UsageTally> | null = null;
let saving: Promise<void> = Promise.resolve();
const loadTally = () => (tally ??= readFile(USAGE_FILE(), "utf-8").then((t) => JSON.parse(t) as UsageTally).catch((): UsageTally => ({})));

/** One answer's usage, tallied by hour and label (the Mac's own, and the API path's with " (API)"), and by scope and provider instance. */
export async function recordUsage(label: string, u: MacUsage, instance?: string, scope: Scope = "workspace"): Promise<void> {
  const all = await loadTally();
  const hour = new Date().toISOString().slice(0, 13);
  const t = ((all[hour] ??= {})[label] ??= { calls: 0, tokens: 0, costUsd: 0 });
  const add = (x: Tally) => {
    x.calls++;
    x.tokens += u.tokens;
    x.costUsd += u.costUsd;
  };
  add(t);
  if (instance) add((t.by ??= {})[`${scope}:${instance}`] ??= { calls: 0, tokens: 0, costUsd: 0 });
  for (const h of Object.keys(all).sort().slice(0, -24 * 90)) delete all[h]; // 90 days
  const json = JSON.stringify(all);
  saving = saving
    .then(async () => {
      const tmp = `${USAGE_FILE()}.tmp-${process.pid}`;
      await writeFile(tmp, json);
      await rename(tmp, USAGE_FILE());
    })
    .catch((e: unknown) => console.warn(`[mac-claude] usage not saved: ${e instanceof Error ? e.message : e}`));
}

/** The tally's hours since `since` (ms). */
export async function macUsageSince(since: number): Promise<UsageTally> {
  const from = new Date(since).toISOString().slice(0, 13);
  return Object.fromEntries(Object.entries(await loadTally()).filter(([h]) => h >= from));
}

/** Why an answer from the Mac did not come, so callers can tell a Stop from a limit from a Mac that never picked up. */
export type MacErrorKind = "unclaimed" | "stopped" | "timeout" | "limit" | "failed" | "gone";
/** The kinds a caller may move to the next provider of the same scope: the Mac never picked the request up, or Claude's usage limit turned it away. Any other kind means Claude already had it: a Stop, timeout or failure is reported, never swapped. */
export const MAC_MISS = new Set<MacErrorKind>(["unclaimed", "limit"]);

export class MacClaudeError extends Error {
  /** what the run had used before it failed (the relay sends the CLI's usage with a fail) */
  usage?: MacUsage;
  /** a usage limit or rate limit turned it away; `until` is when it opens again, when the refusal said (limitResetAt) */
  limited?: { until: number | null };
  constructor(message: string, readonly kind: MacErrorKind) {
    super(message);
    this.name = "MacClaudeError";
  }
}


interface Req {
  id: string;
  /** the device that may claim it: the provider's (contracts/providers.ts) */
  device: string;
  system: string;
  user: string;
  web: boolean;
  background: boolean;
  label: string;
  files?: Record<string, string>;
  model?: string;
  provider?: MacOpts["provider"];
  onStep?: (label: string) => void;
  session?: MacOpts["session"];
  mcp?: MacOpts["mcp"];
  onAsk?: MacOpts["onAsk"];
  keep?: Kept;
  claimed: boolean;
  /** when the 20-minute clock started; moved on by the time a permission question waits for a person (/:id/ask) */
  claimedAt: number;
  /** the last post was an ask answered "waiting" at this time */
  waitedAt?: number;
  text: string;
  seen: number;
  /** deltas run one after another, like a stream's */
  chain: Promise<void>;
  onDelta: (text: string) => Promise<void> | void;
  done: (text: string, usage?: MacUsage, session?: MacSession) => void;
  fail: (e: Error) => void;
}

const reqs = new Map<string, Req>();
/** the polls waiting for a request, each for its device; `step` asks again whether the hint is due (a poll that listed editor kinds) */
let waiters: Array<{ device: string; fn: (r: Req | "hint" | null) => void; step?: () => Promise<boolean> }> = [];

/** A step a device may claim was queued (a cut-out, lib/cutouts.ts): each held poll that listed editor kinds is asked again and answered with the hint when it is due. */
export async function wakeEditorPolls(): Promise<void> {
  // never rejects: it runs unawaited, and an unhandled rejection ends the server (folder-plugins.ts)
  for (const w of [...waiters]) if (w.step && (await w.step().catch(() => false)) && waiters.includes(w)) {
    waiters = waiters.filter((x) => x !== w);
    w.fn("hint");
  }
}

/**
 * How many answers a restart of this server would lose right now: every request but those a Mac is writing for a
 * caller that takes them up again (MacOpts.keep). /api/health says it, and a deploy waits for 0 before it restarts.
 */
export const answersAtRisk = (): number => [...reqs.values()].filter((r) => !(r.claimed && r.keep)).length;

/**
 * how long a request waits for the Mac before its caller falls back; longer while the Mac is on but every slot runs.
 * afterStart: a restart of this server cuts every Mac's poll off, and a relay then waits up to 30 s before it polls
 * again (its own back-off), so a request made in this process's first 45 s waits that long.
 */
const PATIENCE_MS = { now: 15_000, busy: 3 * 60_000, background: 10 * 60_000, afterStart: 45_000 };
const startedAt = Date.now();
export const BACKGROUND_SLOTS = 2;
/** the Mac runs this many Claude calls at once (the Mac relay SLOTS) */
const MAC_SLOTS = 4;
/** the Mac posts at least every 20 s while Claude thinks */
export const SILENT_MS = 60_000;
const TOTAL_MS = 20 * 60_000;

const macFull = (device: string) => [...reqs.values()].filter((r) => r.claimed && r.device === device).length >= MAC_SLOTS;

/** How long a request waits: the Mac on but full is working, so a person waits longer for it than for a silent Mac. */
export function patienceMs(background: boolean, busy: boolean, sinceStart = Infinity): number {
  const usual = background ? PATIENCE_MS.background : busy ? PATIENCE_MS.busy : PATIENCE_MS.now;
  return sinceStart < PATIENCE_MS.afterStart ? Math.max(usual, PATIENCE_MS.afterStart) : usual;
}

/** The next request for a device: what a person waits on first, background only while one of its slots is free. */
function next(device: string): Req | undefined {
  const open = [...reqs.values()].filter((r) => !r.claimed && r.device === device);
  const busy = [...reqs.values()].filter((r) => r.claimed && r.background && r.device === device).length;
  return open.find((r) => !r.background) ?? (busy < BACKGROUND_SLOTS ? open.find((r) => r.background) : undefined);
}

function claim(r: Req): Req {
  r.claimed = true;
  r.claimedAt = r.seen = Date.now();
  keepOpen(r);
  return r;
}

/* ---- claimed requests kept on disk, so a restart doesn't lose their answers ---- */

/** What the file holds: who runs it and for whom. The Mac already has the prompt, the files and the token. */
type Saved = Pick<Req, "id" | "device" | "web" | "background" | "label" | "model" | "provider" | "session"> & { keep: Kept };
const openDir = () => path.join(env.dataDir, "mac-claude-open");
const openFile = (id: string) => path.join(openDir(), `${id}.json`);

function keepOpen(r: Req): void {
  if (!r.keep || !keepsOverRestart()) return;
  const saved: Saved = { id: r.id, device: r.device, web: r.web, background: r.background, label: r.label, model: r.model, provider: r.provider, session: r.session, keep: r.keep };
  try {
    mkdirSync(openDir(), { recursive: true, mode: 0o700 });
    const tmp = `${openFile(r.id)}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(saved), { mode: 0o600 });
    renameSync(tmp, openFile(r.id));
  } catch (e) {
    // the answer still arrives while this process lives
    console.warn(`[mac-claude] request not kept for a restart: ${e instanceof Error ? e.message : e}`);
  }
}

const dropOpen = (name: string): void => rmSync(path.join(openDir(), name), { force: true });

function readOpen(id: string): Saved | null {
  try {
    const s = JSON.parse(readFileSync(openFile(id), "utf-8")) as Saved;
    return s.id === id && typeof s.device === "string" && typeof s.keep?.kind === "string" ? s : null;
  } catch {
    return null;
  }
}

/** An answer a restart left running on a Mac: its request's id and what its caller kept. */
export interface Open {
  id: string;
  keep: Kept;
}
const adopters = new Map<string, (open: Open[]) => void>();
/**
 * A caller that can take its answers up again says so once, when it loads. `take` gets several at once (it may have to
 * know them all before it reads its own data) and calls adoptMacClaude for each, or leaves one (it is then dropped).
 */
export const onAdopt = (kind: string, take: (open: Open[]) => void): void => void adopters.set(kind, take);

/**
 * The answers kept on disk that this process isn't running: left by the process before it. That one may still be
 * alive and answering them (a deploy's reload runs the old and the new side by side for some seconds), so nothing is
 * taken up just because it is here. Never on a dev server (keepsOverRestart).
 */
export function keptOpen(): Open[] {
  if (!keepsOverRestart()) return [];
  let names: string[] = [];
  try {
    names = readdirSync(openDir());
  } catch {
    return []; // nothing was ever kept
  }
  return names.flatMap((name) => {
    const id = name.replace(/\.json$/, "");
    const saved = name.endsWith(".json") && !reqs.has(id) ? readOpen(id) : null;
    return saved ? [{ id, keep: saved.keep }] : [];
  });
}

/**
 * The kept answers `pick` chooses go back to their callers, and one nobody takes is dropped (its Mac's next post gets
 * 404 and it stops). When: a Mac posts about one (relayRoutes), its person stops it, or it has been silent for a
 * minute after the restart (the callers ask).
 */
export function adoptKept(pick: (open: Open) => boolean): void {
  const found = keptOpen().filter(pick);
  for (const [kind, take] of adopters) {
    const mine = found.filter((o) => o.keep.kind === kind);
    try {
      if (mine.length) take(mine);
    } catch (e) {
      console.warn(`[mac-claude] ${kind}: answers not taken up after the restart: ${e instanceof Error ? e.message : e}`);
    }
  }
  for (const o of found) if (!reqs.has(o.id)) dropOpen(`${o.id}.json`);
}

/** At boot: answers kept for a caller that no longer takes them are dropped. */
export const dropUnowned = (): void => adoptKept((o) => !adopters.has(o.keep.kind));

let leaving = false;
/**
 * This process is on its way out: a deploy's reload has the next one listening already. The polls it holds end now,
 * so each computer asks again at once and reaches the next process (a poll cut off by the kill makes the relay wait
 * 30 s), and a post about a running answer is turned away with 503: the relay sends it again, to the next process.
 */
export function leave(): void {
  leaving = true;
  for (const w of waiters.splice(0)) w.fn(null);
}

/**
 * Takes up an answer a restart left running: the promise streamMacClaude would have given, fed by the same Mac. Its
 * 20 minutes start again (the time a permission question waited isn't kept). null = no such answer.
 */
export function adoptMacClaude(id: string, cancel: AbortSignal | undefined, onDelta: (text: string) => Promise<void> | void, hooks: Hooks = {}): Promise<string> | null {
  const saved = reqs.has(id) ? null : readOpen(id);
  return saved && wait({ ...saved, system: "", user: "" }, true, cancel, onDelta, undefined, hooks);
}

/** Hand waiting requests to the polls of the devices they are for. */
function pump() {
  for (let i = 0; i < waiters.length; ) {
    const w = waiters[i]!;
    const r = next(w.device);
    if (!r) {
      i++;
      continue;
    }
    waiters.splice(i, 1);
    w.fn(claim(r));
  }
}

/** One answer from Claude on the Mac; onDelta gets the whole text so far. Rejects with a MacClaudeError (its kind says why) so a caller can fall back. */
export function streamMacClaude(
  system: string,
  user: string,
  cancel: AbortSignal | undefined,
  onDelta: (text: string) => Promise<void> | void,
  onUsage?: (u: MacUsage) => void,
  opts: MacOpts = {},
): Promise<string> {
  // ponytail: no device = nothing to run it: an unclaimed miss, so an API-key fallback may still answer
  if (!opts.provider?.device) return Promise.reject(new MacClaudeError("No Mac runs this provider: pick one in Settings → Providers", "unclaimed"));
  return wait(
    { id: randomUUID(), device: opts.provider.device, system, user, web: !!opts.web, background: !!opts.background, label: opts.label ?? "other", files: opts.files, model: opts.model, provider: opts.provider, session: opts.session, mcp: opts.mcp, keep: opts.keep },
    false,
    cancel,
    onDelta,
    onUsage,
    opts,
  );
}

type Asked = Pick<Req, "id" | "device" | "system" | "user" | "web" | "background" | "label" | "files" | "model" | "provider" | "session" | "mcp" | "keep">;
type Hooks = Pick<MacOpts, "onStep" | "onAsk" | "onSession">;

/** The promise of one request's answer: a new one waits for its Mac, one taken up after a restart (`claimed`) is already with it. */
function wait(asked: Asked, claimed: boolean, cancel: AbortSignal | undefined, onDelta: (text: string) => Promise<void> | void, onUsage: ((u: MacUsage) => void) | undefined, hooks: Hooks): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const r: Req = {
      ...asked,
      onStep: hooks.onStep,
      onAsk: hooks.onAsk,
      claimed,
      claimedAt: claimed ? started : 0,
      text: "",
      seen: started,
      chain: Promise.resolve(),
      onDelta,
      done: (text, usage, session) => {
        end();
        if (usage) {
          console.log(`[mac-claude] ${r.label}${r.provider ? ` (${r.provider.instance})` : ""}: ${usage.tokens} tokens, $${usage.costUsd.toFixed(2)} API-equivalent`);
          void recordUsage(r.label, usage, r.provider?.instance, r.provider?.scope);
          onUsage?.(usage);
        }
        if (session) hooks.onSession?.(session);
        if (text.trim()) {
          noteOutcome(true);
          resolve(text);
        } else {
          noteOutcome(false, "Claude returned an empty answer");
          reject(new MacClaudeError("Claude returned an empty answer", "failed"));
        }
      },
      fail: (e) => {
        end();
        // the AI itself failed (not a stop, a usage limit, or a Mac that did not pick the request up): its check says so
        if (e instanceof MacClaudeError && (e.kind === "failed" || e.kind === "timeout")) noteOutcome(false, e.message);
        // a usage limit: the AI works, its plan is used up; Settings and the Media Library say so until it answers again
        if (e instanceof MacClaudeError && e.kind === "limit") noteOutcome(true, undefined, limitLine(e.message));
        reject(e);
      },
    };
    // the instance this call went through, if any: its outcome is recorded as that instance's check
    const noteOutcome = (ok: boolean, error?: string, note?: string) => {
      const p = r.provider;
      if (p?.scope && p.instance) void noteCallOutcome(p.scope, p.instance, ok, error, note).catch(() => {});
    };
    const onAbort = () => r.fail(new MacClaudeError("Stopped", "stopped"));
    const check = setInterval(() => {
      // on its way out: its answers are the next process's now (their posts are turned away here), so nothing is failed for silence
      if (leaving) return;
      const now = Date.now();
      const on = isOnline(r.device);
      // only a real server gives the time after its start: under tests and on a dev server the Macs' polls were never cut
      if (!r.claimed && now - started > patienceMs(r.background, on && macFull(r.device), env.isProduction ? started - startedAt : Infinity))
        r.fail(new MacClaudeError(unclaimedMessage(r.device, on), "unclaimed"));
      else if (r.claimed && now - r.seen > SILENT_MS) r.fail(new MacClaudeError("The Mac stopped answering", "failed"));
      else if (r.claimed && now - r.claimedAt > TOTAL_MS) r.fail(new MacClaudeError("Claude took over 20 minutes", "timeout"));
    }, 5_000);
    function end() {
      clearInterval(check);
      reqs.delete(r.id);
      if (r.keep) dropOpen(`${r.id}.json`);
      cancel?.removeEventListener("abort", onAbort);
      pump(); // a background slot may be free now
    }
    reqs.set(r.id, r);
    cancel?.addEventListener("abort", onAbort);
    pump();
  });
}

const unclaimedMessage = (device: string, on: boolean): string =>
  on ? `${deviceName(device)} did not pick up the request` : `${deviceName(device)} is offline: open the Creator Toolset Mac app on it`;

/**
 * The relay's routes for a device (mounted at /api/devices/relay, its ctd_ token). `deviceOf` says which device the
 * caller is (null = not allowed).
 */
export function relayRoutes(deviceOf: (c: Context) => string | null, editorWaits?: (device: string, kinds: unknown) => Promise<boolean>) {
  const app = new Hono<{ Variables: { device: string } }>();

  /** Any call from the relay says its device is here: a running job's text, step, done or fail keeps it on while every slot is busy (no poll then). */
  app.use("*", async (c, next) => {
    const device = deviceOf(c);
    if (!device) return c.json({ error: "Unauthorized" }, 401);
    c.set("device", device);
    touchDevice(device, c.req.header("user-agent"));
    // on its way out (leave): a post about a running answer goes to the next process (the relay sends it again on 503)
    if (leaving && /\/(text|step|ask|done|fail)$/.test(c.req.path)) return c.json({ error: "Restarting" }, 503);
    await next();
  });

  /** A waiting request for this device, or 204 after 25 s. A relay that sends {blobs: true} keeps big files itself (packFor). */
  app.post("/wait", async (c) => {
    if (leaving) return c.body(null, 204); // ask again: the next process answers
    const device = c.get("device");
    const b = await body(c);
    const keeps = b.blobs === true;
    // a poll that lists editor step kinds (contracts/devices.ts): when one waits that this device could claim now, the
    // poll is answered with the hint, after any AI request. A poll that lists none is never answered with it.
    const step = "editor" in b && !!(await editorWaits?.(device, b.editor));
    const queued = next(device);
    if (queued) return c.json(packFor(claim(queued), keeps));
    if (step) return c.json(EDITOR_HINT);
    const got = await new Promise<Req | "hint" | null>((resolve) => {
      const w = {
        device,
        ...("editor" in b && editorWaits ? { step: () => editorWaits(device, b.editor) } : {}),
        fn: (r: Req | "hint" | null) => {
          clearTimeout(timer);
          resolve(r);
        },
      };
      const timer = setTimeout(() => {
        waiters = waiters.filter((x) => x !== w);
        resolve(null);
      }, 25_000);
      waiters.push(w);
    });
    return got === "hint" ? c.json(EDITOR_HINT) : got ? c.json(packFor(got, keeps)) : c.body(null, 204);
  });

  /** A big file of one of this device's requests, by its hash (the relay asks once and keeps it). */
  app.on(["GET", "POST"], "/blob/:sha", (c) => {
    const b = blobs.get(c.req.param("sha"));
    return b && b.device === c.get("device") ? c.json({ text: b.text }) : c.json({ error: "Not found" }, 404);
  });

  /** The request this device runs (another device's is not its own: 404). */
  const mine = (c: Context): Req | undefined => {
    const id = c.req.param("id") ?? "";
    // kept by the process before this one: its Mac is posting here now, so it goes back to its caller
    if (!reqs.has(id)) adoptKept((o) => o.id === id);
    const r = reqs.get(id);
    return r && r.device === c.get("device") ? r : undefined;
  };

  /** The text so far (or the same text: still thinking). 404 = nobody waits for it any more, stop. */
  app.post("/:id/text", async (c) => {
    const r = mine(c);
    if (!r) return c.json({ error: "Not found" }, 404);
    const b = await body(c);
    r.seen = Date.now();
    if (typeof b.text === "string" && b.text.length > r.text.length) {
      const text = (r.text = b.text);
      r.chain = r.chain.then(() => r.onDelta(text)).catch((e: unknown) => r.fail(new MacClaudeError(e instanceof Error ? e.message : String(e), "failed")));
    }
    return c.json({ ok: true });
  });

  /** A tool call Claude just made, for the author to see. */
  app.post("/:id/step", async (c) => {
    const r = mine(c);
    if (!r) return c.json({ error: "Not found" }, 404);
    const b = await body(c);
    r.seen = Date.now();
    if (typeof b.label === "string" && b.label.trim()) {
      try {
        r.onStep?.(b.label.trim().slice(0, 300));
      } catch (e) {
        console.warn(`[mac-claude] step: ${e instanceof Error ? e.message : e}`);
      }
    }
    return c.json({ ok: true });
  });

  /** A permission question (MacOpts.onAsk), asked again until it's answered; a job without onAsk never asks, so no. */
  app.post("/:id/ask", async (c) => {
    const r = mine(c);
    if (!r) return c.json({ error: "Not found" }, 404);
    const prev = r.seen;
    const now = (r.seen = Date.now());
    const b = await body(c);
    const text = (k: string, max: number) => (typeof b[k] === "string" ? (b[k] as string).slice(0, max) : "");
    const id = text("ask_id", 100);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !text("tool", 80)) return c.json({ error: "Bad ask" }, 400);
    const ask: MacAsk = { id, tool: text("tool", 80), description: text("description", 300), reason: text("reason", 300), detail: text("detail", 4000) };
    let status: MacAskStatus = "denied";
    try {
      if (r.onAsk) status = r.onAsk(ask);
    } catch (e) {
      console.warn(`[mac-claude] ask: ${e instanceof Error ? e.message : e}`);
    }
    // the clock stops while a person decides: the time since the last "waiting" answer doesn't count toward TOTAL_MS
    if (status === "waiting") {
      if (r.waitedAt === prev) r.claimedAt += now - prev;
      r.waitedAt = now;
    }
    return c.json({ status });
  });

  app.post("/:id/done", async (c) => {
    const r = mine(c);
    const b = await body(c);
    if (!r) {   // stopped meanwhile: its tokens are still tallied, as /fail does
      const usage = usageOf(b.usage);
      if (usage) void recordUsage("Stopped", usage);
      return c.json({ error: "Not found" }, 404);
    }
    await r.chain; // what streamed lands before the final answer
    r.done(typeof b.text === "string" ? b.text : r.text, usageOf(b.usage) ?? { tokens: 0, costUsd: 0 }, r.session ? sessionOf(b) : undefined);
    return c.json({ ok: true });
  });

  /** A failed run keeps what it used (the relay sends the CLI's usage). A stopped run's request is already gone: its spend is tallied as "Stopped". */
  app.post("/:id/fail", async (c) => {
    const r = mine(c);
    const b = await body(c);
    const usage = usageOf(b.usage);
    if (usage) void recordUsage(r?.label ?? "Stopped", usage, r?.provider?.instance, r?.provider?.scope);
    if (!r) return c.json({ error: "Not found" }, 404);
    const error = String(b.error ?? "failed").slice(0, 300);
    // the relay says what the CLI said; a closed usage window says when it opens again
    const tool = DRIVERS.find((d) => d.id === r.provider?.driver)?.label ?? "Claude";
    if (b.limit === true) console.warn(`[ai] ${r.label ?? "a call"}: usage limit (${error})`); // the CLI's own words, for the log only
    const err = b.limit === true ? new MacClaudeError(limitMessage(error, tool), "limit") : new MacClaudeError(r.provider?.driver && r.provider.driver !== "claude" ? error : `Claude on the Mac: ${error}`, b.gone === true ? "gone" : "failed"); // the other CLIs' errors name themselves ("Codex: …")
    err.usage = usage;
    // a plan's window, or a 429 on the way (a gateway's "rate_limit_error … (reset after 37m41s)"): it can go on later
    const raw = String(b.error ?? "");
    if (b.limit === true || /\b429\b|rate_limit_error/.test(raw)) err.limited = { until: limitResetAt(raw) };
    r.fail(err);
    return c.json({ ok: true });
  });

  /** The plan limits of this Mac's config folders (Limits.swift, every five minutes). Kept in DATA_DIR/limits.json (api/lib/limits.ts); never a token. */
  app.post("/limits", async (c) => {
    saveLimits(c.get("device"), await body(c));
    return c.json({ ok: true });
  });

  /** What the Mac has (the Mac relay `report`): its CLIs and their config folders. Kept as the device's report. */
  app.post("/report", async (c) => {
    const device = c.get("device");
    const b = await body(c);
    const list = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
    const machine = parseMachine(b.machine);
    const r: MacReport = { at: Date.now(), drivers: list(b.drivers), homes: list(b.homes), ...(machine ? { machine } : {}) };
    saveReport(device, r, typeof b.version === "string" ? b.version.slice(0, 40) : undefined);
    return c.json({ ok: true });
  });

  return app;
}

/**
 * Big text files (a book in Knowledge) go to a relay that keeps them as "sha256:<hex>": it fetches each once from
 * /blob and reuses its copy on every later turn, so a turn carries a hash instead of megabytes.
 * ponytail: the texts stay in this map for 30 min after their request; a restart in between = the relay's fetch 404s
 * and the turn fails once (the next turn sends it again).
 */
const BLOB_MIN = 256 * 1024;
const BLOB_KEEP_MS = 30 * 60_000;
const blobs = new Map<string, { text: string; device: string; at: number }>();
export function packFor(r: Req, keepsBlobs: boolean) {
  const p = pack(r);
  if (!keepsBlobs || !p.files) return p;
  const now = Date.now();
  for (const [k, v] of blobs) if (now - v.at > BLOB_KEEP_MS) blobs.delete(k);
  const files: Record<string, string> = {};
  for (const [path, text] of Object.entries(p.files)) {
    if (text.length < BLOB_MIN || text.startsWith("base64:")) {
      files[path] = text;
      continue;
    }
    const sha = createHash("sha256").update(text).digest("hex");
    blobs.set(sha, { text, device: r.device, at: now });
    files[path] = `sha256:${sha}`;
  }
  return { ...p, files };
}

// `model` (another Claude, e.g. Fable) only ever goes to a Claude provider: a Codex or Gemini run keeps its own model.
const pack = (r: Req) => ({
  id: r.id,
  device: r.device,
  system: r.system,
  user: r.user,
  web: r.web,
  ...(r.files ? { files: r.files } : {}),
  ...(r.provider ? { instance: r.provider.instance, driver: r.provider.driver, effort: r.provider.effort, ...(r.provider.home ? { home: r.provider.home } : {}), ...(r.provider.scope ? { scope: r.provider.scope } : {}), ...(r.provider.baseUrl ? { baseUrl: r.provider.baseUrl } : {}), ...(r.provider.envNames?.length ? { envNames: r.provider.envNames } : {}), ...(r.provider.launchArgs?.length ? { launchArgs: r.provider.launchArgs } : {}), ...(r.provider.acp ? { acp: r.provider.acp } : {}), ...(r.provider.binaryPath ? { binaryPath: r.provider.binaryPath } : {}) } : {}),
  ...(r.model || r.provider ? { model: r.provider && r.provider.driver !== "claude" ? r.provider.model : (r.model ?? r.provider?.model) } : {}),
  ...(r.session ? { session: r.session.key, ...(r.session.resume ? { resume: r.session.resume } : {}) } : {}),
  ...(r.mcp ? { mcp: r.mcp } : {}),
  ...(r.onAsk ? { asks: true } : {}),
});
const body = (c: { req: { json: () => Promise<unknown> } }) =>
  c.req.json().then((b) => (b && typeof b === "object" ? (b as Record<string, unknown>) : {})).catch(() => ({}) as Record<string, unknown>);
/** The usage a relay post carries (done or fail), or undefined. */
function usageOf(raw: unknown): MacUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  return { tokens: n("input") + n("output") + n("cache_read") + n("cache_write"), costUsd: n("cost_usd"), cacheRead: n("cache_read"), ...(n("context") ? { context: n("context") } : {}) };
}

/** The Claude session a done post names (the Mac relay): its id, and whether it was new, resumed or lost. */
function sessionOf(b: Record<string, unknown>): MacSession | undefined {
  if (typeof b.session_id !== "string" || !b.session_id) return undefined;
  const state = b.session_state === "resumed" || b.session_state === "lost" ? b.session_state : "new";
  return { id: b.session_id, state };
}

