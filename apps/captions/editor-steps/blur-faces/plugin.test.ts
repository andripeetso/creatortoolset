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
  const start = { ...DEFAULTS, softness: 0.45 };
  it("start from the defaults, keep each account's own, and refuse what isn't one", async () => {
    expect(await (await call("GET", "/settings")).json()).toEqual(start);
    const mine = { mode: "some", who: "Everyone but me", look: "mosaic", strength: 0.8, softness: 0.2, size: 1.4, color: "#112233", auto: false };
    expect((await call("PUT", "/settings", mine)).status).toBe(200);
    expect(await (await call("GET", "/settings")).json()).toEqual(mine);
    expect(await (await as("ada")("GET", "/settings")).json()).toEqual(start);
    const bad = [
      { mode: "most" }, { look: "emoji" }, { who: "x".repeat(LIMITS.who + 1) }, { who: 3 }, { auto: "yes" }, { strength: 1.5 },
      { softness: -0.1 }, { size: 0.7 }, { size: 2.5 }, { size: "1" }, { color: "red" }, { color: "#12345" }, null, [],
    ];
    for (const b of bad) expect((await call("PUT", "/settings", b)).status).toBe(400);
    expect(await (await call("GET", "/settings")).json()).toEqual(mine);
  });

  it("change only what a save sends, so an app from before the style keeps it", async () => {
    const u = as("grace");
    await u("PUT", "/settings", { look: "solid", size: 1.2, color: "#ABCDEF", auto: true });
    // an older phone app sends only these three
    const r = await u("PUT", "/settings", { mode: "some", who: "The people in the background", look: "solid" });
    expect(await r.json()).toEqual({ ...start, mode: "some", who: "The people in the background", look: "solid", size: 1.2, color: "#abcdef", auto: true });
  });

  it("read settings saved before the style as today's look: Solid stays hard-edged", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir = path.join(process.env.DATA_DIR!, "plugins", "blur-faces");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "linus.json"), JSON.stringify({ mode: "all", who: "x", look: "solid", auto: false }));
    expect(await (await as("linus")("GET", "/settings")).json()).toEqual({ ...DEFAULTS, who: "x", look: "solid", softness: 0 });
  });

  it("give the example picture", async () => {
    const { picture } = (await (await call("GET", "/example")).json()) as { picture: string };
    expect(Buffer.from(picture, "base64").subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
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
