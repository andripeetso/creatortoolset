import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-proxies-only-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_DISK_RESERVE_GB = "0";

// the files here are not media: every probe answers a small H.264 video a browser plays as it is (no proxy needed)
vi.mock("./media/probe", async (real) => ({
  ...(await real<typeof import("./media/probe")>()),
  probe: () => Promise.resolve({ duration: 5, width: 1280, height: 720, fps: 30, rotation: 0, format: "mp4", vcodec: "h264", pixFmt: "yuv420p", acodec: "" }),
}));

const { blobs, libraryDb } = await import("./db");
const { libraryApp, mediaFile } = await import("./routes");
const { dropOriginal, tick, LANES } = await import("./worker");
const { readable } = await import("../editor/media");

afterAll(() => {
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  rmSync(dir, { recursive: true, force: true });
});

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: "owner-a", role: "user" } as never);
  return next();
});
app.route("/api/library", libraryApp);

const d = libraryDb();
for (const [id, upload] of [["lib_p", '"proxies"'], ["lib_all", '"all"'], ["lib_none", '"none"'], ["lib_old", "true"]] as const) {
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'owner-a', 'L', 'local', ?, 0)").run(
    id,
    `{"upload":${upload},"proxy":false,"describe":false,"embed":false}`,
  );
}

/** A file uploaded through the routes, sent from /Users/tiny/Movies/<name> on a Mac. Returns its version id. */
async function upload(lib: string, name: string): Promise<string> {
  const body = Buffer.from(`${lib} ${name} original`);
  const post = (url: string, init: RequestInit = {}) => app.request(url, { method: "POST", ...init });
  const init = (await (
    await post(`/api/library/${lib}/uploads`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: name, size: body.length, fromPath: `/Users/tiny/Movies/${name}`, fromDevice: "mac-1" }),
    })
  ).json()) as { id: string };
  await app.request(`/api/library/uploads/${init.id}`, { method: "PATCH", headers: { "upload-offset": "0", "content-length": String(body.length) }, body });
  return ((await (await post(`/api/library/uploads/${init.id}/finish`)).json()) as { versionId: string }).versionId;
}

const version = (id: string) =>
  d.prepare("SELECT source_key, mac_path, mac_device, from_path FROM asset_versions WHERE id = ?").get(id) as {
    source_key: string;
    mac_path: string | null;
    mac_device: string | null;
    from_path: string | null;
  };
const jobs = (id: string) => (d.prepare("SELECT kind FROM jobs WHERE version_id = ? ORDER BY kind").all(id) as { kind: string }[]).map((j) => j.kind);
const files = LANES.find((l) => l.name === "files")!.kinds;

/** Its proxy made (a stand-in file) and every job done, as the worker leaves them. */
async function proxied(id: string): Promise<string> {
  const lib = (d.prepare("SELECT a.library_id AS l FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(id) as { l: string }).l;
  const key = `libraries/${lib}/v/${id}/proxy.mp4`;
  const f = path.join(dir, `${id}-proxy`);
  writeFileSync(f, `${id} proxy`);
  await blobs.put(key, f);
  d.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'proxy', ?, 1)").run(id, key);
  d.prepare("UPDATE jobs SET state = 'done' WHERE version_id = ?").run(id);
  return key;
}

describe("a Media Library whose upload is proxies only", () => {
  it("makes a proxy of an uploaded video whatever the proxy switch says; a library with every file kept does not", async () => {
    const kept = await upload("lib_p", "Handstand.mp4");
    const all = await upload("lib_all", "Handstand.mp4");
    expect(version(kept).from_path).toBe("/Users/tiny/Movies/Handstand.mp4");
    while (await tick(Date.now(), files));
    expect(jobs(kept)).toContain("proxy");
    expect(jobs(all)).not.toContain("proxy");
  });

  it("keeps the original while a step that reads it is still to run, and deletes it once they are done", async () => {
    const id = await upload("lib_p", "Cartwheel.mp4");
    const original = version(id).source_key;
    const proxy = await proxied(id);
    d.prepare("INSERT INTO jobs (library_id, version_id, kind, state) VALUES ('lib_p', ?, 'transcribe', 'queued')").run(id);
    expect(await dropOriginal(id)).toBe(false);
    expect(await blobs.stat(original)).not.toBeNull();

    d.prepare("UPDATE jobs SET state = 'done' WHERE version_id = ?").run(id);
    expect(await dropOriginal(id)).toBe(true);
    expect(await blobs.stat(original)).toBeNull();
    expect(version(id)).toMatchObject({ source_key: proxy, mac_path: "/Users/tiny/Movies/Cartwheel.mp4", mac_device: "mac-1" });
    expect(await dropOriginal(id)).toBe(false); // once
  });

  it("reads the proxy everywhere after: playback, the AI Editor, the steps; a download says the original is on the Mac", async () => {
    const id = await upload("lib_p", "Roll.mp4");
    const proxy = await proxied(id);
    await dropOriginal(id);
    expect(mediaFile(id, "play")).toEqual({ key: proxy, type: "video/mp4" });
    expect(mediaFile(id, "source")).toMatchObject({ onMac: "Mac" });
    const res = await app.request(`/api/library/media/${id}/source`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("on_mac");
    expect(readFileSync(await readable(id, version(id).source_key), "utf8")).toBe(`${id} proxy`);
    // a thumbnail asked for again is made from the proxy (the worker's source), not refused as a file on a Mac
    d.prepare("INSERT INTO jobs (library_id, version_id, kind, state) VALUES ('lib_p', ?, 'thumb', 'queued')").run(id);
    await tick(Date.now(), files);
    expect((d.prepare("SELECT error FROM jobs WHERE version_id = ? AND kind = 'thumb'").get(id) as { error: string | null }).error ?? "").not.toMatch(/on a Mac/);
  });

  it("keeps the proxy that is all the library has of a clip when its proxies are cleared", async () => {
    const { clearProxies } = await import("./space");
    const id = await upload("lib_p", "Bridge.mp4");
    const proxy = await proxied(id);
    await dropOriginal(id);
    await clearProxies("lib_p");
    expect(await blobs.stat(proxy)).not.toBeNull();
  });

  it("keeps pictures and sounds as uploaded, and changes nothing in libraries that keep every file or none", async () => {
    const picture = await upload("lib_p", "Pose.jpg");
    d.prepare("UPDATE assets SET kind = 'image' WHERE current_version_id = ?").run(picture);
    const sound = await upload("lib_p", "Song.mp3");
    const others = [await upload("lib_all", "Split.mp4"), await upload("lib_none", "Split.mp4"), await upload("lib_old", "Split.mp4")];
    for (const id of [picture, sound, ...others]) {
      const original = version(id).source_key;
      await proxied(id);
      expect(await dropOriginal(id)).toBe(false);
      expect(existsSync(await blobs.localCopy(original))).toBe(true);
      expect(version(id).mac_path).toBeNull();
    }
  });
});
