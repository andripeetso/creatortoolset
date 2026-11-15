// Face Blur's routes as the server mounts them; only the person's AI is stood in.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "blur-faces-"));

const ai = vi.hoisted(() => ({ configured: true, answer: async (): Promise<string> => '{"blur": []}', asks: [] as { user: string; images: number }[] }));
vi.mock("../../api/ai-vision", () => ({
  anyVisionConfigured: () => ai.configured,
  completeVisionWithFallback: async (_s: string, user: string, images: unknown[], _sig: unknown, parse: (t: string) => unknown) => {
    ai.asks.push({ user, images: images.length });
    return { value: parse(await ai.answer()), provider: "test" };
  },
}));

const { Hono } = await import("hono");
const { default: plugin, DEFAULTS, LIMITS } = await import("./plugin");

const as = (username: string, off: string[] = []) => {
  const app = new Hono<{ Variables: { user: unknown } }>();
  app.use(async (c, next) => {
    c.set("user", { username, role: "user", off });
    await next();
  });
  app.route("/api/x/blur-faces", plugin.routes!);
  return (method: string, url: string, body?: unknown) =>
    app.request(`/api/x/blur-faces${url}`, { method, headers: { "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
};
const call = as("tiny");
const face = (id: string) => ({ id, picture: "/9j/AAAA", note: "middle left of the frame; 12% of its width; seen for 4.2 s" });

beforeEach(() => {
  ai.configured = true;
  ai.asks = [];
});

describe("Face Blur's settings", () => {
  it("start from the defaults, keep each account's own, and refuse what isn't one", async () => {
    expect(await (await call("GET", "/settings")).json()).toEqual(DEFAULTS);
    const mine = { mode: "some", who: "Everyone but me", look: "mosaic", auto: false };
    expect((await call("PUT", "/settings", mine)).status).toBe(200);
    expect(await (await call("GET", "/settings")).json()).toEqual(mine);
    expect(await (await as("ada")("GET", "/settings")).json()).toEqual(DEFAULTS);
    for (const bad of [{ ...mine, mode: "most" }, { ...mine, look: "emoji" }, { ...mine, who: "x".repeat(LIMITS.who + 1) }, { ...mine, who: 3 }, { ...mine, auto: "yes" }, null]) {
      expect((await call("PUT", "/settings", bad)).status).toBe(400);
    }
    expect(await (await call("GET", "/settings")).json()).toEqual(mine);
  });

  it("are behind the plug-in's switch", async () => {
    expect((await as("tiny", ["blur-faces"])("GET", "/settings")).status).toBe(403);
  });
});

describe("choosing faces", () => {
  const pick = (faces: unknown[], who = "Every child's face") => call("POST", "/pick", { who, faces });

  it("answers the ids the AI chose, of those asked about, ten faces per question", async () => {
    ai.answer = async () => 'Here: {"blur": ["T1", "T2", "T99"]}';
    const r = await pick(Array.from({ length: 12 }, (_, i) => face(`T${i + 1}`)));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ blur: ["T1", "T2"] }); // T99 was never asked about
    expect(ai.asks.map((a) => a.images)).toEqual([10, 2]);
    expect(ai.asks[0]!.user).toContain('"Every child\'s face"');
  });

  it("asks nothing when no face was found", async () => {
    expect(await (await pick([])).json()).toEqual({ blur: [] });
    expect(ai.asks).toEqual([]);
  });

  it("stops with a sentence when there is no AI, it fails, or its answer can't be read", async () => {
    ai.configured = false;
    let r = await pick([face("T1")]);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/connect one in Settings → Providers\. Nothing was blurred/);
    ai.configured = true;
    ai.answer = async () => {
      throw new Error("over its limit");
    };
    r = await pick([face("T1")]);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/over its limit.*Nothing was blurred/);
    ai.answer = async () => "I can't tell";
    r = await pick([face("T1")]);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/could not read your AI's answer/);
  });

  it("refuses what isn't a pick, before asking the AI", async () => {
    const big = "A".repeat(Math.ceil(LIMITS.picture / 3) * 4 + 4);
    for (const bad of [
      [face("T1"), face("T1")],
      [{ ...face("T1"), id: "../x" }],
      [{ ...face("T1"), picture: "not base64!" }],
      [{ ...face("T1"), picture: big }],
      [{ ...face("T1"), note: "x".repeat(LIMITS.note + 1) }],
      Array.from({ length: LIMITS.faces + 1 }, (_, i) => face(`T${i}`)),
    ]) {
      expect((await pick(bad)).status).toBe(400);
    }
    expect((await pick([face("T1")], "  ")).status).toBe(400);
    expect(ai.asks).toEqual([]);
  });
});
