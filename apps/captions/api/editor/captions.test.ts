import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../users";

// The Editor's Make / Update Captions (api/editor/captions.ts): a cut's render becomes a Caption Studio project heard by
// Caption Studio's own captioning, once; a newer cut becomes a clip beside it with the captions moved, heard only for
// what is new. Caption Studio's captioning itself is captions-job.ts's (its own tests): here only that it is started.
const root = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-captions-"));
process.env.DATA_DIR = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));
const heard = vi.fn();
vi.mock("../captions-job", () => ({ captionEngine: () => ({ engine: "cloud" }), captionInBackground: heard }));
// Caption Studio's exports, as the overlay asks them: what was asked, and how the export stands
const exp = vi.hoisted(() => ({ asked: [] as Record<string, unknown>[], status: "running", error: "" }));
vi.mock("../exports", async (real) => {
  const { Hono } = await import("hono");
  const app = new Hono()
    .post("/", async (c) => (exp.asked.push(await c.req.json()), c.json({ id: "x1", status: "queued" })))
    .get("/x1", (c) => c.json({ id: "x1", status: exp.status, error: exp.error }))
    .get("/x1/file", () => new Response("MOV"));
  return { ...(await real<typeof import("../exports")>()), exportsApp: app };
});
const available = spawnSync("ffmpeg", ["-version"]).status === 0;
const { captionsFromRender, captionsOverlay } = await import("./captions");

const owner: SessionUser = { username: "owner", role: "user", cloud: false, off: [] };
const render = path.join(root, "render.mp4");
const projects = () => readdirSync(path.join(root, "projects")).filter((n) => !n.startsWith("."));
const meta = (id: string) => JSON.parse(readFileSync(path.join(root, "projects", id, "meta.json"), "utf8")) as { owner: string; projectId?: string; clips: { id: string }[] };
const data = (id: string, clip: string) => JSON.parse(readFileSync(path.join(root, "projects", id, "clips", clip, "data.json"), "utf8"));
const CUT: [number, number, string, number][] = [[0, 50, "s1", 0]];
const make = (user = owner, workspace = "w1") => captionsFromRender(user, { file: render, name: "Tiny Acrobatics", workspace, fps: 25, to: CUT });

beforeAll(() => {
  if (!available) return;
  const made = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=25:duration=2", "-f", "lavfi", "-i", "sine=f=440:d=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", render]);
  expect(made.status, made.stderr.toString()).toBe(0);
});
beforeEach(() => heard.mockClear());

describe.skipIf(!available)("Make Captions and Update Captions", () => {
  it("makes a project in the edit's workspace from the render and has Caption Studio transcribe it once", async () => {
    const r = await make();
    expect(r.captioning).toBe(true);
    expect(meta(r.project)).toMatchObject({ owner: "owner", projectId: "w1", clips: [{ id: r.clip }] });
    // the render itself, linked: nothing copied off the server
    expect(readFileSync(path.join(root, "projects", r.project, "clips", r.clip, "original"))).toEqual(readFileSync(render));
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0]!.slice(1, 3)).toEqual([r.project, r.clip]);
  }, 30_000);

  it("refuses an account without Caption Studio, or with it Read only, and makes nothing", async () => {
    const before = projects().length;
    await expect(make({ ...owner, read: ["captions"] } as SessionUser)).rejects.toMatchObject({ status: 403, message: "Caption Studio is read-only for your account" });
    await expect(make({ ...owner, off: ["captions"] })).rejects.toMatchObject({ status: 403 });
    expect(projects()).toHaveLength(before);
    expect(heard).not.toHaveBeenCalled();
  }, 30_000);

  it("moves the captions for a newer cut beside his clip, hearing only new material; never another workspace's or account's", async () => {
    const first = await make();
    const words = [{ id: 1, text: "Tiny", start: 0.2, end: 0.5 }, { id: 2, text: "acrobatss", start: 1.2, end: 1.6 }];
    writeFileSync(path.join(root, "projects", first.project, "clips", first.clip, "data.json"), JSON.stringify({ words, cues: [{ id: 1, start: 0.2, end: 1.6, words }], style: { fontFamily: "Anton" } }));
    heard.mockClear();
    const old = { project: first.project, clip: first.clip, from: CUT };
    // the first second trimmed off: his fixed word moves up, nothing new to hear
    const trimmed = await captionsFromRender(owner, { file: render, name: "Tiny Acrobatics", workspace: "w1", fps: 25, to: [[0, 25, "s1", 25]], old });
    expect(trimmed).toMatchObject({ project: first.project, captioning: false });
    expect(trimmed.clip).not.toBe(first.clip);
    expect(data(first.project, trimmed.clip)).toMatchObject({ words: [{ text: "acrobatss", start: 0.2, end: 0.6 }], style: { fontFamily: "Anton" } });
    expect(data(first.project, trimmed.clip).fill).toBeUndefined();
    expect(heard).not.toHaveBeenCalled();
    // his old clip is as it was
    expect(data(first.project, first.clip).words).toEqual(words);

    // a cut with a second of new material: that second is heard (captions-job.ts adds what it hears there)
    const longer = await captionsFromRender(owner, { file: render, name: "Tiny Acrobatics", workspace: "w1", fps: 25, to: [[0, 50, "s1", 0], [50, 25, "s2", 0]], old });
    expect(longer.captioning).toBe(true);
    expect(data(first.project, longer.clip)).toMatchObject({ fill: [[2, 3]], words: [{ text: "Tiny" }, { text: "acrobatss" }] });
    expect(heard).toHaveBeenCalledTimes(1);

    await expect(captionsFromRender(owner, { file: render, name: "x", workspace: "w2", fps: 25, to: CUT, old })).rejects.toMatchObject({ status: 404 });
    await expect(captionsFromRender({ ...owner, username: "stranger" }, { file: render, name: "x", workspace: "w1", fps: 25, to: CUT, old })).rejects.toMatchObject({ status: 404 });
  }, 60_000);
});

describe("burn-in: Caption Studio draws the captions as an overlay", () => {
  it("starts its overlay export once for a render, waits while it is drawn, then hands over the file", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const clip = "44444444-4444-4444-8444-444444444444";
    const dir = path.join(root, "projects", id);
    mkdirSync(path.join(dir, "clips", clip), { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, name: "Tiny Acrobatics", owner: "owner", createdAt: 1, updatedAt: 1, duration: 2, revision: 1,
      clips: [{ id: clip, name: "cut", duration: 2, createdAt: 1, srcWidth: 180, srcHeight: 320 }] }));
    const words = [{ id: 1, text: "Tiny", start: 0.2, end: 0.5 }];
    writeFileSync(path.join(dir, "clips", clip, "data.json"), JSON.stringify({ words, cues: [{ id: 1, start: 0.2, end: 0.5, words }] }));
    expect(await captionsOverlay(owner, "job1", id, clip, 25)).toEqual({ wait: "Drawing the captions" });
    expect(exp.asked).toHaveLength(1);
    expect(exp.asked[0]).toMatchObject({ kind: "overlay", format: "mov", engine: "wysiwyg", projectId: id, width: 180, height: 320, fps: 25, duration: 2,
      renderSpec: { width: 180, height: 320, cues: [{ words: [{ text: "Tiny" }] }] } });
    exp.status = "done";
    const r = await captionsOverlay(owner, "job1", id, clip, 25);
    expect("file" in r && (await r.file.text())).toBe("MOV");
    expect(exp.asked).toHaveLength(1);
    // another account's project is not drawn
    expect(await captionsOverlay({ ...owner, username: "stranger" }, "job2", id, clip, 25)).toMatchObject({ error: expect.stringContaining("not there") });
  });
});
