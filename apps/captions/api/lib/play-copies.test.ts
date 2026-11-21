import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";

// Playback copies (lib/play-copies.ts) through the real Bunny store (library/storage/bunny.ts) against a stand-in Storage
// API: a ready version (and a new Final) is pushed at once, /play is then a signed link, and every removal path drops the copy.
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
const cdn = definePlugin({ id: "cdn", playCopies: { label: "Tiny CDN", store: () => store } });
mountPlugins(new Hono(), [cdn]);

const { reviewApp, readMeta, purgeExpiredReview } = await import("../review");
const { libraryApp } = await import("../library/routes");
const { collectionApp } = await import("../library/collections");
const { libraryDb } = await import("../library/db");
const { finalsCollectionId } = await import("../library/finals");
const { deleteAssets } = await import("../library/trash");
const { COPY_DAYS, copiesSettled, heldCopies, sweepPlayCopies } = await import("./play-copies");

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

const pushed = (prefix: string) => until(() => copiesOf(prefix).length > 0);
const dropped = (prefix: string) => until(() => copiesOf(prefix).length === 0);
/** Runs `run` as if COPY_DAYS and a day had passed. */
const later = async (run: () => Promise<unknown>) => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + (COPY_DAYS + 1) * 86_400_000);
  try {
    await run();
  } finally {
    clock.mockRestore();
  }
};

describe.skipIf(!hasFfmpeg)("Review and Finals play from their playback copy", () => {
  it("pushes a version as soon as it is ready, then /play is a fresh signed link; the server's file stays", async () => {
    const id = await up("Tiny Acrobatics cut.mp4");
    expect(await pushed(`review/${id}/`)).toBe(true); // before anyone played it
    expect(objects.get(copiesOf(`review/${id}/`)[0]!)).toBe(readFileSync(mp4).length);
    expect(existsSync(path.join(dataDir, "review", id, "v1", "source"))).toBe(true);

    const res = await play(`/assets/${id}/v/1/play`);
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const link = new URL(res.headers.get("location")!);
    expect(link.host).toBe("tinyacrobatics.b-cdn.net");
    expect(link.pathname).toMatch(new RegExp(`^/play-copies/review/${id}/\\d+/\\d+\\.mp4$`));
    expect(Number(link.searchParams.get("expires")) - Date.now() / 1000).toBeGreaterThan(23 * 3600);
    expect(link.searchParams.get("token")).toMatch(/^HS256-/);
    // a CORS load (a canvas reading the frames) stays on this server
    expect((await play(`/assets/${id}/v/1/play`, { "sec-fetch-mode": "cors" })).status).toBe(200);
  });

  it("changes nothing without a store: no push, no sweep, /play streams", async () => {
    mountPlugins(new Hono(), []);
    try {
      const id = await up("Tiny Acrobatics open.mp4");
      expect((await play(`/assets/${id}/v/1/play`)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 300));
      await copiesSettled();
      expect(copiesOf(`review/${id}/`)).toHaveLength(0);
    } finally {
      mountPlugins(new Hono(), [cdn]);
    }
  });

  it("streams when the push is refused", async () => {
    refuse = true;
    try {
      const id = await up("Tiny Acrobatics refused.mp4");
      await new Promise((r) => setTimeout(r, 300));
      await copiesSettled();
      expect((await play(`/assets/${id}/v/1/play`)).status).toBe(200);
      expect(copiesOf(`review/${id}/`)).toHaveLength(0);
    } finally {
      refuse = false;
    }
  });

  it("drops the copy at once when a version is removed (cleared, or stacked away)", async () => {
    const a = await up("Tiny Acrobatics a.mp4");
    const b = await up("Tiny Acrobatics b.mp4");
    expect((await pushed(`review/${a}/`)) && (await pushed(`review/${b}/`))).toBe(true);
    await app.request(`/assets/${a}/stack`, json({ from: b }));
    expect(await dropped(`review/${b}/`)).toBe(true); // b's video is gone: its version lives on in a, under a's name
    expect(copiesOf(`review/${a}/`)).toHaveLength(1);
    expect((await app.request(`/assets/${a}/v/2/clear-earlier`, { method: "POST" })).status).toBe(200);
    expect(await dropped(`review/${a}/`)).toBe(true);
    expect(existsSync(path.join(dataDir, "review", a, "v2", "source"))).toBe(true);
  });

  it("drops the copy at once when the video is trashed, and when it is Rejected", async () => {
    const trashed = await up("Tiny Acrobatics trashed.mp4");
    const rejected = await up("Tiny Acrobatics rejected.mp4");
    expect((await pushed(`review/${trashed}/`)) && (await pushed(`review/${rejected}/`))).toBe(true);
    await app.request(`/assets/${trashed}`, { method: "DELETE" });
    expect(await dropped(`review/${trashed}/`)).toBe(true);
    expect((await app.request(`/assets/${rejected}/approval`, json({ status: "rejected" }))).status).toBe(200);
    expect(await dropped(`review/${rejected}/`)).toBe(true);
    expect(existsSync(path.join(dataDir, "review", rejected, "v1", "source"))).toBe(true);
  });

  it("drops the copy when the video is purged", async () => {
    const id = await up("Tiny Acrobatics purged.mp4");
    expect(await pushed(`review/${id}/`)).toBe(true);
    await purgeExpiredReview((owner, at) => owner === "owner" && at > 0);
    expect(await dropped(`review/${id}/`)).toBe(true);
    expect((await heldCopies()).filter((k) => k.includes(id))).toEqual([]);
  });

  it(`sweeps copies past ${COPY_DAYS} days but keeps an approved version's and a Final's; a later play pushes again`, async () => {
    const old = await up("Tiny Acrobatics old.mp4");
    const approved = await up("Tiny Acrobatics approved.mp4");
    const final = await up("Tiny Acrobatics final cut.mp4");
    for (const id of [old, approved, final]) expect(await pushed(`review/${id}/`)).toBe(true);
    expect((await app.request(`/assets/${approved}/approval`, json({ status: "approved" }))).status).toBe(200);
    const d = libraryDb();
    const lib = libraryRow(final)!.library_id;
    d.prepare("INSERT INTO pieces (id, library_id, collection_id, label, created_by, created_at) VALUES ('pc_sweep', ?, ?, 'Sweep', 'owner', 0)").run(lib, finalsCollectionId(lib));
    d.prepare("INSERT INTO piece_items (id, piece_id, version_id, position) VALUES ('pi_sweep', 'pc_sweep', ?, 1)").run((await readMeta(final))!.versions[0]!.versionId!);

    await later(() => sweepPlayCopies());
    expect(copiesOf(`review/${old}/`)).toHaveLength(0);
    expect(copiesOf(`review/${approved}/`)).toHaveLength(1);
    expect(copiesOf(`review/${final}/`)).toHaveLength(1);

    expect((await play(`/assets/${old}/v/1/play`)).status).toBe(200); // streams, and is pushed again
    expect(await pushed(`review/${old}/`)).toBe(true);
    expect((await play(`/assets/${old}/v/1/play`)).status).toBe(302);
  });

  it("pushes a version when it becomes a Final, never footage, and drops it when it leaves Finals or goes", async () => {
    const id = await up("Tiny Acrobatics finals.mp4");
    const versionId = (await readMeta(id))!.versions[0]!.versionId!;
    const media = `/api/library/media/${versionId}/play`;
    expect((await play(media)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    await copiesSettled();
    expect(copiesOf(`library/${versionId}/`)).toHaveLength(0); // not a Final: never pushed

    const d = libraryDb();
    const lib = libraryRow(id)!.library_id;
    d.prepare("INSERT INTO pieces (id, library_id, collection_id, label, created_by, created_at) VALUES ('pc_tiny', ?, ?, 'Tiny', 'owner', 0)").run(lib, finalsCollectionId(lib));
    const added = await read(app.request(`/api/library/${lib}/pieces/pc_tiny/items`, json({ versionId })));
    expect(await pushed(`library/${versionId}/`)).toBe(true); // at once, before a play
    expect((await play(media)).status).toBe(302);
    await later(() => sweepPlayCopies());
    expect(copiesOf(`library/${versionId}/`)).toHaveLength(1); // a Final keeps its copy past the days

    const item = (added.items as { id: string }[])[0]!.id;
    await app.request(`/api/library/${lib}/pieces/pc_tiny/items/${item}`, { method: "DELETE" });
    expect(await dropped(`library/${versionId}/`)).toBe(true);

    await app.request(`/api/library/${lib}/pieces/pc_tiny/items`, json({ versionId }));
    expect(await pushed(`library/${versionId}/`)).toBe(true);
    await deleteAssets([id]);
    expect(copiesOf(`library/${versionId}/`)).toHaveLength(0);
  });
});
