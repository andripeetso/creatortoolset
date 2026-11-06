import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";

vi.mock("./users", async (importOriginal) => ({ ...(await importOriginal<typeof import("./users")>()), bumpUsage: vi.fn() }));
vi.mock("./ai-complete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai-complete")>()),
  anyAiConfigured: vi.fn(() => true),
  completeWithFallback: vi.fn(async (_system, _prompt, _signal, parse) =>
    parse('{"lines":["keep moving","forward"]}'),
  ),
}));

import { anyAiConfigured } from "./ai-complete";
import { captionLayoutApp } from "./caption-layout";
import { STYLE_PRESETS } from "../src/lib/types";

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "test", role: "admin", cloud: true, off: [] });
  await next();
});
app.route("/", captionLayoutApp);

const style = STYLE_PRESETS[0].style;
const words = [
  { text: "keep", start: 0, end: 0.2 },
  { text: "moving", start: 0.25, end: 0.6 },
  { text: "forward", start: 0.9, end: 1.5 },
];
const post = (path: string, body: object) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ words, style, width: 1080, height: 1920, ...body }),
  });
interface Out {
  cues: { id: number; start: number; end: number; lines?: number[]; words: { text: string; start: number }[] }[];
  words: { cut?: number }[];
  cadenceApplied: boolean;
  aiError: string | null;
}
const json = async (r: Response) => (await r.json()) as Out;
const text = (cues: Out["cues"]) => cues.map((c) => c.words.map((w) => w.text).join(" "));

beforeEach(() => vi.clearAllMocks());

describe("caption layout for the iPhone app", () => {
  it("lays words out with ids, line counts and no overlaps", async () => {
    const res = await post("/layout", {});
    expect(res.status).toBe(200);
    const { cues } = await json(res);
    expect(text(cues).join(" ")).toBe("keep moving forward");
    expect(cues.every((c) => c.lines?.length)).toBe(true);
    expect(new Set(cues.map((c) => c.id)).size).toBe(cues.length);
    for (let i = 1; i < cues.length; i++) expect(cues[i - 1].end).toBeLessThan(cues[i].start);
  });

  it("keeps each typed line one caption and reuses the old timings", async () => {
    const res = await post("/layout", { lines: [["Keep", "moving"], ["forward!"]] });
    const { cues } = await json(res);
    expect(text(cues)).toEqual(["Keep moving", "forward!"]);
    expect(cues[1].words[0].start).toBe(0.9);
  });

  it("runs Match cadence after transcription and marks every word", async () => {
    const res = await post("/auto", {});
    const body = await json(res);
    expect(body.aiError).toBeNull();
    expect(body.cadenceApplied).toBe(true);
    expect(body.words.map((w) => w.cut)).toEqual([2, 0, 2]);
    expect(text(body.cues).join(" ")).toBe("keep moving forward");
  });

  it("still captions when the AI is off", async () => {
    vi.mocked(anyAiConfigured).mockReturnValueOnce(false);
    const body = await json(await post("/auto", {}));
    expect(body.cadenceApplied).toBe(false);
    expect(text(body.cues).join(" ")).toBe("keep moving forward");
  });

  it("refuses a malformed frame", async () => {
    expect((await post("/layout", { width: 0 })).status).toBe(400);
  });
});
