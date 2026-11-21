import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// Playback copies (lib/play-copies.ts) through the real Bunny store (library/storage/bunny.ts) against a stand-in Storage
// API: the first play streams and copies, the next is a signed link, and every way a version goes for good takes its copy.
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dataDir = mkdtempSync(path.join(scratch, "play-copies-"));
process.env.DATA_DIR = dataDir;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

// the stand-in Storage zone: PUT, HEAD, DELETE by path; `refuse` makes every PUT fail
const objects = new Map<string, number>();
let refuse = false;
const storage = createServer((req, res) => {
  const key = decodeURIComponent((req.url ?? "").replace(/^\/tinyzone\//, ""));
  if (req.method === "PUT") {
    let n = 0;
    req.on("data", (b: Buffer) => (n += b.length));
    req.on("end", () => {
      if (!refuse) objects.set(key, n);
      res.writeHead(refuse ? 500 : 201).end();
    });
    return;
  }
  if (req.method === "DELETE") objects.delete(key);
  const has = objects.has(key);
  res.writeHead(req.method === "DELETE" || has ? 200 : 404, has ? { "content-length": String(objects.get(key)) } : {}).end();
});
await new Promise<void>((r) => storage.listen(0, "127.0.0.1", r));
afterAll(() => {
  storage.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const { bunnyBlobs } = await import("../library/storage/bunny");
const { definePlugin, mountPlugins } = await import("./plugin");
const store = bunnyBlobs(
  { zone: "tinyzone", accessKey: "tiny-password", cdnHost: "tinyacrobatics.b-cdn.net", tokenKey: "tiny-token", origin: `http://127.0.0.1:${(storage.address() as AddressInfo).port}` },
  path.join(dataDir, "cache"),
  { cacheBytes: 0 },
);
mountPlugins(new Hono(), [definePlugin({ id: "cdn", playCopies: { label: "Tiny CDN", store: () => store } })]);

const { reviewApp, readMeta, purgeExpiredReview } = await import("../review");
const { libraryApp } = await import("../library/routes");
const { collectionApp } = await import("../library/collections");
const { libraryDb } = await import("../library/db");
const { finalsCollectionId } = await import("../library/finals");
const { deleteAssets } = await import("../library/trash");
const { copiesSettled, heldCopies } = await import("./play-copies");

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "owner", role: "user", cloud: false, off: [] });
  await next();
});
app.route("/api/library", collectionApp);
app.route("/api/library", libraryApp);
app.route("/", reviewApp);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const until = async (ok: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 50));
  return ok();
};
const libraryRow = (id: string) => libraryDb().prepare("SELECT library_id FROM assets WHERE id = ?").get(id) as { library_id: string } | undefined;

const mp4 = path.join(dataDir, "clip.mp4");
if (hasFfmpeg) spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=25:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);

/** A ready Review video of one H.264 MP4 version (browsers play it as it is, so /play sends the source). */
const up = async (name: string) => {
  const bytes = readFileSync(mp4);
  const init = await read(app.request("/uploads", json({ name, size: bytes.length })));
  await app.request(`/uploads/${init.id}/parts/1`, {
    method: "POST",
    headers: { "upload-length": String(bytes.length), "upload-part-size": String(init.partSize), "content-length": String(bytes.length) },
    body: bytes,
  });
  const asset = (await read(app.request(`/uploads/${init.id}/complete`, { method: "POST" }))) as { id: string };
  await until(async () => (await readMeta(asset.id))?.versions[0]?.status === "ready" && !!libraryRow(asset.id));
  return asset.id;
};
const play = (url: string, headers: Record<string, string> = {}) => app.request(url, { headers });
const copiesOf = (prefix: string) => [...objects.keys()].filter((k) => k.startsWith(`play-copies/${prefix}`));

describe.skipIf(!hasFfmpeg)("Review and Finals play from their playback copy", () => {
  it("streams the first play, copies it, then answers with a fresh signed link; the server's file stays", async () => {
    const id = await up("Tiny Acrobatics cut.mp4");
    const first = await play(`/assets/${id}/v/1/play`);
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    await copiesSettled();
    expect(copiesOf(`review/${id}/`)).toHaveLength(1);
    expect(objects.get(copiesOf(`review/${id}/`)[0]!)).toBe(readFileSync(mp4).length);
    expect(existsSync(path.join(dataDir, "review", id, "v1", "source"))).toBe(true);

    const next = await play(`/assets/${id}/v/1/play`);
    expect(next.status).toBe(302);
    expect(next.headers.get("cache-control")).toBe("no-store");
    const link = new URL(next.headers.get("location")!);
    expect(link.host).toBe("tinyacrobatics.b-cdn.net");
    expect(link.pathname).toMatch(new RegExp(`^/play-copies/review/${id}/\\d+/\\d+\\.mp4$`));
    expect(Number(link.searchParams.get("expires")) - Date.now() / 1000).toBeGreaterThan(23 * 3600);
    expect(link.searchParams.get("token")).toMatch(/^HS256-/);
    // a CORS load (a canvas reading the frames) stays on this server
    expect((await play(`/assets/${id}/v/1/play`, { "sec-fetch-mode": "cors" })).status).toBe(200);
  });

  it("keeps streaming when the copy can't be made", async () => {
    refuse = true;
    try {
      const id = await up("Tiny Acrobatics refused.mp4");
      expect((await play(`/assets/${id}/v/1/play`)).status).toBe(200);
      await copiesSettled();
      expect((await play(`/assets/${id}/v/1/play`)).status).toBe(200);
      expect(copiesOf(`review/${id}/`)).toHaveLength(0);
    } finally {
      refuse = false;
    }
  });

  it("deletes the copy when the video is trashed, its trash emptied, or it is purged", async () => {
    const trashed = await up("Tiny Acrobatics trashed.mp4");
    const purged = await up("Tiny Acrobatics purged.mp4");
    for (const id of [trashed, purged]) {
      await play(`/assets/${id}/v/1/play`);
      await copiesSettled();
      expect(copiesOf(`review/${id}/`)).toHaveLength(1);
    }
    await app.request(`/assets/${trashed}`, { method: "DELETE" });
    expect(await until(() => copiesOf(`review/${trashed}/`).length === 0)).toBe(true);
    await app.request(`/trash/${trashed}`, { method: "DELETE" });

    await purgeExpiredReview((owner) => owner === "owner");
    expect(await until(() => copiesOf(`review/${purged}/`).length === 0)).toBe(true);
    expect((await heldCopies()).filter((k) => k.includes(purged) || k.includes(trashed))).toEqual([]);
  });

  it("copies a Final, never the footage, and drops the copy when it leaves Finals or goes", async () => {
    const id = await up("Tiny Acrobatics final.mp4");
    const versionId = (await readMeta(id))!.versions[0]!.versionId!;
    const footage = `/api/library/media/${versionId}/play`;
    await play(footage);
    await copiesSettled();
    expect(copiesOf(`library/${versionId}/`)).toHaveLength(0); // not a Final: never copied

    const d = libraryDb();
    const lib = libraryRow(id)!.library_id;
    d.prepare("INSERT INTO pieces (id, library_id, collection_id, label, created_by, created_at) VALUES ('pc_tiny', ?, ?, 'Tiny', 'owner', 0)").run(lib, finalsCollectionId(lib));
    d.prepare("INSERT INTO piece_items (id, piece_id, version_id, position) VALUES ('pi_tiny', 'pc_tiny', ?, 1)").run(versionId);
    expect((await play(footage)).status).toBe(200);
    await copiesSettled();
    expect(copiesOf(`library/${versionId}/`)).toHaveLength(1);
    expect((await play(footage)).status).toBe(302);

    await app.request(`/api/library/${lib}/pieces/pc_tiny/items/pi_tiny`, { method: "DELETE" });
    expect(await until(() => copiesOf(`library/${versionId}/`).length === 0)).toBe(true);

    // a Final again, then deleted for good with its asset
    d.prepare("INSERT INTO piece_items (id, piece_id, version_id, position) VALUES ('pi_tiny2', 'pc_tiny', ?, 1)").run(versionId);
    await play(footage);
    await copiesSettled();
    expect(copiesOf(`library/${versionId}/`)).toHaveLength(1);
    await deleteAssets([id]);
    expect(copiesOf(`library/${versionId}/`)).toHaveLength(0);
  });
});
