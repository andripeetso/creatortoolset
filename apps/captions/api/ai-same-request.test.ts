import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "ai-same-request-"));
process.env.APP_SECRET = "test-secret-123"; // accounts on; boots the "admin" account
const { aiFor, completeWithFallback, streamWithFallback } = await import("./ai-complete");
const { saveMyKey } = await import("./my-keys");
const { createUser } = await import("./users");
createUser("lee", "password1");

/**
 * The request an account's own Anthropic key sends, written out in full: the address, every header and the body,
 * character for character. A change to the direct path that is meant for something else (a local model, another
 * provider) must leave this file passing untouched.
 */
describe("an account on its own Anthropic key sends this request, and nothing else", () => {
  const key = ["not", "a", "real", "key"].join("-");
  const admin = { username: "admin", role: "admin" as const };
  const headers = { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" };

  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "");
    vi.stubEnv("ANTHROPIC_MODEL", "");
    vi.stubEnv("ANTHROPIC_EFFORT", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    saveMyKey("admin", "ANTHROPIC_API_KEY", key);
  });
  afterEach(() => {
    saveMyKey("admin", "ANTHROPIC_API_KEY", null);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("the route: the key, one retry, the label, and nothing more", () => {
    expect(aiFor(admin, "captions", "Caption Studio")).toEqual({ only: ["anthropic"], retries: 1, apiKey: key, mac: { label: "Caption Studio" } });
    expect(aiFor("admin", "editor", "AI Editor script")).toEqual({ only: ["anthropic"], retries: 1, apiKey: key, mac: { label: "AI Editor script" } });
    expect(aiFor(admin, "workshop", "Workshop")).toEqual({ only: [], off: "Content Workshop runs on your own AI (it reads the whole project folder): connect yours in Settings → Providers" });
  });

  it("an account with no AI and no key gets the same refusal", () => {
    const off = { only: [], off: "No AI for your account: add one in Settings → Providers, or your Anthropic key in Settings → API keys" };
    expect(aiFor({ username: "lee", role: "user" }, "captions", "Caption Studio")).toEqual(off);
    expect(aiFor("lee", "notes", "Video Notes")).toEqual(off);
  });

  it("one answer: address, headers and body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await completeWithFallback("The system text", "The user text", undefined, (t) => t, aiFor(admin, "captions", "Caption Studio"))).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual(headers);
    expect(init?.body).toBe(
      '{"model":"claude-opus-5-5","output_config":{"effort":"low"},"max_tokens":16000,"system":"The system text","messages":[{"role":"user","content":"The user text"}]}',
    );
  });

  it("a streamed answer: address, headers and body", async () => {
    const sse = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
      { type: "message_stop" },
    ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(sse, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await streamWithFallback("The system text", "The user text", undefined, (t) => t, {}, aiFor(admin, "captions", "Caption Studio"));
    expect(out).toEqual({ result: "ok", provider: "Anthropic API" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual(headers);
    expect(init?.body).toBe(
      '{"model":"claude-opus-5-5","output_config":{"effort":"low"},"max_tokens":32000,"system":"The system text","messages":[{"role":"user","content":"The user text"}],"stream":true}',
    );
  });
});
