import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// 11-19: photos indexed in place under Upload none came in grey when the page couldn't decode them (HEIC). This Mac
// lists the library's photos with no picture whose file it has, makes each picture, and hands it in: no re-import.

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "no-picture-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { libraryApp, kindOf } = await import("./routes");
const { pairDevice } = await import("../lib/devices");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "user" } as never);
  return next();
});
app.route("/api/library", libraryApp);
libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_p', 'owner-p', 'P', 'local', 0)").run();
const mac = pairDevice("owner-p", "Tiny Mac").device.id;
const other = pairDevice("someone-else", "Their Mac").device.id;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");
let n = 0;
const index = async (name: string, extra: object = {}) => {
  const quick = (++n).toString(16).padStart(64, "0");
  const r = await Promise.resolve(
    app.request("/api/library/lib_p/on-mac", {
      method: "POST",
      headers: { "x-user": "owner-p", "content-type": "application/json" },
      body: JSON.stringify({ name, path: `/Volumes/Tiny/Source media/${name}`, size: 4_000_000 + n, quick, width: 4032, height: 3024, frames: [], device: mac, ...extra }),
    }),
  );
  expect(r.status).toBe(200);
  return (await r.json()) as { versionId: string };
};
const list = (device: string, user = "owner-p") => app.request(`/api/library/lib_p/no-picture?device=${device}`, { headers: { "x-user": user } });
const put = (versionId: string, thumb: unknown, user = "owner-p") =>
  app.request(`/api/library/lib_p/versions/${versionId}/thumb`, { method: "PUT", headers: { "x-user": user, "content-type": "application/json" }, body: JSON.stringify({ thumb }) });

describe("photos with no picture", () => {
  it("lists this library's photos with no thumbnail by this Mac's path; one handed in fills it", async () => {
    const grey = await index("IMG_0001.HEIC"); // the page couldn't decode it: no thumb
    await index("IMG_0002.JPG", { thumb: JPEG }); // decoded: has one
    const r = await list(mac);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { versions: unknown[] }).versions).toEqual([{ versionId: grey.versionId, path: "/Volumes/Tiny/Source media/IMG_0001.HEIC" }]);
    expect((await put(grey.versionId, JPEG)).status).toBe(200);
    expect(((await (await list(mac)).json()) as { versions: unknown[] }).versions).toEqual([]);
    const page = (await (await app.request("/api/library/lib_p/assets", { headers: { "x-user": "owner-p" } })).json()) as { items: { title: string; thumbUrl?: string }[] };
    expect(page.items.find((a) => a.title.startsWith("IMG_0001"))?.thumbUrl).toContain("/thumb");
  });

  it("only the owner, for a computer of theirs; only a JPEG, for this library's own version", async () => {
    const grey = await index("IMG_0003.HEIC");
    expect((await list(mac, "stranger")).status).toBe(404);
    expect((await list(other)).status).toBe(404);
    expect((await put(grey.versionId, Buffer.from("not a jpeg").toString("base64"))).status).toBe(400);
    expect((await put("ver_not_here", JPEG)).status).toBe(400);
    expect((await put(grey.versionId, JPEG, "stranger")).status).toBe(404);
  });
});

describe("a photo's stored type", () => {
  it("HEIC comes in as image/heic; one stored before as application/octet-stream gets its type with its picture", async () => {
    const mime = (v: string) => (libraryDb().prepare("SELECT mime FROM asset_versions WHERE id = ?").get(v) as { mime: string }).mime;
    const fresh = await index("IMG_0004.HEIC");
    expect(mime(fresh.versionId)).toBe("image/heic");
    const old = await index("IMG_0005.heic");
    libraryDb().prepare("UPDATE asset_versions SET mime = 'application/octet-stream' WHERE id = ?").run(old.versionId);
    expect((await put(old.versionId, JPEG)).status).toBe(200);
    expect(mime(old.versionId)).toBe("image/heic");
  });
});

describe("camera RAW", () => {
  it("indexed in place by a computer it is a photo; uploaded it is refused with one line, before anything is kept", async () => {
    const raw = await index("DSC_0001.DNG");
    const row = libraryDb().prepare("SELECT a.kind, v.mime FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(raw.versionId);
    expect(row).toEqual({ kind: "image", mime: "image/x-adobe-dng" });
    const up = await Promise.resolve(
      app.request("/api/library/lib_p/uploads", { method: "POST", headers: { "x-user": "owner-p", "content-type": "application/json" }, body: JSON.stringify({ filename: "DSC_0002.dng", size: 30_000_000 }) }),
    );
    expect(up.status).toBe(400);
    expect(await up.json()).toEqual({ error: "RAW photos are added from a folder on your computer", code: "invalid" });
    expect(libraryDb().prepare("SELECT COUNT(*) AS n FROM uploads WHERE filename = 'DSC_0002.dng'").get()).toEqual({ n: 0 });
  });
});

describe("what is a photo", () => {
  it("camera RAW and HEIC are photos, so they get a picture like any other", () => {
    for (const f of ["a.DNG", "b.cr2", "c.CR3", "d.arw", "e.nef", "f.raf", "g.rw2", "h.orf", "i.heic", "j.HEIF", "k.jpg", "l.tif"]) expect(kindOf(f)).toBe("image");
    expect(kindOf("m.pdf")).toBe("doc");
  });
});
