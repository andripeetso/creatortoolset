import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "ai-vision-"));
const { completeVisionWithFallback } = await import("./ai-vision");
const { relayRoutes } = await import("./lib/mac-claude");
const { pairDevice } = await import("./lib/devices");
const { createUser } = await import("./users");
createUser("alex", "password1", { role: "admin" }); // the workspace's providers run on an admin's Mac
const mac = pairDevice("alex", "Alex's Mac").device;
const macClaudeApp = relayRoutes(() => mac.id);
const { saveSettings } = await import("./lib/providers");

const images = [{ jpegBase64: "AAAA" }, { jpegBase64: "BBBB" }];
const parse = (t: string) => JSON.parse(t) as { onScreenText: string };

describe("completeVisionWithFallback", () => {
  beforeEach(async () => {
    await saveSettings({
      instances: [{ id: "claude_work", driver: "claude", name: "Claude (work)", enabled: true, home: "/Users/me/.claude-work", device: mac.id }],
      default: { instance: "claude_work", model: "claude-opus-5-5", effort: "xhigh" },
      jobs: { analyzer: { instance: "claude_work", model: "claude-sonnet-5-5", effort: "low" } },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends the pictures to the Analyzer's provider as files it reads in order", async () => {
    const wait = macClaudeApp.request("/wait", { method: "POST" });
    const answer = completeVisionWithFallback("sys", "Read the slide.", images, undefined, parse, { username: "alex", role: "admin" });
    const req = (await (await wait).json()) as { id: string; user: string; files: Record<string, string>; model: string; instance: string };
    expect(req.files).toEqual({ "attached/1.jpg": "base64:AAAA", "attached/2.jpg": "base64:BBBB" });
    expect(req.user).toContain("attached/1.jpg, attached/2.jpg");
    expect(req).toMatchObject({ instance: "claude_work", model: "claude-sonnet-5-5" });
    await macClaudeApp.request(`/${req.id}/done`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: '{"onScreenText":"Hi"}' }) });
    expect(await answer).toEqual({ value: { onScreenText: "Hi" }, provider: "claude_work" });
  });

  it("an account with no provider reads the pictures on its own Anthropic key, and gets nothing without one", async () => {
    const { saveMyKey } = await import("./my-keys");
    createUser("sam", "password1");
    await expect(completeVisionWithFallback("sys", "look", images, undefined, parse, "sam")).rejects.toThrow(/Anthropic/);
    saveMyKey("sam", "ANTHROPIC_API_KEY", "sam-key");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ content: [{ type: "text", text: '{"onScreenText":"Yo"}' }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await completeVisionWithFallback("sys", "look", images, undefined, parse, "sam")).toEqual({ value: { onScreenText: "Yo" }, provider: "anthropic" });
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>)["x-api-key"]).toBe("sam-key");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messages[0].content.filter((c: { type: string }) => c.type === "image")).toHaveLength(2);
  });

  it("refuses no pictures", async () => {
    await expect(completeVisionWithFallback("sys", "look", [], undefined, parse, "alex")).rejects.toMatchObject({ message: "No image to analyze" });
  });
});
