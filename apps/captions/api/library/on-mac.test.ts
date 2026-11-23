import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-on-mac-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { framesDir, parseOnMac } = await import("./on-mac");
const { spaceApp } = await import("./space");
const { tick } = await import("./worker");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "user" } as never);
  return next();
});
app.route("/api/library", libraryApp);
app.route("/api/library", spaceApp);
const post = (body: unknown, user = "owner-a") =>
  Promise.resolve(app.request("/api/library/lib_a/on-mac", { method: "POST", headers: { "x-user": user, "content-type": "application/json" }, body: JSON.stringify(body) }));

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");
const quick = "a".repeat(64);
const clip = { name: "Tiny Acrobatics gameplay.mp4", path: "/Volumes/Tiny Drive/FOOTAGE/Tiny Acrobatics gameplay.mp4", size: 2_500_000_000, quick, duration: 1200, width: 1920, height: 1080, thumb: JPEG, sprite: JPEG, frames: [JPEG, JPEG, JPEG, JPEG] };

beforeAll(() => {
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'owner-a', 'A', 'local', 0)").run();
});

describe("parseOnMac", () => {
  it("takes only JPEG pictures, a full path and a media file", () => {
    expect(parseOnMac({ ...clip, thumb: Buffer.from("not a jpeg").toString("base64") })).toMatch(/thumb/);
    expect(parseOnMac({ ...clip, path: "FOOTAGE/a.mp4" })).toBe("Not a full path");
    expect(parseOnMac({ ...clip, path: "/Volumes/x/../etc/a.mp4" })).toBe("Not a full path");
    expect(parseOnMac({ ...clip, name: "notes.txt" })).toMatch(/Only videos/);
    expect(parseOnMac(clip)).toMatchObject({ name: clip.name, size: clip.size, frames: [JPEG, JPEG, JPEG, JPEG] });
  });
});

describe("POST /api/library/:id/on-mac", () => {
  it("records the file where it is on the Mac: ready at once, its pictures, its description and transcript queued, nothing read here", async () => {
    const r = await post(clip);
    expect(r.status).toBe(200);
    const { assetId, versionId } = (await r.json()) as { assetId: string; versionId: string };
    const d = libraryDb();
    const v = d.prepare("SELECT state, source_key, source_path, mac_path, sha256, quick, probe FROM asset_versions WHERE id = ?").get(versionId) as Record<string, string | null>;
    expect(v).toMatchObject({ state: "ready", source_key: `mac:${versionId}`, source_path: null, mac_path: clip.path, sha256: `mac:${quick}`, quick });
    expect(JSON.parse(v.probe!)).toMatchObject({ duration: 1200, width: 1920, height: 1080 });
    expect((d.prepare("SELECT kind FROM derivatives WHERE version_id = ? ORDER BY kind").all(versionId) as { kind: string }[]).map((x) => x.kind)).toEqual(["sprite", "thumb"]);
    expect((d.prepare("SELECT kind FROM jobs WHERE version_id = ? ORDER BY kind").all(versionId) as { kind: string }[]).map((x) => x.kind)).toEqual(["describe", "transcribe"]);
    // its transcript is made on that Mac from the file where it is (worker.ts): with no speech model or key it waits for
    // one, never fails as a file this server lacks
    expect(await tick(Date.now(), ["transcribe"])).toBe(true);
    expect(d.prepare("SELECT state FROM jobs WHERE version_id = ? AND kind = 'transcribe'").get(versionId)).toEqual({ state: "needs_key" });
    expect(existsSync(path.join(framesDir(versionId), "3.jpg"))).toBe(true);
    // its card says where it is: the drive's name
    const page = (await (await app.request("/api/library/lib_a/assets", { headers: { "x-user": "owner-a" } })).json()) as { items: { id: string; onMac?: string }[] };
    expect(page.items.find((a) => a.id === assetId)?.onMac).toBe("Tiny Drive");
    const space = (await (await app.request("/api/library/lib_a/space", { headers: { "x-user": "owner-a" } })).json()) as { videos: unknown };
    expect(space.videos).toEqual({ onMac: 1, inPlace: 0, stored: { files: 0, bytes: 0 } });
  });

  it("answers duplicateOf for the same fingerprint, or the same path and size", async () => {
    const again = (await (await post({ ...clip, name: "copy.mp4", path: "/Users/me/copy.mp4" })).json()) as { duplicateOf?: string };
    expect(again.duplicateOf).toBeTruthy();
    const moved = (await (await post({ ...clip, quick: "b".repeat(64) })).json()) as { duplicateOf?: string };
    expect(moved.duplicateOf).toBe(again.duplicateOf);
  });

  it("is refused to someone who isn't in the library", async () => {
    expect((await post({ ...clip, quick: "c".repeat(64) }, "stranger")).status).toBe(404);
  });
});

describe("a file marked Blur faces, indexed on its Mac", () => {
  it("is handed to Face Blur, and gets no plain proxy: its blurred copy is the proxy (docs/face-blur-intake-prd.md)", async () => {
    const { indexOnMac } = await import("./on-mac");
    const { pairDevice } = await import("../lib/devices");
    const { onEvent } = await import("../lib/events");
    libraryDb()
      .prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_blur', 'owner-a', 'B', 'local', ?, 0)")
      .run(JSON.stringify({ upload: "none", blurFaces: true, proxy: true, describe: false, transcribe: false }));
    const mac = pairDevice("owner-a", "Tiny Mac").device;
    const heard: string[] = [];
    onEvent("library.version.blur", (e) => heard.push(e.versionId));
    const proxyOf = (versionId: string) => libraryDb().prepare("SELECT 1 FROM jobs WHERE version_id = ? AND kind = 'proxy'").get(versionId);
    const at = (n: number) => ({ ...clip, name: `take-${n}.mp4`, path: `/Volumes/Tiny Drive/FOOTAGE/take-${n}.mp4`, quick: String(n).repeat(64).slice(0, 64), device: mac.id, frames: [] });
    const yes = await indexOnMac("lib_blur", "owner-a", { ...at(1), blur: "yes" });
    if (!("versionId" in yes)) throw new Error("not indexed");
    expect(heard).toEqual([yes.versionId]);
    expect(proxyOf(yes.versionId)).toBeUndefined();
    // kept as filmed: as any file, its proxy made on that Mac
    const no = await indexOnMac("lib_blur", "owner-a", { ...at(2), blur: "no" });
    if (!("versionId" in no)) throw new Error("not indexed");
    expect(heard).toEqual([yes.versionId]);
    expect(proxyOf(no.versionId)).toBeTruthy();
  });
});
