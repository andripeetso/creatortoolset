import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";

vi.mock("./users", async (importOriginal) => ({ ...(await importOriginal<typeof import("./users")>()), bumpUsage: vi.fn() }));
vi.mock("./ai-complete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai-complete")>()),
  anyAiConfigured: () => true,
  completeWithFallback: vi.fn(async (_system, _prompt, _signal, parse) =>
    parse('{"edits":[{"from":2,"to":2,"text":"prone"},{"from":0,"to":0,"text":"At"}]}'),
  ),
}));

import { aiApp } from "./ai";
import { completeWithFallback } from "./ai-complete";
import { bumpUsage } from "./users";

let user: AuthVars["user"] = { username: "test", role: "admin", cloud: true, off: [] };
const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", user);
  await next();
});
app.route("/", aiApp);

const SCRIPT = "At Tiny Acrobatics we start with tummy time in the prone position.";

const request = (body: unknown) =>
  app.request("/script-check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const words = [
  { text: "in", confidence: 0.99 },
  { text: "the", confidence: 0.98 },
  { text: "prawn", confidence: 0.42 },
  { text: "position.", confidence: 0.97 },
];

beforeEach(() => {
  vi.clearAllMocks();
  user = { username: "test", role: "admin", cloud: true, off: [] };
});

describe("POST /script-check", () => {
  it("answers only the edits that pass the vetting", async () => {
    const response = await request({ script: SCRIPT, words });
    expect(response.status).toBe(200);
    // "in" → "At" isn't a mis-hearing: dropped
    expect(await response.json()).toEqual({ edits: [{ from: 2, to: 2, text: "prone" }] });
    const [, prompt] = vi.mocked(completeWithFallback).mock.calls[0];
    expect(prompt).toContain(SCRIPT);
    expect(prompt).toContain("2|prawn|0.42");
    expect(bumpUsage).toHaveBeenCalledWith("test", { aiRuns: 1 });
  });

  it("needs a script and words", async () => {
    expect((await request({ script: "  ", words })).status).toBe(400);
    expect((await request({ script: SCRIPT, words: [] })).status).toBe(400);
    expect((await request({ script: SCRIPT, words: [{ text: 1 }] })).status).toBe(400);
    expect((await request({ script: "x".repeat(40_001), words })).status).toBe(400);
    expect(completeWithFallback).not.toHaveBeenCalled();
  });

  it("is locked like the cadence pass", async () => {
    user = { username: "viewer", role: "user", cloud: false, off: [] };
    const response = await request({ script: SCRIPT, words });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "CLOUD_LOCKED" });
  });
});
