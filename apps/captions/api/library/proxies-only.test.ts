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
const { libraryApp, mediaFile, unproxied } = await import("./routes");
const { afterProbe, dropOriginal, tick, LANES } = await import("./worker");
const { recordDerived } = await import("./derived");
const { measurable, readable } = await import("../editor/media");
const { localFiles, onlyProxy } = await import("../editor/preview");

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
for (const [id, upload] of [["lib_p", '"proxies"'], ["lib_all", '"all"'], ["lib_none", '"none"'], ["lib_old", "true"], ["lib_orig", '"originals"']] as const) {
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'owner-a', 'L', 'local', ?, 0)").run(
    id,
    `{"upload":${upload},"proxy":false,"describe":false,"embed":false}`,
  );
}

/**
 * A file uploaded through the routes, sent from /Users/tiny/Movies/<name> on a Mac. Returns its version id. `placed`: that
 * Mac reports the file where it is (version_places), as its scan does.
 */
async function upload(lib: string, name: string, placed = true, person = false): Promise<string> {
  const body = Buffer.from(`${lib} ${name} original`);
  const post = (url: string, init: RequestInit = {}) => app.request(url, { method: "POST", ...init });
  const init = (await (
    await post(`/api/library/${lib}/uploads`, {
      headers: { "content-type": "application/json" },
      // a person's own file (browser) has no computer behind it; a computer's original is refused under proxies
      body: JSON.stringify({ filename: name, size: body.length, ...(person ? {} : { fromPath: `/Users/tiny/Movies/${name}`, fromDevice: "mac-1" }) }),
    })
  ).json()) as { id: string };
  await app.request(`/api/library/uploads/${init.id}`, { method: "PATCH", headers: { "upload-offset": "0", "content-length": String(body.length) }, body });
  const id = ((await (await post(`/api/library/uploads/${init.id}/finish`)).json()) as { versionId: string }).versionId;
  if (placed && id && !person) d.prepare("INSERT INTO version_places (version_id, device, path, confirmed_at, state) VALUES (?, 'mac-1', ?, ?, 'verified')").run(id, `/Users/tiny/Movies/${name}`, Date.now());
  return id;
}

/**
 * A computer's original the library took before it turned Proxies on (the gate refuses new ones now): its rows and file
 * as the upload left them. `placed`: the Mac reports the file where it is (version_places), as its scan does.
 */
async function held(lib: string, name: string, placed = true): Promise<string> {
  const v = `held-${lib}-${name}`;
  const kind = /\.jpg$/i.test(name) ? "image" : /\.mp3$/i.test(name) ? "audio" : "video";
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, roll) VALUES (?, ?, ?, ?, ?, 'owner-a', 1, 'b')").run(`as-${v}`, lib, kind, name, v);
  d.prepare(
    "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at, from_path, from_device) VALUES (?, ?, 1, ?, 1, ?, ?, 'ready', 'owner-a', 1, ?, 'mac-1')",
  ).run(v, `as-${v}`, `libraries/${lib}/v/${v}/source`, `sha-${v}`, JSON.stringify({ duration: 5, width: 1280, height: 720, fps: 30, rotation: 0, format: "mp4", vcodec: "h264", pixFmt: "yuv420p", acodec: "" }), `/Users/tiny/Movies/${name}`);
  const f = path.join(dir, `${v}-source`);
  writeFileSync(f, `${lib} ${name} original`);
  await blobs.put(`libraries/${lib}/v/${v}/source`, f);
  if (placed) d.prepare("INSERT INTO version_places (version_id, device, path, confirmed_at, state) VALUES (?, 'mac-1', ?, ?, 'verified')").run(v, `/Users/tiny/Movies/${name}`, Date.now());
  return v;
}

const version = (id: string) =>
  d.prepare("SELECT source_key, mac_path, mac_device, from_path FROM asset_versions WHERE id = ?").get(id) as {
    source_key: string;
    mac_path: string | null;
    mac_device: string | null;
    from_path: string | null;
  };
const jobs = (id: string) => (d.prepare("SELECT kind FROM jobs WHERE version_id = ? ORDER BY kind").all(id) as { kind: string }[]).map((j) => j.kind);
// the media steps: pictures (probe, thumb, wave) and files (proxy, sprite, fingerprint) run in their own lanes
const files = LANES.filter((l) => l.name === "pictures" || l.name === "files").flatMap((l) => [...l.kinds]);

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
  // replaced: api/library/proxies-only.test.ts "makes a proxy of an uploaded video whatever the proxy switch says" (UNIFIED-PRD §4.2)
  it("a person's upload keeps its proxy, a computer's original is refused, and a library that keeps every file makes none", async () => {
    const kept = await upload("lib_p", "Handstand.mp4", true, true);
    expect(await upload("lib_p", "Computer.mp4")).toBeUndefined();
    const all = await upload("lib_all", "Handstand.mp4");
    while (await tick(Date.now(), files));
    expect(jobs(kept)).toContain("proxy");
    expect(jobs(all)).not.toContain("proxy");
  });

  // replaced: api/library/proxies-only.test.ts (no test before: a browser original drops, a phone's waits for its computer's copy)
  it("a browser original goes once its proxy is made; a phone's waits for a verified computer copy", async () => {
    const browser = await upload("lib_p", "Browser.mp4", true, true);
    await proxied(browser);
    expect(await dropOriginal(browser)).toBe(true);
    const phone = await upload("lib_p", "Phone.mp4", true, true);
    d.prepare("UPDATE asset_versions SET origin = 'phone' WHERE id = ?").run(phone);
    await proxied(phone);
    expect(await dropOriginal(phone)).toBe(false);
    d.prepare("UPDATE asset_versions SET from_path = ?, from_device = 'mac-1' WHERE id = ?").run("/Users/tiny/Movies/Phone.mp4", phone);
    d.prepare("INSERT INTO version_places (version_id, device, path, confirmed_at, state) VALUES (?, 'mac-1', ?, ?, 'verified')").run(phone, "/Users/tiny/Movies/Phone.mp4", Date.now());
    expect(await dropOriginal(phone)).toBe(true);
  });

  it("keeps the original while a step that reads it is still to run, and deletes it once they are done", async () => {
    const id = await held("lib_p", "Cartwheel.mp4");
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

  it("keeps the original while the Mac it came from has no place for it, or that place is gone", async () => {
    const id = await held("lib_p", "Arch.mp4", false);
    const original = version(id).source_key;
    await proxied(id);
    expect(await dropOriginal(id)).toBe(false);
    expect(await blobs.stat(original)).not.toBeNull();
    d.prepare("INSERT INTO version_places (version_id, device, path, confirmed_at, gone_at, state) VALUES (?, 'mac-1', '/Users/tiny/Movies/Arch.mp4', 1, 2, 'gone')").run(id);
    expect(await dropOriginal(id)).toBe(false);
    d.prepare("UPDATE version_places SET gone_at = NULL, state = 'unchecked' WHERE version_id = ?").run(id);
    // a place not checked yet (a row from before the place states) is not enough: the Mac's scan must read it there
    expect(await dropOriginal(id)).toBe(false);
    d.prepare("UPDATE version_places SET state = 'verified' WHERE version_id = ?").run(id);
    expect(await dropOriginal(id)).toBe(true);
  });

  it("reads the proxy everywhere after: playback, the AI Editor, the steps; a download says the original is on the Mac", async () => {
    const id = await held("lib_p", "Roll.mp4");
    const proxy = await proxied(id);
    await dropOriginal(id);
    expect(mediaFile(id, "play")).toEqual({ key: proxy, type: "video/mp4", what: "proxy" });
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

  it("measures the proxy while the original is still there; the preview and the plug-in steps read the original", async () => {
    const id = await held("lib_p", "Flip.mp4");
    const tl = { sources: { [id]: {} } } as never;
    expect(readFileSync(await measurable(id, version(id).source_key), "utf8")).toBe("lib_p Flip.mp4 original"); // no proxy yet
    await proxied(id);
    expect(readFileSync(await measurable(id, version(id).source_key), "utf8")).toBe(`${id} proxy`);
    expect(readFileSync(await readable(id, version(id).source_key), "utf8")).toBe("lib_p Flip.mp4 original");
    expect(readFileSync((await localFiles(tl, undefined, true))[id]!, "utf8")).toBe("lib_p Flip.mp4 original");
    expect(readFileSync((await localFiles(tl))[id]!, "utf8")).toBe("lib_p Flip.mp4 original");
  });

  it("never hands a plug-in step the proxy once the original is gone; the preview plays it and the export names the original", async () => {
    const id = await held("lib_p", "Pike.mp4");
    await proxied(id);
    await dropOriginal(id);
    const tl = { sources: { [id]: {} } } as never;
    await expect(localFiles(tl)).rejects.toThrow(onlyProxy("Pike"));
    expect(readFileSync((await localFiles(tl, undefined, true))[id]!, "utf8")).toBe(`${id} proxy`);
    expect(readFileSync(await measurable(id, version(id).source_key), "utf8")).toBe(`${id} proxy`);
    const { mediaPaths } = await import("../editor/media");
    const edit = { id: "edit_pike", sources: [id] } as never;
    expect((await mediaPaths(edit, [id])).files[id]).toBe("/Users/tiny/Movies/Pike.mp4");
  });

  it("keeps the proxy that is all the library has of a clip when its proxies are cleared", async () => {
    const { clearProxies } = await import("./space");
    const id = await held("lib_p", "Bridge.mp4");
    const proxy = await proxied(id);
    await dropOriginal(id);
    await clearProxies("lib_p");
    expect(await blobs.stat(proxy)).not.toBeNull();
  });

  it("keeps pictures and sounds as uploaded, and changes nothing in libraries that keep every file or none", async () => {
    const picture = await held("lib_p", "Pose.jpg");
    d.prepare("UPDATE assets SET kind = 'image' WHERE current_version_id = ?").run(picture);
    const sound = await held("lib_p", "Song.mp3");
    // a library that keeps none takes no file a Mac sends of itself (upload-gate.ts)
    const others = [await upload("lib_all", "Split.mp4"), await upload("lib_old", "Split.mp4")];
    for (const id of [picture, sound, ...others]) {
      const original = version(id).source_key;
      await proxied(id);
      expect(await dropOriginal(id)).toBe(false);
      expect(existsSync(await blobs.localCopy(original))).toBe(true);
      expect(version(id).mac_path).toBeNull();
    }
  });
});

describe("a Media Library whose Hosted media is originals only", () => {
  /** A ready video row in `lib` (as an upload leaves it), sent from `from` when given: the worker's input is its probe. */
  const direct = (lib: string, name: string, from?: string): string => {
    const v = `ver-${name}-${lib}`;
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, roll) VALUES (?, ?, 'video', ?, ?, 'owner-a', 1, 'b')").run(`as-${v}`, lib, name, v);
    d.prepare(
      "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at, from_path) VALUES (?, ?, 1, ?, 1, ?, NULL, 'ready', 'owner-a', 1, ?)",
    ).run(v, `as-${v}`, `libraries/${lib}/v/${v}/source`, `sha-${v}`, from ?? null);
    return v;
  };
  /** A version as the worker reads it when its probe is in (afterProbe's input). */
  const shape = (id: string) => ({
    id,
    ...(d.prepare("SELECT a.library_id, a.kind, a.title, v.source_path, v.from_path FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(id) as {
      library_id: string;
      kind: string;
      title: string;
      source_path: string | null;
      from_path: string | null;
    }),
  });
  it("keeps no proxy: none queued or stored for a clip that needs one, though the proxy switch is on; a computer's proxy is dropped", async () => {
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.proxy', json('true')) WHERE id = 'lib_orig'`).run();
    const needs = { duration: 5, width: 3840, height: 2160, fps: 30, rotation: 0, format: "mp4", vcodec: "hevc", pixFmt: "yuv420p", acodec: "" };
    const id = direct("lib_orig", "Handstand.mp4", "/Users/tiny/Movies/Handstand.mp4");
    await afterProbe(d, shape(id), needs, "owner-a");
    expect(jobs(id)).not.toContain("proxy");
    // a control: the same clip in a library that keeps its proxies queues one
    const kept = direct("lib_p", "Handstand.mp4", "/Users/tiny/Movies/Handstand.mp4");
    await afterProbe(d, shape(kept), needs, "owner-a");
    expect(jobs(kept)).toContain("proxy");
    const sent = path.join(dir, "computer-proxy.mp4");
    writeFileSync(sent, "a proxy a computer sent");
    await recordDerived(id, { files: { proxy: sent } } as never, "owner-a");
    expect(d.prepare("SELECT 1 FROM derivatives WHERE version_id = ? AND kind = 'proxy'").get(id)).toBeUndefined();
  });

  it("the backfill queues no proxy either, though the library's proxies are kept in the cloud and the switch is on", () => {
    const needs = { duration: 5, width: 3840, height: 2160, fps: 30, rotation: 0, format: "mp4", vcodec: "hevc", pixFmt: "yuv420p", acodec: "" };
    d.prepare(`UPDATE libraries SET storage_config = ? WHERE id = 'lib_orig'`).run(JSON.stringify({ proxies: { kind: "s3" } }));
    const id = direct("lib_orig", "Backfill.mp4", "/Users/tiny/Movies/Backfill.mp4");
    d.prepare("UPDATE asset_versions SET probe = ? WHERE id = ?").run(JSON.stringify(needs), id);
    expect(unproxied("lib_orig", id)).toEqual([]);
    // a control: the same clip in a library that keeps its proxies is queued by the backfill
    const kept = direct("lib_p", "Backfill.mp4", "/Users/tiny/Movies/Backfill.mp4");
    d.prepare("UPDATE asset_versions SET probe = ? WHERE id = ?").run(JSON.stringify(needs), kept);
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.proxy', json('true')) WHERE id = 'lib_p'`).run();
    expect(unproxied("lib_p", kept)).toEqual([{ id: kept, created_by: "owner-a" }]);
  });
});
