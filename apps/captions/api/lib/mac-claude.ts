import { Hono, type Context } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DRIVERS, parseMachine, type AcpCommand, type Driver, type Effort, type MacReport, type Scope } from "../../contracts/providers";
import { EDITOR_HINT } from "../../contracts/devices";
import { limitLine, limitMessage } from "../../contracts/plans";
import { env } from "./env";
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
}

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
let waiters: Array<{ device: string; fn: (r: Req | "hint") => void; step?: () => Promise<boolean> }> = [];

/** A step a device may claim was queued (a cut-out, lib/cutouts.ts): each held poll that listed editor kinds is asked again and answered with the hint when it is due. */
export async function wakeEditorPolls(): Promise<void> {
  // never rejects: it runs unawaited, and an unhandled rejection ends the server (folder-plugins.ts)
  for (const w of [...waiters]) if (w.step && (await w.step().catch(() => false)) && waiters.includes(w)) {
    waiters = waiters.filter((x) => x !== w);
    w.fn("hint");
  }
}

/** how long a request waits for the Mac before its caller falls back; longer while the Mac is on but every slot runs */
const PATIENCE_MS = { now: 15_000, busy: 3 * 60_000, background: 10 * 60_000 };
export const BACKGROUND_SLOTS = 2;
/** the Mac runs this many Claude calls at once (the Mac relay SLOTS) */
const MAC_SLOTS = 4;
/** the Mac posts at least every 20 s while Claude thinks */
const SILENT_MS = 60_000;
const TOTAL_MS = 20 * 60_000;

const macFull = (device: string) => [...reqs.values()].filter((r) => r.claimed && r.device === device).length >= MAC_SLOTS;

/** How long a request waits: the Mac on but full is working, so a person waits longer for it than for a silent Mac. */
export function patienceMs(background: boolean, busy: boolean): number {
  return background ? PATIENCE_MS.background : busy ? PATIENCE_MS.busy : PATIENCE_MS.now;
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
  return r;
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
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const r: Req = {
      id: randomUUID(),
      device: opts.provider!.device!,
      system,
      user,
      web: !!opts.web,
      background: !!opts.background,
      label: opts.label ?? "other",
      files: opts.files,
      model: opts.model,
      provider: opts.provider,
      onStep: opts.onStep,
      session: opts.session,
      mcp: opts.mcp,
      onAsk: opts.onAsk,
      claimed: false,
      claimedAt: 0,
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
        if (session) opts.onSession?.(session);
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
      const p = opts.provider;
      if (p?.scope && p.instance) void noteCallOutcome(p.scope, p.instance, ok, error, note).catch(() => {});
    };
    const onAbort = () => r.fail(new MacClaudeError("Stopped", "stopped"));
    const check = setInterval(() => {
      const now = Date.now();
      const on = isOnline(r.device);
      if (!r.claimed && now - started > patienceMs(r.background, on && macFull(r.device)))
        r.fail(new MacClaudeError(unclaimedMessage(r.device, on), "unclaimed"));
      else if (r.claimed && now - r.seen > SILENT_MS) r.fail(new MacClaudeError("The Mac stopped answering", "failed"));
      else if (r.claimed && now - r.claimedAt > TOTAL_MS) r.fail(new MacClaudeError("Claude took over 20 minutes", "timeout"));
    }, 5_000);
    function end() {
      clearInterval(check);
      reqs.delete(r.id);
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
    touchDevice(device);
    await next();
  });

  /** A waiting request for this device, or 204 after 25 s. A relay that sends {blobs: true} keeps big files itself (packFor). */
  app.post("/wait", async (c) => {
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
        fn: (r: Req | "hint") => {
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
    const r = reqs.get(c.req.param("id") ?? "");
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

