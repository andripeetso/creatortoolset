import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// 11-19: hover frames keep the clip's shape. Strips made before were 16:9 cuts, so an upright clip's hover was a
// squashed middle. The Mac that has the file lists the library's videos whose old strip isn't their shape, makes each
// strip again from the file and hands it in; the old one is served until the new one lands, and it's done once.

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "stray-strips-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { pairDevice } = await import("../lib/devices");
const { stripOf } = await import("./media/sprite");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "user" } as never);
  return next();
});
app.route("/api/library", libraryApp);
libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_s', 'owner-s', 'S', 'local', 0)").run();
const mac = pairDevice("owner-s", "Tiny Mac").device.id;
const other = pairDevice("someone-else", "Their Mac").device.id;

/** The smallest JPEG header with a size (pictures.ts jpegSize reads its frame marker). */
const jpegOf = (w: number, h: number) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]).toString("base64");
const as = (user = "owner-s") => ({ "x-user": user, "content-type": "application/json" });
let n = 0;
/** A video indexed on this Mac with a strip; `old`: as one from before (no frame size noted). */
const index = async (name: string, width: number, height: number, old = true) => {
  const quick = (++n).toString(16).padStart(64, "0");
  const body = { name, path: `/Volumes/Tiny/Source media/${name}`, size: 9_000_000 + n, quick, duration: 12, width, height, frames: [], sprite: jpegOf(160 * 20, 90), device: mac };
  const r = await Promise.resolve(app.request("/api/library/lib_s/on-mac", { method: "POST", headers: as(), body: JSON.stringify(body) }));
  expect(r.status).toBe(200);
  const { versionId } = (await r.json()) as { versionId: string };
  if (old) libraryDb().prepare("UPDATE derivatives SET cell_w = NULL, cell_h = NULL WHERE version_id = ? AND kind = 'sprite'").run(versionId);
  return versionId;
};
const list = async (device = mac, user = "owner-s") => {
  const r = await Promise.resolve(app.request(`/api/library/lib_s/stray-strips?device=${device}`, { headers: as(user) }));
  return { status: r.status, versions: r.ok ? ((await r.json()) as { versions: { versionId: string; path: string }[] }).versions : [] };
};
const put = (versionId: string, sprite: unknown, user = "owner-s") =>
  Promise.resolve(app.request(`/api/library/lib_s/versions/${versionId}/sprite`, { method: "PUT", headers: as(user), body: JSON.stringify({ sprite }) }));
const spriteUrl = async (versionId: string) => {
  const page = (await (await Promise.resolve(app.request("/api/library/lib_s/assets", { headers: as() }))).json()) as { items: { versionId: string; spriteUrl?: string }[] };
  return page.items.find((a) => a.versionId === versionId)?.spriteUrl;
};

describe("old strips that aren't the clip's shape", () => {
  it("lists an upright clip's old strip by this Mac's path; the new one handed in replaces it, with a new address, once", async () => {
    const tall = await index("Cartwheel tall.mov", 1080, 1920);
    const wide = await index("Cartwheel wide.mov", 1920, 1080);
    expect((await list()).versions).toEqual([{ versionId: tall, path: "/Volumes/Tiny/Source media/Cartwheel tall.mov" }]);
    // until then the old strip is the one served, at its old address
    expect(await spriteUrl(tall)).toBe(`/api/library/media/${tall}/sprite`);
    expect(stripOf(libraryDb(), tall)).toEqual({ w: 160, h: 90, frames: 20 });
    expect((await put(tall, jpegOf(144 * 20, 256))).status).toBe(200);
    expect(stripOf(libraryDb(), tall)).toEqual({ w: 144, h: 256, frames: 20 });
    expect(await spriteUrl(tall)).toBe(`/api/library/media/${tall}/sprite?s=144x256`);
    expect((await list()).versions).toEqual([]);
    // the wide one was its own shape: noted as it is, never made again
    expect(stripOf(libraryDb(), wide)).toEqual({ w: 160, h: 90, frames: 20 });
    expect(libraryDb().prepare("SELECT cell_w FROM derivatives WHERE version_id = ? AND kind = 'sprite'").get(wide)).toEqual({ cell_w: 160 });
  });

  it("a strip in the clip's shape is noted with its size as it comes in and never listed; a 16:9 cut that comes in (a Mac app's own index) is", async () => {
    const shaped = await index("Handstand.mov", 1080, 1920, false);
    await put(shaped, jpegOf(144 * 20, 256));
    expect(libraryDb().prepare("SELECT cell_w, cell_h FROM derivatives WHERE version_id = ? AND kind = 'sprite'").get(shaped)).toEqual({ cell_w: 144, cell_h: 256 });
    const cut = await index("Bridge.mov", 1080, 1920, false); // the index's strip is a 160 × 90 cut
    expect(libraryDb().prepare("SELECT cell_w FROM derivatives WHERE version_id = ? AND kind = 'sprite'").get(cut)).toEqual({ cell_w: null });
    const listed = (await list()).versions.map((v) => v.versionId);
    expect(listed).toContain(cut);
    expect(listed).not.toContain(shaped);
  });

  it("only the owner, for a computer of theirs; only a JPEG, for this library's own video", async () => {
    const tall = await index("Roll tall.mov", 720, 1280);
    expect((await list(mac, "stranger")).status).toBe(404);
    expect((await list(other)).status).toBe(404);
    expect((await put(tall, Buffer.from("not a jpeg").toString("base64"))).status).toBe(400);
    expect((await put("ver_not_here", jpegOf(144 * 20, 256))).status).toBe(400);
    expect((await put(tall, jpegOf(144 * 20, 256), "stranger")).status).toBe(404);
    expect(stripOf(libraryDb(), tall)).toEqual({ w: 160, h: 90, frames: 20 });
  });
});
