import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "./auth";
import { DEFAULT_EDIT } from "../contracts/clean-edit";
import type { QuickScore } from "../contracts/clean-fingerprints";
import { probe } from "./lib/clean-media";
const root = mkdtempSync(path.join(tmpdir(), "clean-timeline-"));
process.env.DATA_DIR = root;
const available = spawnSync("ffmpeg", ["-version"]).status === 0;
const native = existsSync("runtime/fingerprints/pdq-photo-hasher");
const { cleanWorkspaceApp } = await import("./clean-workspace");
let username = "owner";
const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username, role: "user", cloud: false, off: [] });
  await next();
});
app.route("/", cleanWorkspaceApp);
const fixture = path.join(root, "source.mp4");
const projectId = randomUUID(),
  clipId = randomUUID();
const projectDir = path.join(root, "projects", projectId),
  clipDir = path.join(projectDir, "clips", clipId),
  original = path.join(clipDir, "original");
const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const post = (id: string, action: string, body: unknown = DEFAULT_EDIT) =>
  app.request(`/${id}/${action}`, json(body));
async function upload() {
  const r = await app.request("/?name=source.mp4", {
    method: "POST",
    body: readFileSync(fixture),
  });
  expect(r.status).toBe(201);
  return r.json() as Promise<{ id: string }>;
}
beforeAll(() => {
  if (!available) return;
  const made = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=25:duration=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=4",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-shortest",
    fixture,
  ]);
  expect(made.status, made.stderr.toString()).toBe(0);
  mkdirSync(clipDir, { recursive: true });
  writeFileSync(original, readFileSync(fixture));
  writeFileSync(
    path.join(projectDir, "meta.json"),
    JSON.stringify({
      id: projectId,
      name: "Test project",
      owner: "owner",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      duration: 4,
      revision: 3,
      clips: [
        { id: clipId, name: "source.mp4", duration: 4, createdAt: Date.now() },
      ],
    }),
  );
  const words = [
    { id: 7, text: "hello", start: 0.5, end: 1 },
    { id: 9, text: "world", start: 2.5, end: 3 },
  ];
  writeFileSync(
    path.join(clipDir, "data.json"),
    JSON.stringify({
      words,
      originalWords: words,
      cues: words.map((w, id) => ({
        id,
        start: w.start,
        end: w.end,
        words: [w],
      })),
      texts: [{ id: 1, text: "Title", start: 2.2, end: 3.8 }],
      style: { fontFamily: "Anton" },
    }),
  );
});
afterAll(() => rm(root, { recursive: true, force: true }));
const edit = {
  ...DEFAULT_EDIT,
  adjustments: {
    ...DEFAULT_EDIT.adjustments,
    speed: 2,
    cuts: [
      { start: 2, end: 4 },
      { start: 0, end: 2 },
    ],
  },
};
describe.skipIf(!available)("Cleaner timeline pipeline", () => {
  it.skipIf(!native || !existsSync("runtime/sscd/sscd.onnx"))(
    "keeps SSCD cancellations independent and measures the latest semantic revision",
    async () => {
      const { id } = await upload();
      const client = randomUUID();
      const request = (action: string, revision: number) =>
        app.request(`/${id}/${action}`, {
          ...json(DEFAULT_EDIT),
          headers: {
            "content-type": "application/json",
            "X-Clean-Client": client,
            "X-Clean-Revision": String(revision),
          },
        });
      expect((await request("sscd/cancel", 2)).status).toBe(204);
      expect((await request("sscd", 1)).status).toBe(409);
      expect((await request("score", 1)).status).toBe(200);
      const response = await request("sscd", 3);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(((await response.json()) as QuickScore).sscd?.status).toBe("ok");
      expect((await app.request(`/${id}`, { method: "DELETE" })).status).toBe(
        200,
      );
      expect(existsSync(path.join(root, "clean", "sources", id))).toBe(false);
    },
    15_000,
  );

  it.skipIf(!native)(
    "scores cached samples without encoding a video or retaining edit outputs",
    async () => {
      const { id } = await upload();
      const first = await post(id, "score");
      expect(first.status, await first.clone().text()).toBe(200);
      const one = (await first.json()) as QuickScore;
      expect(one.pdq.status).toBe("ok");
      const next = await post(id, "score", {
        ...DEFAULT_EDIT,
        adjustments: { ...DEFAULT_EDIT.adjustments, saturation: 0 },
      });
      expect(next.status, await next.clone().text()).toBe(200);
      const two = (await next.json()) as QuickScore;
      expect(two.cachedFrames).toBe(4);
      expect(two.pdq.status).toBe("ok");
      expect(
        (
          await readdir(path.join(root, "clean", "sources", id, ".score-cache"))
        ).some((f) => f.startsWith("run-")),
      ).toBe(false);
      console.log(
        `Quick scoring: cold ${one.elapsedMs}ms; warm ${two.elapsedMs}ms`,
      );
      username = "stranger";
      expect((await post(id, "score")).status).toBe(404);
      username = "owner";
    },
    30_000,
  );
  it("renders reordered scenes with retimed audio and detects hard cuts", async () => {
    const { id } = await upload();
    const response = await post(id, "export", edit);
    expect(response.status, await response.clone().text()).toBe(200);
    const out = path.join(root, "cut.mp4");
    writeFileSync(out, Buffer.from(await response.arrayBuffer()));
    const info = await probe(out);
    expect(Number(info.format?.duration)).toBeCloseTo(2, 1);
    expect(info.streams?.some((s) => s.codec_type === "audio")).toBe(true);
    const scene = path.join(root, "scenes.mp4");
    const created = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=red:s=160x90:r=25:d=1",
      "-f",
      "lavfi",
      "-i",
      "color=blue:s=160x90:r=25:d=1",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map",
      "[v]",
      "-c:v",
      "libx264",
      scene,
    ]);
    expect(created.status).toBe(0);
    const uploaded = await app.request("/?name=scenes.mp4", {
      method: "POST",
      body: readFileSync(scene),
    });
    const detected = await post(
      ((await uploaded.json()) as { id: string }).id,
      "cuts",
      { threshold: 0.2 },
    );
    expect(detected.status, await detected.clone().text()).toBe(200);
    expect(
      ((await detected.json()) as { cuts: { start: number; end: number }[] })
        .cuts,
    ).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ]);
  }, 30_000);
  it("round trips captions into a new clip, protects ownership and media, and is idempotent", async () => {
    const request = { projectId, clipId };
    username = "stranger";
    expect((await app.request("/from-captions", json(request))).status).toBe(
      404,
    );
    username = "owner";
    const imported = await app.request("/from-captions", json(request));
    expect(imported.status, await imported.clone().text()).toBe(201);
    const source = (await imported.json()) as {
      id: string;
      captionData?: unknown;
    };
    expect(source.captionData).toBeUndefined();
    expect(
      statSync(path.join(root, "clean", "sources", source.id, "original.mp4"))
        .ino,
    ).toBe(statSync(original).ino);
    const sent = await post(source.id, "to-captions", edit);
    expect(sent.status, await sent.clone().text()).toBe(201);
    const result = (await sent.json()) as { projectId: string; clipId: string };
    expect(result.projectId).toBe(projectId);
    expect(result.clipId).not.toBe(clipId);
    const data = JSON.parse(
      readFileSync(
        path.join(projectDir, "clips", result.clipId, "data.json"),
        "utf8",
      ),
    );
    expect(
      data.words.map((w: { text: string; start: number }) => [w.text, w.start]),
    ).toEqual([
      ["world", 0.25],
      ["hello", 1.25],
    ]);
    expect(data.texts[0].start).toBeCloseTo(0.1);
    expect(data.texts[0].end).toBeCloseTo(0.9);
    expect(data.style.fontFamily).toBe("Anton");
    expect(data.duration).toBe(2);
    expect((await post(source.id, "to-captions", edit)).status).toBe(200);
    const meta = JSON.parse(
      readFileSync(path.join(projectDir, "meta.json"), "utf8"),
    );
    expect(meta.clips).toHaveLength(2);
    expect(meta.revision).toBe(4);
    expect((await post(source.id, "to-captions", DEFAULT_EDIT)).status).toBe(
      409,
    );
    expect(
      (await app.request(`/${source.id}`, { method: "DELETE" })).status,
    ).toBe(200);
    expect(readFileSync(original)).toEqual(readFileSync(fixture));
  }, 30_000);
  it("creates a Caption Studio project from a plain upload", async () => {
    const { id } = await upload();
    const sent = await post(id, "to-captions");
    expect(sent.status, await sent.clone().text()).toBe(201);
    const result = (await sent.json()) as { projectId: string; clipId: string };
    expect(result.projectId).not.toBe(projectId);
    const data = JSON.parse(
      readFileSync(
        path.join(
          root,
          "projects",
          result.projectId,
          "clips",
          result.clipId,
          "data.json",
        ),
        "utf8",
      ),
    );
    expect(data.words).toEqual([]);
    expect(data.cues).toEqual([]);
  }, 30_000);
});
