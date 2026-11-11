import {
  isOutOfCredits,
  outOfCreditsMessage,
} from "./credits";
import { DRIVERS, type JobId, type Selection } from "../contracts/providers";
import { MAC_MISS, MacClaudeError, recordUsage, streamMacClaude, type MacOpts, type MacUsage } from "./lib/mac-claude";
import { instanceIn, limitFallbacks, routeFor, runFields } from "./lib/providers";
import { completeLocal } from "./lib/local-claude";
import { hostedMode } from "./lib/env";
import { addSpend, budgetLeft } from "./lib/workspaces";
import { keyFor } from "./my-keys";
import { fewestTokens, localModelOf } from "./local-model";
import type { LocalModel } from "../contracts/service-keys";
import { findUser, type SessionUser } from "./users";

/**
 * Every AI call in the app. It goes to a provider (contracts/providers.ts: a coding-agent CLI on a Mac,
 * through a paired Mac, signed in as that person). An Anthropic API key answers
 * an account with no provider that saved its own (Settings → API keys); never the server's (my-keys.ts keyFor).
 */

export const OUT_OF_TOKENS_CODE = "OUT_OF_TOKENS";
export const OUT_OF_TOKENS_MSG = outOfCreditsMessage("The AI caption pass");
export const isOutOfTokens = isOutOfCredits;

const CHUNK_TIMEOUT_MS = 240_000;

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | typeof OUT_OF_TOKENS_CODE
      | "RATE_LIMIT"
      | "AUTH"
      | "TIMEOUT"
      | "ABORTED"
      | "FAILED",
    readonly retryable: boolean,
    /** what failed underneath: a MacClaudeError keeps its kind here */
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = "AiProviderError";
  }
}

/** "mac" = a provider on a paired Mac (lib/mac-claude.ts); "anthropic" = the API key (guests, demo);
 *  "local" = Claude Code on the machine running this code (lib/local-claude.ts), for scripts only. */
// "localModel" = a model the person runs themselves, at the address they typed (local-model.ts); not "local", which is Claude Code here.
export type ProviderId = "anthropic" | "mac" | "local" | "localModel";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type ProviderOpts = {
  /** Extra attempts on the same provider after a retryable failure. */
  retries?: number;
  /** Exactly these, in this order (the configured ones). */
  only?: ProviderId[];
  /** The Mac's provider call: what it is for (its usage tally), the provider, and its measured usage. The API path uses the label too. */
  mac?: Pick<MacOpts, "label" | "background" | "files" | "web" | "onStep" | "session" | "onSession" | "provider" | "model">;
  onUsage?: (usage: MacUsage) => void;
  /** Anthropic API only: its output_config.effort and model (the providers page's API settings). */
  effort?: Effort;
  model?: string;
  /** The Anthropic API key this call runs on (keyFor's: the caller's own, or the server's where it serves them). */
  apiKey?: string;
  /** A workspace member on an API budget (hosted only): the API answer's cost goes on their month. */
  bill?: string;
  /** The model server a "localModel" call goes to (aiFor's: the caller's own, from Settings → API keys). */
  localModel?: LocalModel;
  /** Why there is no provider for this caller: the call fails with it. */
  off?: string;
  /** Pictures before the text (Anthropic only; pass `only: ["anthropic"]`, the others would never see them). */
  images?: Array<{ type: string; data: string }>;
};

/** Who is asking: a session, or a username (background work names its owner). Nobody = no AI. */
type Who = Pick<SessionUser, "username" | "role"> | string | undefined;

/** The name a Mac answer carries: the CLI that ran it ("Codex (Mac)"), Claude when the call names none. */
export const macLabelOf = (opts: ProviderOpts): string => `${DRIVERS.find((d) => d.id === opts.mac?.provider?.driver)?.label ?? "Claude"} (Mac)`;

/**
 * Where one AI call goes. Accounts: the job's provider (the session's own pick first), with the label for the
 * usage tally. Its scope (lib/providers.ts routeFor): the account's own providers when it has a runnable one on its
 * own Macs, else, for an admin, the workspace's providers on the admin's own Macs. A member with neither gets its own
 * Anthropic key or no AI. Nobody named: no AI.
 */
export function aiFor(who: Who, job: JobId, label: string, own?: Selection): ProviderOpts {
  const name = typeof who === "string" ? who : who?.username;
  const role = typeof who === "string" ? findUser(who)?.role : who?.role;
  // nobody named: never the server's providers (background work names whose work it is)
  if (!name || role === "visitor") return { only: [], off: "This AI call names no account" };
  const r = routeFor(name, role === "admin", job, own);
  if (!r) return onLocalModel(name, job, label) || onApiKey(name, job, label) || onBudget(name, job, label) || { only: [], off: "No AI for your account: add one in Settings → Providers, or your Anthropic key in Settings → API keys" };
  const { selection, instance } = r;
  return {
    only: ["mac"],
    mac: { label, provider: { instance: instance.id, driver: instance.driver, home: instance.home, model: selection.model, effort: selection.effort, device: r.device, scope: r.scope, ...runFields(instance) } },
  };
}

/**
 * An account with no provider (or bulk work that asks for the key first: the Media Library's descriptions): its own
 * Anthropic key from Settings → API keys (keyFor), at anthropicParams' model
 * and effort. Never the Workshop: a Workshop turn is Claude Code reading the session's folder, which a plain API call
 * can't (it needs their own AI).
 */
export function onApiKey(name: string, job: JobId, label: string): ProviderOpts | null {
  const k = keyFor(name, "ANTHROPIC_API_KEY");
  if (!k.key) return null;
  if (job === "workshop") return { only: [], off: "Content Workshop runs on your own AI (it reads the whole project folder): connect yours in Settings → Providers" };
  return { only: ["anthropic"], retries: 1, apiKey: k.key, mac: { label } };
}

/**
 * An account with no provider that typed a local model (localModelOf: an install's own admin, never a hosted server):
 * its text jobs go to that address, before its Anthropic key. The route carries no key and no retry, and names one
 * provider, so a local model that is down fails the call and nothing else answers it. Never the Workshop, as above.
 */
function onLocalModel(name: string, job: JobId, label: string): ProviderOpts | null {
  const localModel = localModelOf(name);
  if (!localModel) return null;
  if (job === "workshop") return { only: [], off: "Content Workshop runs on your own AI (it reads the whole project folder): connect yours in Settings → Providers" };
  return { only: ["localModel"], localModel, mac: { label } };
}

/**
 * A member on a monthly API budget (hosted only, Settings → Team), with no provider or key of their own: the server's
 * Anthropic key, billed to them. Never the Workshop: a Workshop turn reads the session's folder, which a plain API call
 * can't (it needs their own AI).
 */
function onBudget(name: string, job: JobId, label: string): ProviderOpts | null {
  if (!hostedMode()) return null;
  const left = budgetLeft(name);
  if (left === null) return null;
  if (job === "workshop") return { only: [], off: "Content Workshop runs on your own AI (it reads the whole project folder): connect yours in Settings → Providers" };
  if (left <= 0) return { only: [], off: "Your AI budget for this month is used up: ask your workspace's owner or an admin for more" };
  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  if (!apiKey) return { only: [], off: "The workspace's API key isn't set up: ask the owner" };
  return { only: ["anthropic"], retries: 1, apiKey, bill: name, mac: { label } };
}

/** Order the configured providers: exactly `only`, in its order. */
export function providerChain(configured: readonly ProviderId[], opts: ProviderOpts = {}): ProviderId[] {
  return (opts.only ?? []).filter((id) => configured.includes(id));
}

/** A call that names no route runs nowhere: every call says whose AI it is (aiFor). */
function routed(opts: ProviderOpts): ProviderOpts {
  return opts.only ? opts : { ...opts, only: [], off: opts.off ?? "This AI call names no account" };
}

const tries = (opts: ProviderOpts) => 1 + Math.max(0, Math.min(2, opts.retries ?? 0));

interface Provider {
  id: ProviderId;
  label: string;
  configured: boolean;
  complete: (
    system: string,
    user: string,
    cancelSignal?: AbortSignal,
    opts?: ProviderOpts
  ) => Promise<string>;
}

/** Some AI can answer this caller: a provider of theirs, or their own Anthropic key. */
export const anyAiConfigured = (who: Who) => !aiFor(who, "notes", "check").off;

/**
 * API-equivalent prices in $ per million tokens, for the models this app
 * sends on the API path. Read 2026-11-04 from the claude-api skill's bundled
 * model table (cached 2026-10-06), not from the live pricing page. Cache
 * writes are the 5-minute price (1.25x input). An unlisted model reports
 * tokens and $0.
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

/** Anthropic's usage fields (message_start / message_delta on a stream, the body's usage otherwise). */
export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** tokens as mac-claude's /done counts them, and what the API would charge */
export function apiUsage(u: AnthropicUsage, model: string): MacUsage {
  const n = (x?: number | null) => x ?? 0;
  const p = PRICE_PER_MTOK[model];
  const costUsd = p
    ? (n(u.input_tokens) * p.input + n(u.output_tokens) * p.output + n(u.cache_read_input_tokens) * p.cacheRead + n(u.cache_creation_input_tokens) * p.cacheWrite) / 1e6
    : 0;
  return { tokens: n(u.input_tokens) + n(u.output_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens), costUsd };
}

/** An API answer's usage: the same hourly tally as the Mac's, under "<label> (API)" so the two stay apart. */
function reportApi(label: string | undefined, usage: MacUsage, onUsage?: (u: MacUsage) => void, bill?: string) {
  void recordUsage(`${label ?? "other"} (API)`, usage);
  if (bill) addSpend(bill, usage.costUsd);
  onUsage?.(usage);
}

/**
 * Model and effort for every Anthropic request. Claude Opus 5.5 always
 * thinks (it can't be turned off, and thinking counts toward max_tokens);
 * effort sets how much: the request's own, else ANTHROPIC_EFFORT, else low.
 */
export function anthropicParams(effort?: Effort, model?: string) {
  return {
    model: model || process.env.ANTHROPIC_MODEL || "claude-opus-5-5",
    output_config: { effort: effort ?? (process.env.ANTHROPIC_EFFORT || "low") },
  };
}

function providers(): Provider[] {
  const all: Provider[] = [
    // the route (aiFor) picked the key: a call without one is not sent
    { id: "anthropic", label: "Anthropic API", configured: true, complete: completeAnthropic },
    { id: "localModel", label: "Local model", configured: true, complete: completeLocalModel },
    { id: "mac", label: "Claude (Mac)", configured: true, complete: (system, user, cancel, opts) => streamMac(system, user, cancel, () => {}, opts?.onUsage, opts ?? {}) },
    // Claude Code on this machine: only scripts name it in `only`; aiFor never routes a site request here
    { id: "local", label: "Claude Code (this machine)", configured: true, complete: async (system, user, cancel) => {
      const r = await completeLocal(system, user, cancel);
      console.error(`claude -p: $${r.usage.costUsd.toFixed(4)} API-equivalent, ${r.usage.inputTokens} in / ${r.usage.outputTokens} out, ${(r.usage.ms / 1000).toFixed(1)} s`);
      return r.text;
    } },
  ];
  return all.filter((p) => p.configured);
}

/**
 * A provider on the Mac. A usage limit moves the call to the next provider that is on (only an exhausted
 * usage window falls back, never a stop or a failure); its label says which one answered.
 */
async function streamMac(system: string, user: string, cancel: AbortSignal | undefined, onDelta: (t: string) => Promise<void> | void, onUsage: ((u: MacUsage) => void) | undefined, opts: ProviderOpts): Promise<string> {
  const mac = opts.mac ?? {};
  try {
    return await streamMacClaude(system, user, cancel, onDelta, onUsage, mac);
  } catch (e) {
    const p = mac.provider;
    if (!(e instanceof MacClaudeError) || e.kind !== "limit" || !p) throw e;
    const scope = p.scope ?? "workspace";
    const inst = instanceIn(scope, p.instance);
    for (const next of inst ? limitFallbacks(scope, inst, p.model) : []) {
      console.warn(`[ai] ${p.instance} hit its usage limit: ${mac.label ?? "a call"} goes to ${next.instance.id}`);
      try {
        return await streamMacClaude(system, user, cancel, onDelta, onUsage, {
          ...mac,
          session: undefined, // another CLI can't resume this one's session
          onSession: undefined, // nor is its new session kept: the next turn starts over on the picked provider
          provider: { instance: next.instance.id, driver: next.instance.driver, home: next.instance.home, model: next.model, effort: p.effort, device: next.device, scope, ...runFields(next.instance) },
        });
      } catch (e2) {
        if (!(e2 instanceof MacClaudeError) || e2.kind !== "limit") throw e2;
      }
    }
    throw e;
  }
}

export function classifyHttpError(
  status: number,
  body: string,
  label: string
): AiProviderError {
  if (isOutOfTokens(status, body)) {
    return new AiProviderError(OUT_OF_TOKENS_MSG, OUT_OF_TOKENS_CODE, true);
  }
  if (status === 401 || status === 403) {
    return new AiProviderError(`Invalid API key for ${label}`, "AUTH", true);
  }
  if (status === 429) {
    return new AiProviderError(
      "AI is rate limited — try again in a minute",
      "RATE_LIMIT",
      true
    );
  }
  return new AiProviderError(
    `${label} API ${status}: ${body.slice(0, 200)}`,
    "FAILED",
    true
  );
}

export function wrapFetchError(e: unknown, cancelSignal?: AbortSignal): never {
  if (e instanceof AiProviderError) throw e;
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
    if (cancelSignal?.aborted) {
      throw new AiProviderError(
        "Cadence matching was stopped",
        "ABORTED",
        false
      );
    }
    throw new AiProviderError(
      "The AI took too long to answer — try again",
      "TIMEOUT",
      true
    );
  }
  throw e;
}

export function requestSignal(cancelSignal?: AbortSignal): AbortSignal {
  return cancelSignal
    ? AbortSignal.any([cancelSignal, AbortSignal.timeout(CHUNK_TIMEOUT_MS)])
    : AbortSignal.timeout(CHUNK_TIMEOUT_MS);
}

export async function readBody(resp: Response): Promise<string> {
  return resp.text().catch(() => "");
}

async function completeAnthropic(
  system: string,
  user: string,
  cancelSignal?: AbortSignal,
  opts: ProviderOpts = {}
): Promise<string> {
  const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(
    /\/$/,
    ""
  );
  const params = anthropicParams(opts.effort, opts.model);
  let resp: Response;
  try {
    resp = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": opts.apiKey ?? "",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...params,
        max_tokens: 16000,
        system,
        messages: [{ role: "user", content: user }],
      }),
      signal: requestSignal(cancelSignal),
    });
  } catch (e: unknown) {
    wrapFetchError(e, cancelSignal);
  }
  const body = await readBody(resp);
  if (!resp.ok) throw classifyHttpError(resp.status, body, "Anthropic");
  return contentFromAnthropic(body, (u) => reportApi(opts.mac?.label, apiUsage(u, params.model), opts.onUsage, opts.bill));
}

export function contentFromAnthropic(body: string, onUsage?: (u: AnthropicUsage) => void): string {
  let data: {
    content?: { type?: string; text?: string }[];
    error?: { message?: string };
    usage?: AnthropicUsage;
  };
  try {
    data = JSON.parse(body) as typeof data;
  } catch {
    throw new AiProviderError("Anthropic API: malformed JSON", "FAILED", true);
  }
  if (data.usage) onUsage?.(data.usage); // billed even when the answer is unusable
  if (data.error) {
    throw classifyHttpError(400, data.error.message || "unknown error", "Anthropic");
  }
  const text = (data.content ?? [])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text as string)
    .join("\n")
    .trim();
  if (!text) throw new AiProviderError("The model returned an empty answer", "FAILED", true);
  return text;
}

/** A local model's failure, in words that name its address: never Anthropic's key or credit messages, and never retried. */
const localFailed = (local: LocalModel, why: string) => new AiProviderError(`The local model at ${local.url} ${why}`, "FAILED", false);

/**
 * One request at a time per address: a model on one video card answers one at a time, and a request waiting in the
 * model server's own line would spend its time limit there.
 * ponytail: one at a time for every address; a number in the Local model box if someone's server answers several at once
 */
const localLine = new Map<string, Promise<unknown>>();

/**
 * One answer from the person's own model server: the Messages request completeAnthropic sends, to their address, with
 * their model's name. No x-api-key (that is their Anthropic key) and no output_config (Anthropic's own knob). The
 * answer's tokens are passed on at no price, whatever the model is called, and are not in the paid (API) tally.
 *
 * It asks for the answer without thinking first, as the Anthropic request asks for the least. Measured on a 16 GB
 * video card with the caption eval: three models left to think filled the server's default context before they wrote
 * a line; told not to, two of them answered every run (the third thinks whatever it is told, and needs more context).
 */
function completeLocalModel(system: string, user: string, cancelSignal?: AbortSignal, opts: ProviderOpts = {}): Promise<string> {
  const local = opts.localModel;
  if (!local) return Promise.reject(new AiProviderError("No local model is set", "FAILED", false));
  const answer = (localLine.get(local.url) ?? Promise.resolve()).then(async () => {
    let resp: Response;
    try {
      resp = await fetch(`${local.url}/v1/messages`, {
        method: "POST",
        headers: { "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({ model: local.model, max_tokens: 16000, thinking: { type: "disabled" }, system, messages: [{ role: "user", content: user }] }),
        signal: requestSignal(cancelSignal),
      });
    } catch (e: unknown) {
      if (cancelSignal?.aborted) wrapFetchError(e, cancelSignal);
      const slow = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw localFailed(local, slow ? `gave no answer in ${CHUNK_TIMEOUT_MS / 60_000} minutes` : "did not answer: check that it is running");
    }
    const body = await readBody(resp);
    let data: { content?: { type?: string; text?: string }[]; error?: { message?: string }; usage?: AnthropicUsage; stop_reason?: string } = {};
    try {
      data = JSON.parse(body) as typeof data;
    } catch {
      if (resp.ok) throw localFailed(local, "sent an answer this app can't read");
    }
    if (!resp.ok || data.error) throw localFailed(local, `answered ${resp.status}: ${data.error?.message || body.slice(0, 200)}`);
    if (data.usage) opts.onUsage?.(apiUsage(data.usage, ""));
    // what the server read: the tokens it read now plus those it reused from a request before (a repeat reads almost none anew)
    const read = (data.usage?.input_tokens ?? 0) + (data.usage?.cache_read_input_tokens ?? 0) + (data.usage?.cache_creation_input_tokens ?? 0);
    // a prompt longer than the server's context is cut without a word, and the answer looks like any other: the count
    // is the one sign. A server that gives no count can't be checked.
    if (read > 0 && read < fewestTokens(`${system} ${user}`))
      throw localFailed(local, `read only part of the request (${read} tokens for a request of ${system.length + user.length} characters): give it a longer context on its server`);
    // cut off: a model that thinks first can fill a short context before it writes a word, and half an answer is none
    if (data.stop_reason === "max_tokens")
      throw localFailed(local, `ran out of room before it finished (${read || "?"} tokens in, ${data.usage?.output_tokens ?? "?"} out): give it a longer context on its server`);
    const text = (data.content ?? []).filter((b) => b.type === "text" && b.text).map((b) => b.text as string).join("\n").trim();
    if (!text) throw localFailed(local, "returned an empty answer");
    return text;
  });
  localLine.set(local.url, answer.catch(() => {}));
  return answer;
}

/**
 * One answer from the caller's provider (`aiFor`). An API-key answer may be retried; a provider on the Mac
 * that had the request (a stop, a timeout, a failure) never hands it to anything else.
 */
export async function completeWithFallback<T>(
  system: string,
  user: string,
  cancelSignal: AbortSignal | undefined,
  parse: (text: string) => T,
  opts: ProviderOpts = {},
): Promise<T> {
  opts = routed(opts);
  const available = providers();
  const chain = providerChain(
    available.map((p) => p.id),
    opts,
  ).map((id) => available.find((p) => p.id === id)!);
  if (!chain.length) {
    throw new AiProviderError(opts.off ?? "AI is not configured", "FAILED", false);
  }

  const failures: AiProviderError[] = [];
  const attempts = tries(opts);
  for (const provider of chain) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (cancelSignal?.aborted) {
        throw new AiProviderError(
          "Cadence matching was stopped",
          "ABORTED",
          false
        );
      }
      try {
        const text = await provider.complete(system, user, cancelSignal, opts);
        return parseAnswer(provider.id, text, parse);
      } catch (e) {
        if (e instanceof MacClaudeError && !MAC_MISS.has(e.kind)) throw e; // Claude on the Mac had it: a Stop, timeout or failure never reaches the API key
        if (e instanceof AiProviderError && !e.retryable) throw e;
        const err =
          e instanceof AiProviderError
            ? e
            : new AiProviderError(
                e instanceof Error ? e.message : "AI caption pass failed",
                "FAILED",
                true,
                e
              );
        console.warn(`[ai] ${provider.label} failed (${err.code}): ${err.message}`);
        if (attempt + 1 < attempts) continue;
        failures.push(err);
      }
    }
  }

  if (failures.length && failures.every((f) => f.code === OUT_OF_TOKENS_CODE)) {
    throw new AiProviderError(OUT_OF_TOKENS_MSG, OUT_OF_TOKENS_CODE, false);
  }
  throw failures.at(-1) ?? new AiProviderError("AI caption pass failed", "FAILED", false);
}

/* ---- streaming: the same chain, the answer arriving as it is written ---- */

/** A streamed answer may take longer than one blocking call; what must not happen is silence. */
const STREAM_TIMEOUT_MS = 600_000;
const STREAM_IDLE_MS = 90_000;

export interface StreamHooks {
  /** A provider is about to answer (again, after a fallback: partial text from the previous one is void). */
  onStart?: (provider: { id: ProviderId; label: string }) => void | Promise<void>;
  /** The whole text so far. Awaited, so a slow consumer slows the read, never loses a chunk. */
  onDelta?: (text: string) => void | Promise<void>;
  /** Measured tokens and API-equivalent cost of an answer (Claude on the Mac reports them). */
  onUsage?: (usage: MacUsage) => void;
}

/** Splits an SSE byte stream into data payloads. Pure, so it can be tested. */
export class SseReader {
  private buf = "";
  /** Feed a chunk; get every complete `data:` payload it completed. */
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let at: number;
    while ((at = this.buf.indexOf("\n\n")) >= 0) {
      const event = this.buf.slice(0, at);
      this.buf = this.buf.slice(at + 2);
      const data = event
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) out.push(data);
    }
    return out;
  }
}

async function readSse(
  resp: Response,
  ctrl: AbortController,
  onData: (payload: string) => Promise<boolean | void> | boolean | void,
): Promise<void> {
  if (!resp.body) throw new AiProviderError("The AI returned no stream", "FAILED", true);
  const reader = new SseReader();
  const decoder = new TextDecoder();
  let idle = setTimeout(() => ctrl.abort(), STREAM_IDLE_MS);
  try {
    for await (const chunk of resp.body as AsyncIterable<Uint8Array>) {
      clearTimeout(idle);
      idle = setTimeout(() => ctrl.abort(), STREAM_IDLE_MS);
      for (const payload of reader.push(decoder.decode(chunk, { stream: true }))) {
        if ((await onData(payload)) === false) return;
      }
    }
  } finally {
    clearTimeout(idle);
  }
}

function streamSignal(cancelSignal: AbortSignal | undefined, ctrl: AbortController): AbortSignal {
  const parts = [ctrl.signal, AbortSignal.timeout(STREAM_TIMEOUT_MS)];
  if (cancelSignal) parts.push(cancelSignal);
  return AbortSignal.any(parts);
}

/**
 * Anthropic's SSE: content_block_delta events carry delta.text; an error event ends it.
 * message_start carries the input usage and message_delta the output; what the stream
 * said so far is billed even when it is cut, so it is reported in finally.
 */
async function streamAnthropic(system: string, user: string, cancelSignal: AbortSignal | undefined, onDelta: (t: string) => Promise<void> | void, onUsage?: (u: MacUsage) => void, opts: ProviderOpts = {}): Promise<string> {
  const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
  const params = anthropicParams(opts.effort, opts.model);
  const content = opts.images?.length
    ? [...opts.images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.type, data: im.data } })), { type: "text", text: user }]
    : user;
  const ctrl = new AbortController();
  let resp: Response;
  try {
    resp = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": opts.apiKey ?? "", "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ ...params, max_tokens: 32000, system, messages: [{ role: "user", content }], stream: true }),
      signal: streamSignal(cancelSignal, ctrl),
    });
  } catch (e: unknown) {
    wrapFetchError(e, cancelSignal);
  }
  if (!resp.ok) throw classifyHttpError(resp.status, await readBody(resp), "Anthropic");
  let text = "";
  const usage: AnthropicUsage = {};
  try {
    await readSse(resp, ctrl, async (payload) => {
      let data: { type?: string; message?: { usage?: AnthropicUsage }; usage?: AnthropicUsage; delta?: { type?: string; text?: string }; error?: { message?: string } };
      try {
        data = JSON.parse(payload) as typeof data;
      } catch {
        return;
      }
      if (data.type === "message_start") Object.assign(usage, data.message?.usage);
      if (data.type === "message_delta") Object.assign(usage, data.usage);
      if (data.type === "error" || data.error) throw classifyHttpError(400, data.error?.message || "unknown error", "Anthropic");
      if (data.type === "message_stop") return false;
      if (data.type === "content_block_delta" && data.delta?.type === "text_delta" && data.delta.text) {
        text += data.delta.text;
        await onDelta(text);
      }
    });
  } catch (e: unknown) {
    wrapFetchError(e, cancelSignal);
  } finally {
    if (Object.keys(usage).length) reportApi(opts.mac?.label, apiUsage(usage, params.model), onUsage, opts.bill);
  }
  if (!text.trim()) throw new AiProviderError("The model returned an empty answer", "FAILED", true);
  return text;
}

/** A Mac answer that does not parse is Claude's failure, not a miss: the API key must not run the same request again. */
function parseAnswer<T>(id: ProviderId, text: string, parse: (text: string) => T): T {
  if (id !== "mac") return parse(text);
  try {
    return parse(text);
  } catch (e) {
    throw new MacClaudeError(e instanceof Error ? e.message : "The answer did not parse", "failed");
  }
}

/** Each provider's streamer: the same arguments; opts carries the Mac's label and the API's effort. */
const STREAMERS: Record<ProviderId, (system: string, user: string, cancel: AbortSignal | undefined, onDelta: (t: string) => Promise<void> | void, onUsage: ((u: MacUsage) => void) | undefined, opts: ProviderOpts) => Promise<string>> = {
  anthropic: streamAnthropic,
  mac: streamMac,
  // Claude Code here answers in one piece (`claude -p --output-format json`): the whole text is one delta
  local: async (system, user, cancel, onDelta) => {
    const { text } = await completeLocal(system, user, cancel);
    await onDelta(text);
    return text;
  },
  // a local model's answer arrives in one piece too: no streamed job runs on the direct path (the Workshop never does)
  localModel: async (system, user, cancel, onDelta, onUsage, opts) => {
    const text = await completeLocalModel(system, user, cancel, { ...opts, onUsage });
    await onDelta(text);
    return text;
  },
};

/**
 * Like completeWithFallback, but the text arrives as it is written. A
 * provider that fails or whose answer does not parse hands over to the
 * next one; onStart tells the caller to drop what it had shown so far.
 */
export async function streamWithFallback<T>(
  system: string,
  user: string,
  cancelSignal: AbortSignal | undefined,
  parse: (text: string) => T,
  hooks: StreamHooks = {},
  opts: ProviderOpts = {},
): Promise<{ result: T; provider: string }> {
  opts = routed(opts);
  const available = providers();
  const chain = providerChain(
    available.map((p) => p.id),
    opts,
  ).map((id) => available.find((p) => p.id === id)!);
  if (!chain.length) throw new AiProviderError(opts.off ?? "AI is not configured", "FAILED", false);
  const failures: AiProviderError[] = [];
  const attempts = tries(opts);
  for (const provider of chain) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (cancelSignal?.aborted) throw new AiProviderError("Stopped", "ABORTED", false);
      try {
        const label = provider.id === "mac" ? macLabelOf(opts) : provider.label;
        await hooks.onStart?.({ id: provider.id, label });
        const text = await STREAMERS[provider.id](system, user, cancelSignal, async (t) => {
          await hooks.onDelta?.(t);
        }, hooks.onUsage, opts);
        return { result: parseAnswer(provider.id, text, parse), provider: label };
      } catch (e) {
        if (e instanceof MacClaudeError && !MAC_MISS.has(e.kind)) throw e; // Claude on the Mac had it: a Stop, timeout or failure never reaches the API key
        if (e instanceof AiProviderError && !e.retryable) throw e;
        const err = e instanceof AiProviderError ? e : new AiProviderError(e instanceof Error ? e.message : "AI failed", "FAILED", true, e);
        console.warn(`[ai] ${provider.label} stream failed (${err.code}): ${err.message}`);
        if (attempt + 1 < attempts) continue;
        failures.push(err);
      }
    }
  }
  if (failures.length && failures.every((f) => f.code === OUT_OF_TOKENS_CODE)) throw new AiProviderError(OUT_OF_TOKENS_MSG, OUT_OF_TOKENS_CODE, false);
  throw failures.at(-1) ?? new AiProviderError("AI failed", "FAILED", false);
}
