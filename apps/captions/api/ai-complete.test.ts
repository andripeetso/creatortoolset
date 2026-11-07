import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "ai-complete-")); // the usage tally lands here, not in ~/.caption-studio
const {
  AiProviderError,
  apiUsage,
  completeWithFallback,
  isOutOfTokens,
  OUT_OF_TOKENS_CODE,
  OUT_OF_TOKENS_MSG,
  aiFor,
  streamWithFallback,
} = await import("./ai-complete");
const { saveSettings } = await import("./lib/providers");
const { MacClaudeError, macUsageSince, relayRoutes } = await import("./lib/mac-claude");
const { pairDevice } = await import("./lib/devices");
const { createUser } = await import("./users");
createUser("alex", "password1", { role: "admin" }); // the workspace's providers run on an admin's Mac
const mac = pairDevice("alex", "Alex's Mac").device;
const macClaudeApp = relayRoutes(() => mac.id);
const onMac = { instance: "claude_work", driver: "claude" as const, model: "claude-opus-5-5", effort: "xhigh" as const, device: mac.id, scope: "workspace" as const };

function jsonResp(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  };
}

function openaiContent(text: string) {
  return { choices: [{ message: { content: text } }] };
}

function anthropicContent(text: string) {
  return { content: [{ type: "text", text }] };
}

const quotaBody = {
  error: {
    code: "insufficient_quota",
    message: "You exceeded your current quota",
  },
};

const anthropicQuotaBody = {
  error: {
    type: "invalid_request_error",
    message: "Your credit balance is too low to access the Anthropic API",
  },
};

describe("isOutOfTokens", () => {
  it("treats OpenAI quota exhaustion as out of tokens", () => {
    expect(isOutOfTokens(429, JSON.stringify(quotaBody))).toBe(true);
  });

  it("treats Anthropic credit exhaustion as out of tokens", () => {
    expect(isOutOfTokens(400, JSON.stringify(anthropicQuotaBody))).toBe(true);
  });

  it("does not treat a plain rate limit as out of tokens", () => {
    expect(
      isOutOfTokens(429, JSON.stringify({ error: { message: "Rate limit reached" } }))
    ).toBe(false);
  });

  it("treats HTTP 402 as out of tokens", () => {
    expect(isOutOfTokens(402, "")).toBe(true);
  });
});

describe("aiFor: who asks, for what job → which provider", () => {
  const hub = { id: "claude_work", driver: "claude" as const, name: "Claude (work)", enabled: true, home: "/Users/me/.claude-work", device: mac.id };
  const codex = { id: "codex", driver: "codex" as const, name: "Codex", enabled: true, device: mac.id };
  beforeEach(async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-key");
    await saveSettings({
      instances: [hub, codex, { id: "off", driver: "claude", name: "Off", enabled: false }],
      default: { instance: "claude_work", model: "claude-opus-5-5", effort: "xhigh" },
      jobs: { captions: { instance: "codex", model: "gpt-5-codex", effort: "high" }, analyzer: { instance: "off", model: "claude-opus-5-5", effort: "low" } },
      api: { guests: false, demo: true, model: "claude-opus-5-5", effort: "low" },
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends an account's job to its provider, the job's own pick or the default, the session's own pick first", () => {
    const admin = { username: "alex", role: "admin" as const };
    expect(aiFor(admin, "workshop", "Workshop")).toMatchObject({
      only: ["mac"],
      mac: { label: "Workshop", provider: { instance: "claude_work", driver: "claude", home: "/Users/me/.claude-work", model: "claude-opus-5-5", effort: "xhigh" } },
    });
    expect(aiFor(admin, "captions", "Caption Studio").mac?.provider).toMatchObject({ instance: "codex", model: "gpt-5-codex", effort: "high" });
    // a provider that is off is skipped: the default answers
    expect(aiFor(admin, "analyzer", "Idea board").mac?.provider?.instance).toBe("claude_work");
    expect(aiFor(admin, "workshop", "Workshop", { instance: "codex", model: "gpt-5", effort: "low" }).mac?.provider).toMatchObject({ instance: "codex", model: "gpt-5" });
    // nobody named: no AI at all, never the server's own providers
    expect(aiFor(undefined, "notes", "Video Notes")).toEqual({ only: [], off: "This AI call names no account" });
  });

  it("a call that names no route never reaches a provider", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(completeWithFallback("sys", "user", undefined, (t) => t, { mac: { label: "Unnamed" } })).rejects.toThrow("This AI call names no account");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("answers guests and the demo on the API key only when switched on, never anyone else", () => {
    expect(aiFor({ username: "guest-0123456789ab", role: "guest" }, "captions", "Caption Studio")).toMatchObject({ only: [], off: "AI is off for guests" });
    expect(aiFor({ username: "demo-0123456789ab", role: "user", demo: "demo" }, "workshop", "Workshop")).toMatchObject({ only: ["anthropic"], model: "claude-opus-5-5", effort: "low" });
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(aiFor({ username: "demo-0123456789ab", role: "user", demo: "demo" }, "workshop", "Workshop").off).toBe("AI is off for the demo");
  });

  it("a call with no provider on says why instead of running anywhere", async () => {
    await expect(completeWithFallback("sys", "user", undefined, (t) => t, { only: [], off: "AI is off for guests" })).rejects.toMatchObject({ message: "AI is off for guests" });
  });

  it("hands the Mac the provider's CLI, identity folder, model and effort", async () => {
    const wait = macClaudeApp.request("/wait", { method: "POST" });
    const answer = completeWithFallback("sys", "user", undefined, (t) => t, aiFor({ username: "alex", role: "admin" }, "workshop", "Workshop"));
    const req = (await (await wait).json()) as Record<string, unknown>;
    expect(req).toMatchObject({ instance: "claude_work", driver: "claude", home: "/Users/me/.claude-work", model: "claude-opus-5-5", effort: "xhigh" });
    await macClaudeApp.request(`/${req.id}/done`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "ok", usage: { input: 10, output: 5, cost_usd: 0.01 } }) });
    expect(await answer).toBe("ok");
    await vi.waitFor(async () => {
      const tally = Object.values(await macUsageSince(Date.now() - 60_000)).map((h) => h.Workshop).find(Boolean);
      expect(tally?.by?.["workspace:claude_work"]).toMatchObject({ calls: 1, tokens: 15 });
    });
  });

  it("a usage limit moves the call to the next provider that is on (and only a limit does)", async () => {
    const opts = aiFor({ username: "alex", role: "admin" }, "workshop", "Workshop");
    const wait = macClaudeApp.request("/wait", { method: "POST" });
    const answer = completeWithFallback("sys", "user", undefined, (t) => t, opts).catch((e: unknown) => e);
    const first = (await (await wait).json()) as { id: string };
    const wait2 = macClaudeApp.request("/wait", { method: "POST" });
    await macClaudeApp.request(`/${first.id}/fail`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "You've hit your limit", limit: true }) });
    const second = (await (await wait2).json()) as Record<string, unknown>;
    expect(second).toMatchObject({ instance: "codex", driver: "codex" });
    await macClaudeApp.request(`/${second.id}/done`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "from codex" }) });
    expect(await answer).toBe("from codex");
  });
});

describe("apiUsage", () => {
  it("counts tokens as the Mac does and prices them per million, or $0 for an unlisted model", () => {
    const u = apiUsage({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100 }, "claude-opus-5-5");
    expect(u.tokens).toBe(6300);
    expect(u.costUsd).toBeCloseTo(0.0095, 9);
    expect(apiUsage({ input_tokens: 5 }, "claude-unlisted")).toEqual({ tokens: 5, costUsd: 0 });
  });
});

describe("Anthropic usage, effort and Stop", () => {
  const parse = (text: string) => JSON.parse(text) as { breaks: number[] };
  const sse = (events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-key");
    vi.stubEnv("ANTHROPIC_BASE_URL", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reads a JSON answer's usage, tallies it as (API), and sends the effort asked for", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      jsonResp(200, {
        ...anthropicContent('{"breaks":[0]}'),
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100 },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const onUsage = vi.fn();
    await completeWithFallback("sys", "user", undefined, parse, { only: ["anthropic"], onUsage, mac: { label: "Test" }, effort: "high" });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ output_config: { effort: "high" } });
    expect(onUsage.mock.calls[0][0].tokens).toBe(6300);
    expect(onUsage.mock.calls[0][0].costUsd).toBeCloseTo(0.0095, 9);
    await vi.waitFor(async () =>
      expect(Object.values(await macUsageSince(Date.now() - 60_000)).flatMap((h) => Object.keys(h))).toContain("Test (API)")
    );
  });

  it("reads a stream's usage from message_start and message_delta", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          sse([
            { type: "message_start", message: { usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100 } } },
            { type: "content_block_delta", delta: { type: "text_delta", text: '{"breaks":' } },
            { type: "content_block_delta", delta: { type: "text_delta", text: "[0]}" } },
            { type: "message_delta", usage: { output_tokens: 300 } },
            { type: "message_stop" },
          ]),
          { status: 200 }
        )
      )
    );
    const onUsage = vi.fn();
    const out = await streamWithFallback("sys", "user", undefined, parse, { onUsage }, { only: ["anthropic"] });
    expect(out.result).toEqual({ breaks: [0] });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0][0].tokens).toBe(6400);
    expect(onUsage.mock.calls[0][0].costUsd).toBeCloseTo(0.0115, 9);
  });

  it("reports what a stream had used when it is cut", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          sse([
            { type: "message_start", message: { usage: { input_tokens: 1000, output_tokens: 1 } } },
            { type: "content_block_delta", delta: { type: "text_delta", text: '{"br' } },
            { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
          ]),
          { status: 200 }
        )
      )
    );
    const onUsage = vi.fn();
    await expect(streamWithFallback("sys", "user", undefined, parse, { onUsage }, { only: ["anthropic"] })).rejects.toBeInstanceOf(AiProviderError);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0][0].tokens).toBe(1001);
  });

  it("a Stop on the Mac rejects as stopped and never reaches the API key", async () => {
    const fetchMock = vi.fn(() => jsonResp(200, anthropicContent('{"breaks":[0]}')));
    vi.stubGlobal("fetch", fetchMock);
    const wait = macClaudeApp.request("/wait", { method: "POST" }); // the Mac is polling
    await new Promise((r) => setTimeout(r, 5));
    const stop = new AbortController();
    const answer = completeWithFallback("sys", "user", stop.signal, parse, { only: ["mac", "anthropic"], mac: { provider: onMac } }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 5));
    stop.abort();
    expect(await answer).toBeInstanceOf(MacClaudeError);
    expect(await answer).toMatchObject({ kind: "stopped", message: "Stopped" });
    expect(fetchMock).not.toHaveBeenCalled();
    await wait;
  });

  it("a Mac failure, or an answer that does not parse, never reaches the API key", async () => {
    const fetchMock = vi.fn(() => jsonResp(200, anthropicContent('{"breaks":[0]}')));
    vi.stubGlobal("fetch", fetchMock);
    const wait = macClaudeApp.request("/wait", { method: "POST" });
    const answer = completeWithFallback("sys", "user", undefined, parse, { only: ["mac", "anthropic"], mac: { provider: onMac } }).catch((e: unknown) => e);
    const { id } = (await (await wait).json()) as { id: string };
    await macClaudeApp.request(`/${id}/fail`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Claude broke" }) });
    expect(await answer).toMatchObject({ kind: "failed" });

    const wait2 = macClaudeApp.request("/wait", { method: "POST" });
    const answer2 = completeWithFallback("sys", "user", undefined, () => { throw new Error("neither a reply nor edits"); }, { only: ["mac", "anthropic"], mac: { provider: onMac } }).catch((e: unknown) => e);
    const { id: id2 } = (await (await wait2).json()) as { id: string };
    await macClaudeApp.request(`/${id2}/done`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Sure, here is a note." }) });
    expect(await answer2).toMatchObject({ kind: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
