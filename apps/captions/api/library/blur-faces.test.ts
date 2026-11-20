import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// Blur faces (P2.6): with it on, only a blurred render of a clip, and what is cut from it, is stored on or served by the
// server. Tiny Acrobatics films kids: their originals stay on the owner's computers, pictures included.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "blur-faces-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_DISK_RESERVE_GB = "0";
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({
    workspaces: [
      {
        id: "tinyacrobatics",
        name: "Tiny Acrobatics",
        plan: "team",
        createdAt: 0,
        members: [
          { username: "tinyacrobatics", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 },
          { username: "sam", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0, workspaces: ["ws_kids"] },
        ],
      },
    ],
    invites: [],
    spend: {},
  }),
);

const { sessionCookieFor } = await import("../auth");
const { libraryDb } = await import("./db");
const { libraryApp, serveGate, mediaFile } = await import("./routes");
const { shareApp, publicShareApp } = await import("./shares");
const { mayLeave, mayReceive, mayServe, REFUSED_BLUR, BLUR_UPLOADS } = await import("./upload-gate");
const { macFrames, dropHeldCopy, dropMacFrames, noPicture, putThumb } = await import("./on-mac");
const { toCard, CARD } = await import("./query");
const { acceptLibraryFile } = await import("../work/library-package");
const { createUser } = await import("../users");
const { Readable } = await import("node:stream");

createUser("tinyacrobatics", "secret-tiny-acrobatics");
createUser("sam", "secret-sam-acrobatics");
afterAll(() => {
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  rmSync(dir, { recursive: true, force: true });
});

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-as") ?? "tinyacrobatics", role: "user" } as never);
  return next();
});
app.route("/api/library", libraryApp);
app.route("/api/library", shareApp);
app.route("/api/library", publicShareApp);

const d = libraryDb();
const lib = (id: string, settings: Record<string, unknown>) =>
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'tinyacrobatics', 'L', 'local', ?, 0)").run(id, JSON.stringify({ proxy: false, describe: true, embed: false, ...settings }));
// "Blurred" is the stored "proxies"; one library with Blur faces and Upload Off; one without, for the old rules
lib("lib_kids", { upload: "proxies", blurFaces: true, projectId: "ws_kids" });
lib("lib_kids_off", { upload: "none", blurFaces: true });
lib("lib_plain", { upload: "all" });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString("base64");
const json = (body: unknown, who?: string): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", ...(who ? { "x-as": who } : {}) }, body: JSON.stringify(body) });
const onMac = (library: string, name: string, extra: Record<string, unknown> = {}) =>
  app.request(`/api/library/${library}/on-mac`, json({ name, path: `/Volumes/Tiny Footage/${name}`, size: 1000 + name.length, quick: sha(`q:${name}`), thumb: JPEG, sprite: JPEG, frames: [JPEG, JPEG, JPEG, JPEG], ...extra }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const vOf = (assetId: string) => (d.prepare("SELECT current_version_id AS v FROM assets WHERE id = ?").get(assetId) as { v: string }).v;
const pictures = (versionId: string) => (d.prepare("SELECT kind FROM derivatives WHERE version_id = ? ORDER BY kind").all(versionId) as { kind: string }[]).map((r) => r.kind);
/** A computer sends its blurred render of the original with full SHA-256 `of`: start, bytes, finish. The version's id. */
async function sendBlurred(library: string, name: string, bytes: string, of: string): Promise<{ status: number; versionId?: string; assetId?: string }> {
  const r = await app.request(`/api/library/${library}/uploads`, json({ filename: name, size: bytes.length, fromPath: `/Volumes/Tiny Footage/- BLURRED/${name}`, fromDevice: "mac-1", blurredOf: of }));
  if (r.status !== 201) return { status: r.status };
  const { id } = (await r.json()) as { id: string };
  expect((await app.request(`/api/library/uploads/${id}`, { method: "PATCH", headers: { "upload-offset": "0", "content-length": String(bytes.length) }, body: bytes })).status).toBe(204);
  const done = await app.request(`/api/library/uploads/${id}/finish`, { method: "POST" });
  const got = (await done.json()) as { assetId?: string; versionId?: string };
  return { status: done.status, ...got, versionId: got.versionId ?? (got.assetId ? vOf(got.assetId) : undefined) };
}

describe("settings: Blur faces is the owner's, and Upload is Off or Blurred under it", () => {
  it("refuses Originals with Blur faces on, takes Off and Blurred, and a member can't change it", async () => {
    lib("lib_set", { upload: "all" });
    const patch = (settings: Record<string, unknown>, who?: string) =>
      app.request("/api/library/lib_set", { method: "PATCH", headers: { "content-type": "application/json", ...(who ? { "x-as": who } : {}) }, body: JSON.stringify({ settings }) });
    const r = await patch({ blurFaces: true });
    expect(r.status).toBe(400);
    expect((await body(r)).error).toBe(BLUR_UPLOADS);
    expect((await patch({ blurFaces: true, upload: "originals" })).status).toBe(400);
    const on = await patch({ blurFaces: true, upload: "proxies" });
    expect((await body(on)).settings).toMatchObject({ blurFaces: true, upload: "proxies" });
    expect((await patch({ upload: "all" })).status).toBe(400);
    expect((await patch({ upload: "none" })).status).toBe(200);
    expect((await patch({ blurFaces: false }, "sam")).status).toBe(404);
    expect((await body(patch({ blurFaces: false, upload: "all" }))).settings).toMatchObject({ upload: "all" });
  });
});

describe("no route takes an original, a proxy of one, or a picture cut from one", () => {
  it("the rule: refused for every kind of a clip not blurred; a waveform and a description's held stills pass", () => {
    const into = { id: "lib_kids" };
    for (const origin of ["person", "computer", "phone"] as const) {
      expect(mayReceive("original", into, origin)).toMatchObject({ ok: false, body: { message: REFUSED_BLUR } });
      expect(mayReceive("proxy", into, origin).ok).toBe(false);
      expect(mayReceive("derivative", into, origin).ok).toBe(false);
      expect(mayReceive("serving", into, origin).ok).toBe(false);
    }
    expect(mayReceive("data", into, "computer").ok).toBe(true);
    expect(mayReceive("held", into, "computer").ok).toBe(true);
    // a blurred render: a computer's, under Blurred; never a person's or a phone's word, never under Off
    const blurred = { id: "lib_kids", blurredOf: sha("original") };
    expect(mayReceive("original", blurred, "computer").ok).toBe(true);
    expect(mayReceive("original", blurred, "person").ok).toBe(false);
    expect(mayReceive("original", blurred, "phone").ok).toBe(false);
    expect(mayReceive("original", { ...blurred, id: "lib_kids_off" }, "computer").ok).toBe(false);
    // a library without Blur faces keeps its own rules
    expect(mayReceive("original", { id: "lib_plain" }, "person").ok).toBe(true);
    expect(mayLeave("lib_plain", {}).ok).toBe(true);
  });

  it("an upload's start: a browser's, a phone's and a Mac's own file are refused; a send from the Mac never starts", async () => {
    const start = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      app.request("/api/library/lib_kids/uploads", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ filename: "Handstand.mp4", size: 4, ...body }) });
    expect(await (await start({})).json()).toMatchObject({ code: "upload_refused", message: REFUSED_BLUR });
    expect((await start({}, { cookie: sessionCookieFor("tinyacrobatics", true)!, "x-ct-origin": "phone" })).status).toBe(409);
    expect((await start({ fromPath: "/Volumes/Tiny Footage/Handstand.mp4", fromDevice: "mac-1" })).status).toBe(409);
    // the phone's own 720p copy (a proxy of an original) is refused too
    const probe = { duration: 3, width: 1280, height: 720, fps: 30, rotation: 0, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" };
    expect((await start({ quick: sha("q"), proxy: { size: 2, probe, sha256: sha("p") } }, { cookie: sessionCookieFor("tinyacrobatics", true)!, "x-ct-origin": "phone" })).status).toBe(409);
    // a person saying it is blurred is not a computer's blurred render
    expect((await start({ blurredOf: sha("original") })).status).toBe(409);
    expect(d.prepare("SELECT COUNT(*) AS n FROM uploads WHERE library_id = 'lib_kids'").get()).toEqual({ n: 0 });
  });

  it("indexed in place from the Mac: no card picture or strip is kept, the stills wait in memory only, and the card says Not blurred yet", async () => {
    const r = (await (await onMac("lib_kids", "Cartwheel.mov")).json()) as { assetId: string; versionId: string };
    expect(pictures(r.versionId)).toEqual([]);
    expect(existsSync(path.join(dir, "library", "mac-frames", r.versionId))).toBe(false);
    // the description's call gets them, written out for it only, and gone after it
    const stills = await macFrames(r.versionId);
    expect(stills).toHaveLength(4);
    expect(stills.every((s) => !s.startsWith(dir))).toBe(true);
    await dropHeldCopy(r.versionId);
    expect(stills.some((s) => existsSync(s))).toBe(false);
    expect(await macFrames(r.versionId)).toHaveLength(4); // still held for a retry
    await dropMacFrames(r.versionId);
    expect(await macFrames(r.versionId)).toHaveLength(0);
    // a photo's thumbnail handed in later is refused, and no Mac is asked for one
    expect(await putThumb("lib_kids", r.versionId, JPEG)).toBe(false);
    const card = toCard(d.prepare(`SELECT ${CARD} FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE a.id = ?`).get(r.assetId) as never);
    expect(card).toMatchObject({ notBlurred: true });
    expect(card.thumbUrl).toBeUndefined();
    expect(noPicture("lib_kids", "mac-1")).toEqual([]);
  });

  it("a computer's own job files: a card picture, strip or proxy of a clip not blurred is refused; its waveform is taken", async () => {
    const r = (await (await onMac("lib_kids", "Roll.mov")).json()) as { versionId: string };
    const job = Number((d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, held_by) VALUES ('lib_kids', ?, 'send', 'running', 'tinyacrobatics', 'mac-1') RETURNING id").get(r.versionId) as { id: number }).id);
    for (const name of ["thumb", "sprite", "proxy", "original"]) {
      const got = await acceptLibraryFile(job, "mac-1", name, Readable.from([Buffer.from("x")]));
      expect(got, name).toMatchObject({ ok: false, body: { message: REFUSED_BLUR } });
    }
    expect(await acceptLibraryFile(job, "mac-1", "wave", Readable.from([Buffer.from("[1,2]")]))).toBe(true);
  });
});

describe("the blurred master: a version of its original's clip, linked on the full SHA-256", () => {
  it("a blurred render sent after its original is indexed joins that clip as its current version; pictures of it are kept", async () => {
    const ORIG = sha("Backflip original bytes");
    const orig = (await (await onMac("lib_kids", "Backflip.mov", { sha256: ORIG })).json()) as { assetId: string; versionId: string };
    expect(d.prepare("SELECT full_sha256 FROM asset_versions WHERE id = ?").get(orig.versionId)).toEqual({ full_sha256: ORIG });
    const b = await sendBlurred("lib_kids", "Backflip blurred.mp4", "blurred-bytes-1", ORIG);
    expect(b.status).toBe(200);
    const row = d.prepare("SELECT asset_id, blurred_of FROM asset_versions WHERE id = ?").get(b.versionId!) as { asset_id: string; blurred_of: string };
    expect(row).toEqual({ asset_id: orig.assetId, blurred_of: ORIG });
    expect(vOf(orig.assetId)).toBe(b.versionId);
    expect(mayLeave("lib_kids", { versionId: b.versionId! }).ok).toBe(true);
    expect(mayLeave("lib_kids", { versionId: orig.versionId }).ok).toBe(false);
  });

  it("an original indexed after its blurred render files into the render's clip, and the render stays current", async () => {
    const ORIG = sha("Handstand original bytes");
    const b = await sendBlurred("lib_kids", "Handstand blurred.mp4", "blurred-bytes-2", ORIG);
    const asset = (d.prepare("SELECT asset_id FROM asset_versions WHERE id = ?").get(b.versionId!) as { asset_id: string }).asset_id;
    const orig = (await (await onMac("lib_kids", "Handstand.mov", { sha256: ORIG })).json()) as { assetId: string; versionId: string };
    expect(orig.assetId).toBe(asset);
    expect(vOf(asset)).toBe(b.versionId);
    expect(pictures(orig.versionId)).toEqual([]);
  });
});

describe("a member, a share link and the phone get only blurred bytes", () => {
  it("serves the blurred render under Blurred, and nothing of a clip not blurred: not its file, not its picture", async () => {
    const ORIG = sha("Split original bytes");
    const orig = (await (await onMac("lib_kids", "Split.mov", { sha256: ORIG })).json()) as { assetId: string; versionId: string };
    const plain = (await (await onMac("lib_kids", "Bridge.mov")).json()) as { versionId: string };
    const b = await sendBlurred("lib_kids", "Split blurred.mp4", "blurred-bytes-3", ORIG);
    expect((await mayServe({ id: "lib_kids", versionId: b.versionId! }, "original")).ok).toBe(true);
    expect((await serveGate(b.versionId!, "play", mediaFile(b.versionId!, "play")!)).ok).toBe(true);
    for (const v of [orig.versionId, plain.versionId]) {
      for (const kind of ["thumb", "sprite", "play", "source", "proxy"]) expect((await serveGate(v, kind, { key: "k" })).ok, `${v} ${kind}`).toBe(false);
      expect((await mayServe({ id: "lib_kids", versionId: v }, "proxy", { toComputer: true })).ok).toBe(false);
    }
    // under Upload Off not even the blurred render is handed out
    d.prepare("UPDATE asset_versions SET blurred_of = ? WHERE id = ?").run(ORIG, plain.versionId);
    d.prepare("UPDATE assets SET library_id = 'lib_kids_off' WHERE id = (SELECT asset_id FROM asset_versions WHERE id = ?)").run(plain.versionId);
    expect((await mayServe({ id: "lib_kids_off", versionId: plain.versionId }, "original")).ok).toBe(false);
  });

  it("a share link streams the blurred render and refuses the original's picture", async () => {
    const ORIG = sha("Pike original bytes");
    const orig = (await (await onMac("lib_kids", "Pike.mov", { sha256: ORIG })).json()) as { assetId: string; versionId: string };
    const plain = (await (await onMac("lib_kids", "Tuck.mov")).json()) as { assetId: string; versionId: string };
    // a picture of the clip not blurred, as if it were there from before Blur faces was turned on
    d.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'thumb', 'k-old', 1)").run(plain.versionId);
    const b = await sendBlurred("lib_kids", "Pike blurred.mp4", "blurred-bytes-4", ORIG);
    const link = async (assetId: string) => ((await (await app.request("/api/library/lib_kids/shares", json({ target: { kind: "asset", id: assetId }, scope: "download" }))).json()) as { token: string }).token;
    const good = await link(orig.assetId);
    expect((await app.request(`/api/library/s/${good}/media/${b.versionId}/play`)).status).toBe(200);
    const bad = await link(plain.assetId);
    const r = await app.request(`/api/library/s/${bad}/media/${plain.versionId}/thumb`);
    expect(r.status).toBe(409);
    expect((await body(r)).message).toBe(REFUSED_BLUR);
  });
});

describe("after a full ingest the server's disk holds no frame of an original", () => {
  it("walks the library folder: every file kept is a blurred render's, or no picture at all", async () => {
    lib("lib_walk", { upload: "proxies", blurFaces: true });
    const ids: string[] = [];
    for (const name of ["Roll 1.mov", "Roll 2.mov", "Roll 3.mov", "Photo.heic"]) ids.push(((await (await onMac("lib_walk", name)).json()) as { versionId: string }).versionId);
    const ORIG = sha("Walk original");
    await onMac("lib_walk", "Walk.mov", { sha256: ORIG });
    const b = await sendBlurred("lib_walk", "Walk blurred.mp4", "blurred-walk", ORIG);
    const blurred = new Set([b.versionId!]);
    const files: string[] = [];
    const walk = (p: string) => {
      for (const n of readdirSync(p)) {
        const f = path.join(p, n);
        if (statSync(f).isDirectory()) walk(f);
        else files.push(f);
      }
    };
    walk(path.join(dir, "library"));
    const ofWalk = files.filter((f) => f.includes(`${path.sep}lib_walk${path.sep}`) || ids.some((id) => f.includes(id)));
    expect(ofWalk.length).toBeGreaterThan(0); // the blurred render itself
    for (const f of ofWalk) expect([...blurred].some((id) => f.includes(id)), f).toBe(true);
    for (const f of files) for (const id of ids) expect(f.includes(id), f).toBe(false);
  });
});
