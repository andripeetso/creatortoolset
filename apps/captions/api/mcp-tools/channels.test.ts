import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "channels-tools-"));
process.env.APP_SECRET = "channels-tools-secret";

const { createUser, newApiKey } = await import("../users");
const app = (await import("../boot")).default;
const { saveAccounts } = await import("../lib/connectors/store");

const ana = createUser("ana", "password1");
const key = `Bearer ${newApiKey(ana, "full")}`;
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await app.request("/api/mcp", {
    method: "POST",
    headers: { authorization: key, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return JSON.parse(((await r.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text);
};

describe("channel_posts", () => {
  it("reads a login over an hour old before it answers, never a handle unasked", async () => {
    expect((await tool("channel_posts")).accounts).toEqual([]);
    const twoHoursAgo = Date.now() - 2 * 60 * 60_000;
    saveAccounts("ana", [
      // a stale login whose token ran out: reading it marks it, with no call to the platform
      { platform: "tiktok", platformId: "t1", handle: "tinyacrobatics", via: "login", token: "tok", expiresAt: 1, pulledAt: twoHoursAgo },
      { platform: "youtube", platformId: "y1", handle: "tinyacrobatics", via: "login", token: "tok", pulledAt: Date.now(), stats: { followers: 12 }, posts: [{ id: "v1", at: 1, text: "Hi", views: 5 }] },
      { platform: "x", platformId: "tiny", handle: "tiny", via: "apify", pulledAt: twoHoursAgo },
    ]);
    const got = (await tool("channel_posts")) as { accounts: Array<{ platform: string; status: string; pullError?: string; read?: string; stats: Record<string, number>; posts: unknown[] }> };
    const by = Object.fromEntries(got.accounts.map((x) => [x.platform, x]));
    expect(by.tiktok).toMatchObject({ status: "needs_reconnect", pullError: expect.stringContaining("expired") });
    expect(by.youtube).toMatchObject({ status: "connected", stats: { followers: 12 }, posts: [{ views: 5, text: "Hi" }] });
    expect(by.x!.read).toBe(new Date(twoHoursAgo).toISOString().slice(0, 16).replace("T", " "));
    expect((await tool("channel_posts", { platform: "YouTube" })).accounts).toHaveLength(1);
  });
});
