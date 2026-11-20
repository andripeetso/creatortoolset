import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

// a workspace of the owner's with two libraries (the newer one has Blur faces), written before anything reads the list
mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
for (const [id, at] of [["ws_kids", 0], ["ws_two", 1]] as const)
  writeFileSync(path.join(dir, "workshop", "projects", `${id}.json`), JSON.stringify({ id, owner: "tinyacrobatics", name: id, createdAt: at, updatedAt: at }));

const { sessionCookieFor } = await import("../auth");
const { libraryDb } = await import("./db");
const { libraryApp, serveGate, mediaFile } = await import("./routes");
const { shareApp, publicShareApp } = await import("./shares");
const { mayLeave, mayReceive, mayServe, REFUSED_BLUR, REFUSED_NOT_BLURRED, BLUR_UPLOADS, workspaceLibrary } = await import("./upload-gate");
const { macFrames, dropHeldCopy, dropMacFrames, noPicture, putSprite, putThumb, strayStrips, holdStills, HELD_STILLS_BYTES, HELD_STILLS_MS } = await import("./on-mac");
const { versionSource } = await import("./access");
const { lightKey } = await import("../editor/reach");
const { useFile } = await import("../assistant-files");
const { pairDevice } = await import("../lib/devices");
const { toCard, CARD } = await import("./query");
const { acceptLibraryFile } = await import("../work/library-package");
const { createUser } = await import("../users");
const { Readable } = await import("node:stream");

createUser("tinyacrobatics", "secret-tiny-acrobatics");
createUser("sam", "secret-sam-acrobatics");
// the owner's own Mac: the only sender whose blurred render counts
const PAIRED = pairDevice("tinyacrobatics", "Tiny Mac");
const MAC = PAIRED.device.id;
/** The computer signs in as itself (its device token): the only way a blurred render is declared. */
const SIGNED = { authorization: `Bearer ${PAIRED.token}` };
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
/** Bytes a route refused as not blurred: the disk walk finds none of them anywhere under the data folder. */
const REFUSED_BYTES: string[] = [];
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString("base64");
const json = (body: unknown, who?: string): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", ...(who ? { "x-as": who } : {}) }, body: JSON.stringify(body) });
const onMac = (library: string, name: string, extra: Record<string, unknown> = {}) =>
  app.request(`/api/library/${library}/on-mac`, json({ name, path: `/Volumes/Tiny Footage/${name}`, size: 1000 + name.length, quick: sha(`q:${name}`), thumb: JPEG, sprite: JPEG, frames: [JPEG, JPEG, JPEG, JPEG], ...extra }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const vOf = (assetId: string) => (d.prepare("SELECT current_version_id AS v FROM assets WHERE id = ?").get(assetId) as { v: string }).v;
const pictures = (versionId: string) => (d.prepare("SELECT kind FROM derivatives WHERE version_id = ? ORDER BY kind").all(versionId) as { kind: string }[]).map((r) => r.kind);
/** A computer (`device`, the owner's Mac by default) sends its blurred render of the original with full SHA-256 `of`: start, bytes, finish. */
async function sendBlurred(library: string, name: string, bytes: string, of: string, device = MAC, signed: Record<string, string> = SIGNED): Promise<{ status: number; versionId?: string; assetId?: string; message?: string }> {
  const start = json({ filename: name, size: bytes.length, fromPath: `/Volumes/Tiny Footage/- BLURRED/${name}`, fromDevice: device, blurredOf: of });
  const r = await app.request(`/api/library/${library}/uploads`, { ...start, headers: { ...(start.headers as Record<string, string>), ...signed } });
  if (r.status !== 201) return { status: r.status, message: (await body(r)).message };
  const { id } = (await r.json()) as { id: string };
  expect((await app.request(`/api/library/uploads/${id}`, { method: "PATCH", headers: { "upload-offset": "0", "content-length": String(bytes.length) }, body: bytes })).status).toBe(204);
  const done = await app.request(`/api/library/uploads/${id}/finish`, { method: "POST" });
  const got = (await done.json()) as { assetId?: string; versionId?: string; message?: string };
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

describe("a blurred render is a computer's own, and never the original's bytes", () => {
  it("refuses blurredOf from a browser or a made-up computer: the upload is an original then", async () => {
    const OF = sha("Lunge original");
    expect(await sendBlurred("lib_kids", "Lunge blurred.mp4", "lunge-blurred", OF, "mac-made-up")).toMatchObject({ status: 409, message: REFUSED_BLUR });
    const r = await app.request("/api/library/lib_kids/uploads", json({ filename: "Lunge blurred.mp4", size: 4, blurredOf: OF }));
    expect((await body(r)).message).toBe(REFUSED_BLUR);
    // the owner's own browser (or a key) naming the real computer, without that computer's own token
    expect(await sendBlurred("lib_kids", "Lunge blurred.mp4", "lunge-blurred", OF, MAC, {})).toMatchObject({ status: 409, message: REFUSED_BLUR });
    // another computer of the account signed in, naming this one
    const second = pairDevice("tinyacrobatics", "Tiny Laptop");
    expect((await sendBlurred("lib_kids", "Lunge blurred.mp4", "lunge-blurred", OF, MAC, { authorization: `Bearer ${second.token}` })).status).toBe(409);
    // a member's own computer, signed in as itself, uploading as that member: not where the originals are kept
    const member = pairDevice("sam", "Sam Mac");
    const r2 = await app.request("/api/library/lib_kids/uploads", {
      method: "POST",
      headers: { "content-type": "application/json", "x-as": "sam", authorization: `Bearer ${member.token}` },
      body: JSON.stringify({ filename: "Lunge blurred.mp4", size: 4, fromPath: "/Volumes/Sam/Lunge blurred.mp4", fromDevice: member.device.id, blurredOf: OF }),
    });
    expect(r2.status).toBe(409);
    expect(d.prepare("SELECT COUNT(*) AS n FROM uploads WHERE library_id = 'lib_kids' AND blurred_of IS NOT NULL").get()).toEqual({ n: 0 });
    // another account's computer is not this account's either
    const other = pairDevice("sam", "Sam Mac").device.id;
    expect((await sendBlurred("lib_kids", "Lunge blurred.mp4", "lunge-blurred", OF, other)).status).toBe(409);
  });

  it("refuses the original sent as its own blurred render, and the bytes of any clip not blurred; nothing of them is kept", async () => {
    const original = "the-original-bytes-of-a-roll";
    const r = await sendBlurred("lib_kids", "Roll blurred.mp4", original, sha(original));
    expect(r).toMatchObject({ status: 409, message: REFUSED_NOT_BLURRED });
    // a clip of the library not blurred (its whole file's SHA-256 known from the Mac), sent as another's blurred render
    const other = "the-bytes-of-another-roll";
    await onMac("lib_kids", "Other.mov", { sha256: sha(other) });
    expect(await sendBlurred("lib_kids", "Other blurred.mp4", other, sha("something else"))).toMatchObject({ status: 409, message: REFUSED_NOT_BLURRED });
    REFUSED_BYTES.push(original, other);
  });
});

describe("saving into the library under Blur faces keeps nothing on the server", () => {
  it("an export, a final and a chat's footage go to the owner's computer (or say why not), never into the server's store", async () => {
    const { saveToLibrary } = await import("./routes");
    const file = path.join(dir, "export.mp4");
    writeFileSync(file, "an-export-of-unblurred-footage");
    const plain = (await (await onMac("lib_kids", "Source.mov")).json()) as { versionId: string };
    const before = (d.prepare("SELECT COUNT(*) AS n FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = 'lib_kids' AND v.source_key NOT LIKE 'mac:%'").get() as { n: number }).n;
    // exports.ts (its sources), library/finals.ts (a final), the studio editor's footageToLibrary (a chat's footage)
    for (const [sources, footage, opts] of [[[plain.versionId], false, {}], [[], false, { finals: true }], [[], true, {}]] as const) {
      const r = await saveToLibrary("tinyacrobatics", file, "Export.mp4", [...sources], "lib_kids", footage, undefined, opts);
      expect(r && "error" in r ? r.code : r, JSON.stringify(r)).toMatch(/^(no_folder|no_computer)$/);
    }
    REFUSED_BYTES.push("an-export-of-unblurred-footage");
    expect((d.prepare("SELECT COUNT(*) AS n FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = 'lib_kids' AND v.source_key NOT LIKE 'mac:%'").get() as { n: number }).n).toBe(before);
    rmSync(file);
  });
});

describe("the public AI Editor under Blur faces", () => {
  it("renders no preview for the server: it blurs no face", async () => {
    const { previewStep } = await import("../editor/preview");
    const edit = { id: "e_blur", workspaceId: "tinyacrobatics", createdBy: "tinyacrobatics", projectId: "ws_kids" } as never;
    await expect(previewStep({ edit, job: {} as never, variant: "V1", signal: new AbortController().signal })).rejects.toThrow(REFUSED_BLUR);
  });
});

describe("the workspace's library is the one with Blur faces on", () => {
  it("picks the newer library with Blur faces over the older one without", async () => {
    d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_two_old', 'tinyacrobatics', 'L', 'local', ?, 1)").run(JSON.stringify({ projectId: "ws_two", upload: "all" }));
    d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_two_new', 'tinyacrobatics', 'L', 'local', ?, 2)").run(JSON.stringify({ projectId: "ws_two", upload: "none", blurFaces: true }));
    expect(await workspaceLibrary("tinyacrobatics", "ws_two")).toBe("lib_two_new");
    expect(mayLeave(await workspaceLibrary("tinyacrobatics", "ws_two"), { blurred: false }).ok).toBe(false);
  });
});

describe("files stored before Blur faces was turned on stay, and leave no more", () => {
  it("a held copy and its proxy go to no computer and to Caption Studio; the server cuts no new proxy of it", async () => {
    lib("lib_late", { upload: "all", proxy: true });
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('a_late', 'lib_late', 'video', 'Late', 'v_late', 'tinyacrobatics', 0)").run();
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, probe) VALUES ('v_late', 'a_late', 1, 'k-late', 9, 'h', 'ready', 'tinyacrobatics', 0, ?)").run(JSON.stringify({ duration: 3, width: 3840, height: 2160, vcodec: "hevc", pixFmt: "yuv420p10le" }));
    d.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES ('v_late', 'proxy', 'k-late-proxy', 1)").run();
    const row = { id: "v_late", source_key: "k-late", source_path: null, mac_path: null, mac_device: null, proxy: "k-late-proxy", library_id: "lib_late" };
    expect(lightKey(row)).toBe("k-late-proxy");
    d.prepare("UPDATE libraries SET settings = json_set(settings, '$.blurFaces', json('true'), '$.upload', 'proxies') WHERE id = 'lib_late'").run();
    expect(lightKey(row)).toBeNull();
    expect(await versionSource("tinyacrobatics", "v_late")).toBeNull();
    expect((await serveGate("v_late", "proxy", { key: "k-late-proxy", what: "proxy" })).ok).toBe(false);
    // still stored: deleting them is the owner's call
    expect(d.prepare("SELECT storage_key FROM derivatives WHERE version_id = 'v_late'").get()).toEqual({ storage_key: "k-late-proxy" });
  });
});

describe("a strip made again on the Mac (an old 16:9 strip)", () => {
  it("is not asked for, nor kept, for a clip not blurred: its old strip stays stored and is not served", async () => {
    lib("lib_strips", { upload: "all" });
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('a_strip', 'lib_strips', 'video', 'Strip', 'v_strip', 'tinyacrobatics', 0)").run();
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, probe, mac_path, mac_device) VALUES ('v_strip', 'a_strip', 1, 'mac:v_strip', 9, 'h', 'ready', 'tinyacrobatics', 0, ?, '/Volumes/Tiny Footage/Strip.mov', ?)").run(JSON.stringify({ duration: 3, width: 1080, height: 1920 }), MAC);
    d.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES ('v_strip', 'sprite', 'k-old-strip', 1)").run();
    expect(strayStrips("lib_strips", MAC).map((x) => x.versionId)).toEqual(["v_strip"]);
    d.prepare("UPDATE libraries SET settings = json_set(settings, '$.blurFaces', json('true'), '$.upload', 'proxies') WHERE id = 'lib_strips'").run();
    expect(strayStrips("lib_strips", MAC)).toEqual([]);
    expect(await putSprite("lib_strips", "v_strip", JPEG)).toBe(false);
    expect(d.prepare("SELECT storage_key FROM derivatives WHERE version_id = 'v_strip' AND kind = 'sprite'").get()).toEqual({ storage_key: "k-old-strip" });
  });
});

describe("the chat dock under Blur faces", () => {
  it("makes no Caption Studio project or Video Note of a dropped file", async () => {
    const id = "0b5e7f3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    const at = path.join(dir, "assistant", "files", "tinyacrobatics", id);
    mkdirSync(at, { recursive: true });
    writeFileSync(path.join(at, "file"), "chat-drop-original");
    writeFileSync(path.join(at, "meta.json"), JSON.stringify({ id, name: "Drop.mov", mime: "video/quicktime", size: 18, at: Date.now() }));
    const user = { username: "tinyacrobatics", role: "user", cloud: false, off: [] } as never;
    for (const to of ["captions", "notes"] as const) await expect(useFile(user, id, to)).rejects.toThrow(REFUSED_BLUR);
  });
});

describe("held stills", () => {
  it("are dropped oldest first past their size, and after their time", async () => {
    const big = Buffer.alloc(HELD_STILLS_BYTES / 3);
    holdStills("v_h1", [big], 0);
    holdStills("v_h2", [big], 1);
    holdStills("v_h3", [big], 2);
    holdStills("v_h4", [big], 3); // past the size: v_h1 goes
    expect(await macFrames("v_h1")).toEqual([]);
    expect(await macFrames("v_h2")).toHaveLength(0); // expired by now (held at t=1)
    holdStills("v_h5", [Buffer.from(JPEG, "base64")]);
    expect(await macFrames("v_h5")).toHaveLength(1);
    await dropMacFrames("v_h5");
    expect(HELD_STILLS_MS).toBeGreaterThan(0);
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
    // the whole data folder (the library, the chat's files, the AI Editor's, Review's): no refused original's bytes, and
    // no file named for a clip not blurred
    const all: string[] = [];
    const walkAll = (p: string) => {
      for (const n of readdirSync(p)) {
        const f = path.join(p, n);
        if (statSync(f).isDirectory()) walkAll(f);
        else all.push(f);
      }
    };
    walkAll(dir);
    const refused = new Set(REFUSED_BYTES.map(sha));
    for (const f of all) {
      if (f.endsWith(".db") || f.endsWith(".db-wal") || f.endsWith(".db-shm")) continue;
      expect(refused.has(createHash("sha256").update(readFileSync(f)).digest("hex")), f).toBe(false);
      for (const id of ids) expect(f.includes(id), f).toBe(false);
    }
  });
});
