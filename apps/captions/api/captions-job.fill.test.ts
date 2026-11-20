import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";

// An Editor update (api/editor/captions.ts) leaves his moved captions on the new clip with `fill`, the new material's
// seconds: when the sound is heard, only the words in `fill` are laid out and added; his lines and word fixes stay.
const root = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "captions-fill-"));
process.env.DATA_DIR = root;
delete process.env.APP_SECRET;
afterAll(() => rmSync(root, { recursive: true, force: true }));
vi.mock("./assistant", () => ({ checkWork: () => {}, workEnded: () => true }));
// the cloud's words for the whole new cut: one in his old material (heard again, not taken) and two in the new second
vi.mock("./transcribe", async (real) => ({
  ...(await real<typeof import("./transcribe")>()),
  transcribeApp: new Hono().post("/", (c) => c.json({ words: [
    { text: "Tiny", start: 0.2, end: 0.5 }, { text: "flip", start: 2.2, end: 2.5 }, { text: "today", start: 2.6, end: 2.9 },
  ] })),
}));
const { captionsHeard } = await import("./captions-job");

const project = "11111111-1111-4111-8111-111111111111";
const clip = "22222222-2222-4222-8222-222222222222";
const his = [{ id: 1, text: "Tinyy", start: 0.2, end: 0.5 }, { id: 2, text: "acrobats", start: 0.6, end: 1 }];

describe("captions heard for an Editor update", () => {
  it("adds only the new material's words, after his, and keeps his lines", async () => {
    const dir = path.join(root, "projects", project);
    mkdirSync(path.join(dir, "clips", clip), { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id: project, name: "Tiny Acrobatics", owner: "local", createdAt: 1, updatedAt: 1, duration: 3, revision: 2,
      clips: [{ id: clip, name: "cut", duration: 3, createdAt: 1, srcWidth: 1080, srcHeight: 1920 }] }));
    writeFileSync(path.join(dir, "data.json"), JSON.stringify({ autoCadence: false }));
    writeFileSync(path.join(dir, "clips", clip, "data.json"), JSON.stringify({ words: his, cues: [{ id: 1, start: 0.2, end: 1, words: his, lines: [2] }], style: { fontFamily: "Anton" }, fill: [[2, 3]] }));
    const wav = path.join(root, "audio.wav");
    writeFileSync(wav, "RIFF");
    await captionsHeard("local", { project, clip, cloud: true, seconds: 3, name: "Tiny Acrobatics" }, { peaks: [], seconds: 3 }, { "audio.wav": wav });
    const d = JSON.parse(readFileSync(path.join(dir, "clips", clip, "data.json"), "utf8")) as { words: { id: number; text: string }[]; cues: { words: { id: number }[]; lines?: number[] }[]; fill?: unknown; style: unknown };
    expect(d.words.map((w) => [w.id, w.text])).toEqual([[1, "Tinyy"], [2, "acrobats"], [3, "flip"], [4, "today"]]);
    expect(d.cues[0]).toMatchObject({ lines: [2], words: [{ id: 1 }, { id: 2 }] });
    expect(d.cues.slice(1).flatMap((c) => c.words.map((w) => w.id))).toEqual([3, 4]);
    expect(d.style).toMatchObject({ fontFamily: "Anton" });
    expect(d.fill).toBeUndefined();
  });
});
