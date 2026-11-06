import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";
import type { CleanSource } from "../contracts/clean-workspace";

const dataDir = mkdtempSync(path.join(tmpdir(), "clean-workspace-test-"));
process.env.DATA_DIR = dataDir;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const { cleanApp } = await import("./clean");
let username = "owner";
function authenticatedApp() {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", async (c, next) => {
    c.set("user", { username, role: "user", cloud: false, off: [] });
    await next();
  });
  return app;
}
const app = authenticatedApp().route("/", cleanApp);
let body: Buffer;
beforeAll(() => {
  if (!hasFfmpeg) return;
  const file = path.join(dataDir, "original.mp4");
  const result = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=15:duration=2",
    "-metadata",
    "title=Private source",
    "-c:v",
    "mpeg4",
    file,
  ]);
  expect(result.status, result.stderr.toString()).toBe(0);
  body = readFileSync(file);
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});
async function upload() {
  const response = await app.request("/sources?name=original.mp4", {
    method: "POST",
    body,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as CleanSource;
}
async function create(id: string, stripMetadata: boolean, unique: boolean) {
  return app.request(`/sources/${id}/versions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stripMetadata, unique }),
  });
}

describe.skipIf(!hasFfmpeg)("upload-once cleaner workspace", () => {
  it("retains the unchanged original and independently creates versions with different options", async () => {
    const source = await upload();
    expect(source.versions).toEqual([]);
    expect(
      source.metadata.some((item) => item.value === "Private source"),
    ).toBe(true);
    expect(source).not.toHaveProperty("owner");
    const original = await app.request(`/sources/${source.id}/media`);
    expect(Buffer.from(await original.arrayBuffer())).toEqual(body);

    const first = await create(source.id, true, false);
    expect(first.status).toBe(201);
    const a = (await first.json()) as CleanSource;
    expect(a.versions[0].metadata).toEqual([]);
    const second = await create(source.id, false, true);
    expect(second.status).toBe(201);
    const b = (await second.json()) as CleanSource;
    expect(b.versions).toHaveLength(2);
    expect(b.versions[0]).toEqual(a.versions[0]);
    expect(b.versions[1].metadata).toEqual(source.metadata);
    expect(b.versions[1].md5).not.toBe(source.md5);
    const third = await create(source.id, false, false);
    const c = (await third.json()) as CleanSource;
    expect(c.versions[2].md5).toBe(source.md5);
    expect(c.md5).toBe(source.md5);
    expect(
      Buffer.from(
        await (await app.request(`/sources/${source.id}/media`)).arrayBuffer(),
      ),
    ).toEqual(body);

    const download = await app.request(
      `/sources/${source.id}/versions/${a.versions[0].id}/media?download=1`,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain(
      "original-v1.mp4",
    );
    // Persisted manifests support refresh/server reload; originals are not tied to an in-memory map.
    vi.resetModules();
    const { cleanWorkspaceApp } = await import("./clean-workspace");
    const reloaded = authenticatedApp().route("/sources", cleanWorkspaceApp);
    const restored = await reloaded.request(`/sources/${source.id}`);
    expect(((await restored.json()) as CleanSource).versions).toEqual(
      c.versions,
    );
  });

  it("supports preview seeking, suffix ranges, HEAD and invalid-range responses", async () => {
    const source = await upload();
    const url = `/sources/${source.id}/media`;
    for (const [range, expected] of [
      ["bytes=0-15", body.subarray(0, 16)],
      ["bytes=-20", body.subarray(-20)],
    ] as const) {
      const response = await app.request(url, { headers: { Range: range } });
      expect(response.status).toBe(206);
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
    }
    expect(
      (await app.request(url, { headers: { Range: "bytes=999999999-" } }))
        .status,
    ).toBe(416);
    expect(
      (await app.request(url, { headers: { Range: "bytes=-0" } })).status,
    ).toBe(416);
    const head = await app.request(url, { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe(String(body.length));
    expect(await head.text()).toBe("");
  });

  it("protects originals, versions, measurements and removal with ownership checks", async () => {
    const source = await upload();
    const saved = (await (
      await create(source.id, true, false)
    ).json()) as CleanSource;
    const version = saved.versions[0].id;
    username = "other";
    try {
      for (const [route, method] of [
        [`/sources/${source.id}`, "GET"],
        [`/sources/${source.id}/media`, "GET"],
        [`/sources/${source.id}/versions/${version}/media`, "GET"],
        [`/sources/${source.id}/versions`, "POST"],
        [`/sources/${source.id}/versions/${version}/measure`, "POST"],
        [`/sources/${source.id}/sscd`, "POST"],
        [`/sources/${source.id}/sscd/cancel`, "POST"],
        [`/sources/${source.id}/score`, "POST"],
        [`/sources/${source.id}/score/cancel`, "POST"],
        [`/sources/${source.id}`, "DELETE"],
      ]) {
        expect((await app.request(route, { method })).status).toBe(404);
      }
    } finally {
      username = "owner";
    }
    expect((await app.request(`/sources/${source.id}`)).status).toBe(200);
  });

  it("keeps existing versions after failed processing, validates options, and rejects concurrent mutations", async () => {
    const source = await upload();
    const first = (await (
      await create(source.id, true, false)
    ).json()) as CleanSource;
    vi.stubEnv("FFMPEG_PATH", "/missing/workspace-test-ffmpeg");
    try {
      expect((await create(source.id, true, false)).status).toBe(500);
    } finally {
      vi.unstubAllEnvs();
    }
    const retained = (await (
      await app.request(`/sources/${source.id}`)
    ).json()) as CleanSource;
    expect(retained.versions).toEqual(first.versions);
    expect(retained.md5).toBe(source.md5);
    expect(
      (
        await app.request(`/sources/${source.id}/versions`, {
          method: "POST",
          body: JSON.stringify({ unique: "yes" }),
        })
      ).status,
    ).toBe(400);
    const statuses = await Promise.all([
      create(source.id, true, false),
      create(source.id, true, true),
    ]);
    expect(statuses.map((result) => result.status).sort()).toEqual([201, 409]);
  });

  it("expires and explicitly removes the original and all versions together", async () => {
    const source = await upload();
    await create(source.id, true, false);
    const dir = path.join(dataDir, "clean", "sources", source.id);
    const manifestPath = path.join(dir, "session.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.expiresAt = Date.now() - 1;
    await writeFile(manifestPath, JSON.stringify(manifest));
    expect((await app.request(`/sources/${source.id}`)).status).toBe(410);
    expect(existsSync(dir)).toBe(false);
    const other = await upload();
    expect(
      (await app.request(`/sources/${other.id}`, { method: "DELETE" })).status,
    ).toBe(200);
    expect((await app.request(`/sources/${other.id}/media`)).status).toBe(404);
  });

  it("keeps the demo's finished run and serves its showcase", async () => {
    username = "demo";
    try {
      expect((await app.request("/sources/showcase")).status).toBe(404);
      const source = await upload();
      const dir = path.join(dataDir, "clean", "sources", source.id);
      const manifestPath = path.join(dir, "session.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.expiresAt = Date.now() - 1;
      await writeFile(manifestPath, JSON.stringify(manifest));
      const showcase = { runs: [{ preset: "Reframe" }] };
      await writeFile(
        path.join(dir, "showcase.json"),
        JSON.stringify(showcase),
      );
      await upload(); // an upload sweeps expired sessions
      const shown = await app.request(`/sources/${source.id}`);
      expect(shown.status).toBe(200);
      expect(((await shown.json()) as CleanSource).showcase).toEqual(showcase);
      expect(await (await app.request("/sources/showcase")).json()).toEqual({
        id: source.id,
      });
      username = "owner"; // only the owner's own finished run
      expect((await app.request("/sources/showcase")).status).toBe(404);
    } finally {
      username = "owner";
    }
    const plain = await upload();
    expect(
      await (await app.request(`/sources/${plain.id}`)).json(),
    ).not.toHaveProperty("showcase");
  });

  it.skipIf(!existsSync(path.resolve("runtime/fingerprints/tmk-hash-video")))(
    "measures a chosen version later without changing its bytes or losing the baseline",
    async () => {
      const source = await upload();
      const saved = (await (
        await create(source.id, true, true)
      ).json()) as CleanSource;
      const version = saved.versions[0];
      expect(version.fingerprints).toBeUndefined();
      const measured = await app.request(
        `/sources/${source.id}/versions/${version.id}/measure`,
        { method: "POST" },
      );
      expect(measured.status).toBe(200);
      const result = (await measured.json()) as CleanSource;
      expect(result.md5).toBe(source.md5);
      expect(result.versions[0].md5).toBe(version.md5);
      expect(result.versions[0].fingerprints?.pdq).toMatchObject({
        status: "ok",
        meanDistance: 0,
      });
      expect(result.versions[0].fingerprints?.tmk).toMatchObject({
        status: "ok",
        level1: 1,
        level2: 1,
      });
    },
    30_000,
  );
});
