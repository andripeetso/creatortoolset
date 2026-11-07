import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "./auth";

// Review videos as Media Library assets (review.ts toLibrary): the library reads the same files, and its rows follow
// whatever Review does to a video.
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dataDir = mkdtempSync(path.join(scratch, "review-library-"));
process.env.DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

const { reviewApp, readMeta, reviewToLibrary } = await import("./review");
const { libraryApp } = await import("./library/routes");
const { libraryDb } = await import("./library/db");

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "owner", role: "user", cloud: false, off: [] });
  await next();
});
app.route("/api/library", libraryApp);
app.route("/", reviewApp);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const until = async (ok: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 50));
};
const row = (id: string) =>
  libraryDb().prepare("SELECT library_id, title, current_version_id, trashed_at FROM assets WHERE id = ?").get(id) as
    | { library_id: string; title: string; current_version_id: string; trashed_at: number | null }
    | undefined;
/** (versionId → n) as the library has it, for one asset */
const numbers = (id: string) =>
  Object.fromEntries(
    (libraryDb().prepare("SELECT id, n FROM asset_versions WHERE asset_id = ?").all(id) as { id: string; n: number }[]).map((v) => [v.id, v.n]),
  );
/** (versionId → n) as Review's meta has it */
const metaNumbers = async (id: string) => Object.fromEntries((await readMeta(id))!.versions.map((v) => [v.versionId!, v.n]));

const up = async (name: string, bytes = Buffer.from(name)) => {
  const init = await read(app.request("/uploads", json({ name, size: bytes.length })));
  await app.request(`/uploads/${init.id}/parts/1`, {
    method: "POST",
    headers: { "upload-length": String(bytes.length), "upload-part-size": String(init.partSize), "content-length": String(bytes.length) },
    body: bytes,
  });
  const asset = await read(app.request(`/uploads/${init.id}/complete`, { method: "POST" }));
  await until(() => !!row(asset.id)); // processed, then in the library
  return asset as { id: string };
};

describe("Review in the Media Library", () => {
  it.skipIf(!hasFfmpeg)("serves a Review video's proxy through the library, byte for byte", async () => {
    // H.264 in Matroska: browsers can't play the file, so Review makes a proxy
    const src = path.join(dataDir, "clip.mkv");
    spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=25:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", src]);
    const asset = await up("Tiny Acrobatics roll.mkv", readFileSync(src));
    const meta = (await readMeta(asset.id))!;
    expect(meta.versions[0]).toMatchObject({ status: "ready", proxy: true });
    const versionId = meta.versions[0]!.versionId!;
    expect(row(asset.id)).toMatchObject({ title: "Tiny Acrobatics roll", current_version_id: versionId, trashed_at: null });

    const review = Buffer.from(await (await app.request(`/assets/${asset.id}/v/1/play`)).arrayBuffer());
    const library = Buffer.from(await (await app.request(`/api/library/media/${versionId}/play`)).arrayBuffer());
    expect(library.length).toBeGreaterThan(0);
    expect(library.equals(review)).toBe(true);
    expect((await app.request(`/api/library/media/${versionId}/thumb`)).status).toBe(200);
    // on the library's grid, and the local extras queued (no transcribe: that spends someone's key)
    const page = await read(app.request(`/api/library/${row(asset.id)!.library_id}/assets`));
    expect(page.items.map((a: { id: string }) => a.id)).toContain(asset.id);
    const jobs = (libraryDb().prepare("SELECT kind FROM jobs WHERE version_id = ?").all(versionId) as { kind: string }[]).map((j) => j.kind);
    expect(jobs.sort()).toEqual(["fingerprint", "wave"]);
  });

  it("follows stack, order, unstack, rename and the trash", async () => {
    const [a, b, c] = [await up("a.mp4"), await up("b.mp4"), await up("c.mp4")];
    await app.request(`/assets/${a.id}/stack`, json({ from: b.id }));
    await app.request(`/assets/${a.id}/stack`, json({ from: c.id }));
    expect(row(b.id)).toBeUndefined(); // stacked away: gone from the library too
    expect(numbers(a.id)).toEqual(await metaNumbers(a.id));
    expect(Object.keys(numbers(a.id))).toHaveLength(3);

    await app.request(`/assets/${a.id}/order`, json({ order: [3, 1, 2] }));
    expect(numbers(a.id)).toEqual(await metaNumbers(a.id));
    expect(row(a.id)!.current_version_id).toBe((await readMeta(a.id))!.versions.at(-1)!.versionId);

    const left = await read(app.request(`/assets/${a.id}/unstack`, json({ n: 1 })));
    expect(left.versions).toHaveLength(2);
    expect(numbers(a.id)).toEqual(await metaNumbers(a.id));
    const own = (await read(app.request("/"))).find((x: { id: string; name: string }) => x.name === "c");
    expect(numbers(own.id)).toEqual(await metaNumbers(own.id)); // its version id went with it, now V1

    await app.request(`/assets/${a.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Final cut" }) });
    expect(row(a.id)!.title).toBe("Final cut");

    // the library leaves Review's videos to Review
    const lib = row(a.id)!.library_id;
    expect((await app.request(`/api/library/${lib}/assets/${a.id}`, { method: "DELETE" })).status).toBe(409);

    await app.request(`/assets/${a.id}`, { method: "DELETE" });
    expect(row(a.id)!.trashed_at).toBeGreaterThan(0);
    await app.request(`/trash/${a.id}/restore`, { method: "POST" });
    expect(row(a.id)!.trashed_at).toBeNull();
    await app.request(`/assets/${a.id}`, { method: "DELETE" });
    await app.request(`/trash/${a.id}`, { method: "DELETE" });
    expect(row(a.id)).toBeUndefined();
    expect(libraryDb().prepare("SELECT COUNT(*) AS n FROM asset_versions WHERE asset_id = ?").get(a.id)).toEqual({ n: 0 });
  });

  it("moves a video stored before the library: version ids given, its last change kept", async () => {
    const id = "0b5d6c1e-1111-4222-8333-944455556666";
    const dir = path.join(dataDir, "review", id);
    mkdirSync(path.join(dir, "v1"), { recursive: true });
    writeFileSync(path.join(dir, "v1", "source"), "old upload");
    const old = {
      id, name: "Older video", owner: "owner", approval: { status: "none" }, createdAt: 1, updatedAt: 2,
      versions: [{ n: 1, name: "old.mp4", mime: "video/mp4", bytes: 10, duration: 0, fps: 0, width: 0, height: 0, status: "error", progress: 0, createdAt: 1 }],
    };
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify(old));
    writeFileSync(path.join(dir, "comments.json"), JSON.stringify([{ id: "c1", version: 1, text: "kept", author: "x", createdAt: 1 }]));

    await reviewToLibrary();
    await reviewToLibrary(); // again: nothing changes
    const meta = (await readMeta(id))!;
    expect(meta.updatedAt).toBe(2);
    expect(meta.versions[0]!.versionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(numbers(id)).toEqual({ [meta.versions[0]!.versionId!]: 1 });
    expect(row(id)).toMatchObject({ title: "Older video" });
    // the library opens it in Review instead of offering its own trash (which answers 409)
    const page = await read(app.request(`/api/library/${row(id)!.library_id}/assets`));
    expect(page.items.find((a: { id: string }) => a.id === id)).toMatchObject({ review: true });
    // Review reads it as before
    const view = await read(app.request(`/assets/${id}`));
    expect(view.comments.map((x: { text: string }) => x.text)).toEqual(["kept"]);
  });
});
