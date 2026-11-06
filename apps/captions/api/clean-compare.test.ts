import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";
import type {
  CleanSource,
  UploadedComparison,
} from "../contracts/clean-workspace";

vi.mock("./lib/clean-fingerprints", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./lib/clean-fingerprints")>();
  return { ...actual, measureFingerprints: vi.fn(actual.measureFingerprints) };
});
const dataDir = mkdtempSync(path.join(tmpdir(), "clean-compare-test-"));
process.env.DATA_DIR = dataDir;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const hasNative = existsSync(
  path.resolve("runtime/fingerprints/tmk-hash-video"),
);
const { cleanWorkspaceApp } = await import("./clean-workspace");
const { measureFingerprints } = await import("./lib/clean-fingerprints");
let username = "owner";
const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username, role: "user", cloud: false, off: [] });
  await next();
});
app.route("/sources", cleanWorkspaceApp);
const bodies: Buffer[] = [];
beforeAll(() => {
  if (!hasFfmpeg) return;
  for (const duration of [2, 1]) {
    const file = path.join(dataDir, `source-${duration}.mp4`);
    const result = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=320x180:rate=15:duration=${duration}`,
      "-metadata",
      `title=Video ${duration}`,
      "-c:v",
      "mpeg4",
      file,
    ]);
    expect(result.status, result.stderr.toString()).toBe(0);
    bodies.push(readFileSync(file));
  }
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});
const folder = (id: string) => path.join(dataDir, "clean", "sources", id);
async function upload(index = 0) {
  const response = await app.request(`/sources?name=video-${index}.mp4`, {
    method: "POST",
    body: bodies[index],
  });
  expect(response.status).toBe(201);
  return (await response.json()) as CleanSource;
}
const compare = (id: string, otherId: string) =>
  app.request(`/sources/${id}/compare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ otherId }),
  });
async function setExpiry(id: string, expiresAt: number) {
  const manifest = path.join(folder(id), "session.json");
  const source = JSON.parse(await readFile(manifest, "utf8"));
  await writeFile(manifest, JSON.stringify({ ...source, expiresAt }));
}

describe.skipIf(!hasFfmpeg)("independent upload comparisons", () => {
  it("checks both owners, rejects invalid/self pairs, and handles an expired second upload", async () => {
    const a = await upload();
    username = "other";
    const b = await upload(1);
    try {
      expect((await compare(a.id, b.id)).status).toBe(404);
      expect((await compare(b.id, a.id)).status).toBe(404);
    } finally {
      username = "owner";
    }
    expect((await compare(a.id, b.id)).status).toBe(404);
    expect((await compare(a.id, a.id)).status).toBe(400);
    expect((await compare(a.id, "../session.json")).status).toBe(400);
    expect(
      (await compare(a.id, "c4d1bfbf-5fab-4f83-b242-b726015f6039")).status,
    ).toBe(404);
    const c = await upload(1);
    await setExpiry(c.id, Date.now() - 1);
    expect((await compare(a.id, c.id)).status).toBe(410);
    expect(existsSync(folder(c.id))).toBe(false);
    expect((await app.request(`/sources/${a.id}`)).status).toBe(200);
  });

  it("locks both uploads during analysis, releases them after failure, and retains no extra files", async () => {
    const a = await upload(),
      b = await upload(1);
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(measureFingerprints).mockImplementationOnce(async () => {
      started();
      await gate;
      throw new Error("Test analysis failure");
    });
    const pending = compare(a.id, b.id);
    await entered;
    try {
      for (const source of [a, b]) {
        expect(
          (await app.request(`/sources/${source.id}`, { method: "DELETE" }))
            .status,
        ).toBe(409);
        expect(
          (
            await app.request(`/sources/${source.id}/versions`, {
              method: "POST",
              body: JSON.stringify({ stripMetadata: true, unique: false }),
            })
          ).status,
        ).toBe(409);
      }
      expect((await compare(b.id, a.id)).status).toBe(409);
    } finally {
      release();
    }
    expect((await pending).status).toBe(500);
    for (const source of [a, b]) {
      expect((await readdir(folder(source.id))).sort()).toEqual([
        "original.mp4",
        "session.json",
      ]);
      expect(
        (await app.request(`/sources/${source.id}`, { method: "DELETE" }))
          .status,
      ).toBe(200);
    }
  });

  it.skipIf(!hasNative)(
    "measures unequal-length uploads over their shared timestamps without changing either file",
    async () => {
      const a = await upload(),
        b = await upload(1);
      const oldExpiry = Date.now() + 10_000;
      await setExpiry(a.id, oldExpiry);
      await setExpiry(b.id, oldExpiry);
      for (const [before, after] of [
        [a, b],
        [b, a],
      ]) {
        const response = await compare(before.id, after.id);
        expect(response.status).toBe(200);
        const result = (await response.json()) as UploadedComparison;
        expect(result).toMatchObject({
          beforeId: before.id,
          afterId: after.id,
        });
        expect(result.fingerprints.pdq.status).toBe("ok");
        if (result.fingerprints.pdq.status === "ok") {
          expect(result.fingerprints.pdq.frames).toHaveLength(1);
          expect(result.fingerprints.pdq.frames[0].seconds).toBe(0);
          expect(result.fingerprints.pdq.frames[0].distance).toBe(0);
        }
        expect(result.fingerprints.tmk.status).toBe("ok");
        expect(result.fingerprints.scope).toContain("shorter video");
      }
      for (const [index, source] of [a, b].entries()) {
        const saved = (await (
          await app.request(`/sources/${source.id}`)
        ).json()) as CleanSource;
        expect(saved.md5).toBe(source.md5);
        expect(saved.metadata).toEqual(source.metadata);
        expect(saved.versions).toEqual([]);
        expect(saved.expiresAt).toBeGreaterThan(oldExpiry);
        expect(
          Buffer.from(
            await (
              await app.request(`/sources/${source.id}/media`)
            ).arrayBuffer(),
          ),
        ).toEqual(bodies[index]);
        expect((await readdir(folder(source.id))).sort()).toEqual([
          "original.mp4",
          "session.json",
        ]);
      }
    },
    30_000,
  );
});
