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
const { fileBlur, keepsOnlyOriginals, libraryDb, playOf, versionUpload } = await import("./db");
const { libraryApp, serveGate, mediaFile } = await import("./routes");
const { shareApp, publicShareApp } = await import("./shares");
const { blurAtIntake, mayGoPublic, mayKeepAsFilmed, mayLeave, mayReceive, mayServe, REFUSED_BLUR, REFUSED_COPY, REFUSED_NO_MAIN, REFUSED_NOT_BLURRED, workspaceLibrary } = await import("./upload-gate");
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

describe("settings: Blur faces is the owner's, and Originals never crosses its switch", () => {
  it("a flip drops the Originals part unless the save names an Upload; under it Blurred (stored originals) and Proxies mix freely; a member can't change it", async () => {
    lib("lib_set", { upload: "all" });
    const patch = (settings: Record<string, unknown>, who?: string) =>
      app.request("/api/library/lib_set", { method: "PATCH", headers: { "content-type": "application/json", ...(who ? { "x-as": who } : {}) }, body: JSON.stringify({ settings }) });
    // on with no Upload named: Originals does not become Blurred by itself, Proxies stays
    expect((await body(await patch({ blurFaces: true }))).settings).toMatchObject({ blurFaces: true, upload: "proxies" });
    for (const upload of ["originals", "all", "none", "proxies"]) expect((await body(await patch({ upload }))).settings, upload).toMatchObject({ upload });
    expect((await patch({ blurFaces: false }, "sam")).status).toBe(404);
    // off with no Upload named: Blurred does not become Originals
    await patch({ upload: "all" });
    const off = (await body(await patch({ blurFaces: false }))).settings;
    expect([!!off.blurFaces, off.upload]).toEqual([false, "proxies"]);
    // a save that names its Upload is taken as said
    expect((await body(await patch({ blurFaces: true, upload: "originals" }))).settings).toMatchObject({ blurFaces: true, upload: "originals" });
    expect((await body(await patch({ blurFaces: false, upload: "all" }))).settings).toMatchObject({ upload: "all" });
  });
});

describe("no route takes an original, a proxy of one, or a picture cut from one", () => {
  it("the rule: refused for every kind of a clip not blurred, but a phone's or a browser's original, which is held (held.test.ts); a waveform and a description's held stills pass", () => {
    const into = { id: "lib_kids" };
    expect(mayReceive("original", into, "computer")).toMatchObject({ ok: false, body: { message: REFUSED_BLUR } });
    for (const origin of ["person", "computer", "phone"] as const) {
      // a file to blur from a phone or a browser is taken and held for the main computer; a smaller copy of one never
      expect(mayReceive("original", into, origin).ok).toBe(origin !== "computer");
      expect(mayReceive("proxy", into, origin).ok).toBe(false);
      expect(mayReceive("derivative", into, origin).ok).toBe(false);
      expect(mayReceive("serving", into, origin).ok).toBe(false);
    }
    expect(mayReceive("data", into, "computer").ok).toBe(true);
    expect(mayReceive("held", into, "computer").ok).toBe(true);
    // a blurred render: a computer's, under Blurred; never a person's or a phone's word (theirs is an original, held), never under Off
    const blurred = { id: "lib_kids", blurredOf: sha("original") };
    expect(mayReceive("original", blurred, "computer").ok).toBe(true);
    expect(mayReceive("proxy", blurred, "person").ok).toBe(false);
    expect(mayReceive("proxy", blurred, "phone")).toMatchObject({ ok: false, body: { message: REFUSED_COPY } });
    expect(mayReceive("original", { ...blurred, id: "lib_kids_off" }, "computer").ok).toBe(false);
    // a library without Blur faces keeps its own rules
    expect(mayReceive("original", { id: "lib_plain" }, "person").ok).toBe(true);
    expect(mayLeave("lib_plain", {}).ok).toBe(true);
  });

  it("an upload's start: a Mac's own file and a smaller copy are refused, and with no main computer to blur it a browser's and a phone's too", async () => {
    const start = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      app.request("/api/library/lib_kids/uploads", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ filename: "Handstand.mp4", size: 4, ...body }) });
    // no computer of the owner's has a Source media folder for this library: nowhere to blur it, so nothing is held
    expect(await (await start({})).json()).toMatchObject({ code: "upload_refused", message: REFUSED_NO_MAIN });
    expect(await (await start({}, { cookie: sessionCookieFor("tinyacrobatics", true)!, "x-ct-origin": "phone" })).json()).toMatchObject({ code: "upload_refused", message: REFUSED_NO_MAIN });
    expect(await (await start({ fromPath: "/Volumes/Tiny Footage/Handstand.mp4", fromDevice: "mac-1" })).json()).toMatchObject({ code: "upload_refused", message: REFUSED_BLUR });
    // the phone's own 720p copy (a proxy of an original) is refused too: the master is the original
    const probe = { duration: 3, width: 1280, height: 720, fps: 30, rotation: 0, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" };
    expect(await (await start({ quick: sha("q"), proxy: { size: 9, probe, sha256: sha("p") } }, { cookie: sessionCookieFor("tinyacrobatics", true)!, "x-ct-origin": "phone" })).json()).toMatchObject({ code: "upload_refused", message: REFUSED_COPY });
    // a person saying it is blurred is not a computer's blurred render: an original like any other
    expect(await (await start({ blurredOf: sha("original") })).json()).toMatchObject({ code: "upload_refused", message: REFUSED_NO_MAIN });
    expect(d.prepare("SELECT COUNT(*) AS n FROM uploads WHERE library_id = 'lib_kids'").get()).toEqual({ n: 0 });
  });

  it("indexed in place from the Mac: its card picture and strip are kept (owner, 2026-11-24), the stills wait in memory only, and the card says Not blurred yet", async () => {
    const r = (await (await onMac("lib_kids", "Cartwheel.mov")).json()) as { assetId: string; versionId: string };
    expect(pictures(r.versionId)).toEqual(["sprite", "thumb"]);
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
    // a card picture handed in later is taken too
    expect(await putThumb("lib_kids", r.versionId, JPEG)).toBe(true);
    const card = toCard(d.prepare(`SELECT ${CARD} FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE a.id = ?`).get(r.assetId) as never);
    expect(card).toMatchObject({ notBlurred: true });
    expect(card.thumbUrl).toBeDefined();
    expect(noPicture("lib_kids", "mac-1")).toEqual([]);
  });

  it("a computer's own job files: a proxy or original of a clip not blurred is refused; its card picture, strip and waveform are taken", async () => {
    const r = (await (await onMac("lib_kids", "Roll.mov")).json()) as { versionId: string };
    const job = Number((d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, held_by) VALUES ('lib_kids', ?, 'send', 'running', 'tinyacrobatics', 'mac-1') RETURNING id").get(r.versionId) as { id: number }).id);
    for (const name of ["proxy", "original"]) {
      const got = await acceptLibraryFile(job, "mac-1", name, Readable.from([Buffer.from("x")]));
      expect(got, name).toMatchObject({ ok: false, body: { message: REFUSED_BLUR } });
    }
    for (const name of ["wave", "thumb", "sprite"]) expect(await acceptLibraryFile(job, "mac-1", name, Readable.from([Buffer.from(name === "wave" ? "[1,2]" : "x")])), name).toBe(true);
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
    // the clip window tells the blurred copy from its original (Blurred | Original, ClipPanel.tsx)
    const { assetDetail } = await import("./search");
    const versions = assetDetail("lib_kids", orig.assetId, { role: "admin" })!.versions;
    expect(versions.map((v) => [v.id, !!v.blurred, v.of])).toEqual([[b.versionId, true, orig.versionId], [orig.versionId, false, undefined]]);
  });

  it("an original indexed after its blurred render files into the render's clip, and the render stays current", async () => {
    const ORIG = sha("Handstand original bytes");
    const b = await sendBlurred("lib_kids", "Handstand blurred.mp4", "blurred-bytes-2", ORIG);
    const asset = (d.prepare("SELECT asset_id FROM asset_versions WHERE id = ?").get(b.versionId!) as { asset_id: string }).asset_id;
    const orig = (await (await onMac("lib_kids", "Handstand.mov", { sha256: ORIG })).json()) as { assetId: string; versionId: string };
    expect(orig.assetId).toBe(asset);
    expect(vOf(asset)).toBe(b.versionId);
    expect(pictures(orig.versionId).filter((k) => k !== "thumb" && k !== "sprite")).toEqual([]);
  });
});

describe("a member, a share link and the phone get only blurred bytes", () => {
  it("serves the blurred render under Blurred, and of a clip not blurred only its card picture and strip", async () => {
    const ORIG = sha("Split original bytes");
    const orig = (await (await onMac("lib_kids", "Split.mov", { sha256: ORIG })).json()) as { assetId: string; versionId: string };
    const plain = (await (await onMac("lib_kids", "Bridge.mov")).json()) as { versionId: string };
    const b = await sendBlurred("lib_kids", "Split blurred.mp4", "blurred-bytes-3", ORIG);
    expect((await mayServe({ id: "lib_kids", versionId: b.versionId! }, "original")).ok).toBe(true);
    expect((await serveGate(b.versionId!, "play", mediaFile(b.versionId!, "play")!)).ok).toBe(true);
    for (const v of [orig.versionId, plain.versionId]) {
      for (const kind of ["play", "source", "proxy"]) expect((await serveGate(v, kind, { key: "k" })).ok, `${v} ${kind}`).toBe(false);
      for (const kind of ["thumb", "sprite"]) expect((await serveGate(v, kind, { key: "k" })).ok, `${v} ${kind}`).toBe(true);
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
    d.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'thumb', 'k-old', 1)").run(plain.versionId);
    const b = await sendBlurred("lib_kids", "Pike blurred.mp4", "blurred-bytes-4", ORIG);
    const link = async (assetId: string) => ((await (await app.request("/api/library/lib_kids/shares", json({ target: { kind: "asset", id: assetId }, scope: "download" }))).json()) as { token: string }).token;
    const good = await link(orig.assetId);
    expect((await app.request(`/api/library/s/${good}/media/${b.versionId}/play`)).status).toBe(200);
    const bad = await link(plain.assetId);
    // not in the link at all, and none of its pictures or files
    expect((await body(app.request(`/api/library/s/${bad}`))).items).toEqual([]);
    for (const kind of ["thumb", "play", "source"]) expect((await app.request(`/api/library/s/${bad}/media/${plain.versionId}/${kind}`)).status).not.toBe(200);
  });

  it("a share link never holds a file kept as filmed: the team sees it, the public does not", async () => {
    const kept = (await body(onMac("lib_kids", "Kept talk.mov", { blur: false }))) as { assetId: string; versionId: string };
    d.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'thumb', 'k-kept', 1)").run(kept.versionId);
    expect(mayLeave("lib_kids", { versionId: kept.versionId }).ok).toBe(true); // the team's
    expect(mayGoPublic(kept.versionId).ok).toBe(false);
    const token = ((await body(app.request("/api/library/lib_kids/shares", json({ target: { kind: "asset", id: kept.assetId }, scope: "download" })))) as { token: string }).token;
    expect((await body(app.request(`/api/library/s/${token}`))).items).toEqual([]);
    for (const kind of ["thumb", "play", "proxy", "source"]) expect((await app.request(`/api/library/s/${token}/media/${kept.versionId}/${kind}`)).status, kind).not.toBe(200);
    // where Blur faces is off it is a file like any other
    const plainLib = (await body(onMac("lib_plain", "Plain talk.mov"))) as { versionId: string };
    expect(mayGoPublic(plainLib.versionId).ok).toBe(true);
  });
});

describe("a blurred render is a computer's own, and never the original's bytes", () => {
  it("refuses blurredOf from a browser or a made-up computer: the upload is an original then", async () => {
    const OF = sha("Lunge original");
    expect(await sendBlurred("lib_kids", "Lunge blurred.mp4", "lunge-blurred", OF, "mac-made-up")).toMatchObject({ status: 409, message: REFUSED_BLUR });
    const r = await app.request("/api/library/lib_kids/uploads", json({ filename: "Lunge blurred.mp4", size: 4, blurredOf: OF }));
    expect((await body(r)).message).toBe(REFUSED_NO_MAIN); // an original, held where a main computer can blur it; here there is none
    // the owner's own browser (or a key) naming the real computer, without that computer's own token
    expect(await sendBlurred("lib_kids", "Lunge blurred.mp4", "lunge-blurred", OF, MAC, {})).toMatchObject({ status: 409, message: REFUSED_BLUR });
    // another computer of the account signed in, naming this one
    const second = pairDevice("tinyacrobatics", "Tiny Laptop");
    expect((await sendBlurred("lib_kids", "Lunge blurred.mp4", "lunge-blurred", OF, MAC, { authorization: `Bearer ${second.token}` })).status).toBe(409);
    // a member's own computer, signed in as itself, uploading as that member: not where the originals are kept
    const member = pairDevice("sam", "Sam Mac");
    const declared = () => d.prepare("SELECT COUNT(*) AS n FROM uploads WHERE library_id = 'lib_kids' AND blurred_of IS NOT NULL").get();
    const before = declared();
    const r2 = await app.request("/api/library/lib_kids/uploads", {
      method: "POST",
      headers: { "content-type": "application/json", "x-as": "sam", authorization: `Bearer ${member.token}` },
      body: JSON.stringify({ filename: "Lunge blurred.mp4", size: 4, fromPath: "/Volumes/Sam/Lunge blurred.mp4", fromDevice: member.device.id, blurredOf: OF }),
    });
    expect([404, 409]).toContain(r2.status); // refused before or at the gate: a member's add is never this computer's
    expect(declared()).toEqual(before);
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

describe("the public AI Editor follows each source's blur answer", () => {
  it("waits for a yes-file's blurred render, then reads that in its place; a file kept as filmed plays as filmed", async () => {
    const { createEdit } = await import("../editor/store");
    const { editLeaves } = await import("../editor/preview");
    const { editFiles } = await import("../editor/reach");
    const ORIG = sha("Editor original bytes");
    const yes = (await body(onMac("lib_kids", "Editor take.mov", { sha256: ORIG }))) as { assetId: string; versionId: string };
    const no = (await body(onMac("lib_kids", "Editor talk.mov", { blur: false }))) as { assetId: string; versionId: string };
    const e = (await createEdit("tinyacrobatics", { name: "Tiny Acrobatics cut", sources: [yes.versionId, no.versionId] }, false, "ws_kids"))!;
    expect(e).toBeTruthy();
    expect(editLeaves(e.id, "")).toMatchObject({ ok: false, body: { message: "Waiting for blur on Editor take" } });
    // nothing of the yes-original goes to a computer: the step's package is refused before any path is in it
    const { buildPackage } = await import("../work/package");
    const job = { id: 1, kind: "preview", version_id: `${e.id}:`, actor: "tinyacrobatics", state: "running" } as never;
    await expect(buildPackage(job, { id: MAC, owner: "tinyacrobatics" })).rejects.toThrow("Waiting for blur on Editor take");
    // a cut filed now is refused by Review (Blur faces is on in its workspace)
    const { fileInReview, previewFile } = await import("../editor/preview");
    const empty = { name: "Speaker", items: [] };
    const TIMELINE = { name: "v1", fps: 25, width: 1080, height: 1920, sources: {}, tracks: { V1: empty, V2: empty, A1: empty, A2: empty, A3: empty }, markers: [] } as never;
    const file = async () => {
      mkdirSync(path.dirname(previewFile(e.id, "")), { recursive: true });
      writeFileSync(previewFile(e.id, ""), "a-rendered-cut");
    };
    await file();
    await expect(fileInReview(e, "", TIMELINE)).rejects.toThrow(REFUSED_BLUR);
    const b = await sendBlurred("lib_kids", "Editor take blurred.mp4", "editor-blurred-bytes", ORIG);
    expect(editLeaves(e.id, "").ok).toBe(true);
    // with the blurred render in, the cut reaches Review: nothing in it needs blurring, and it says honestly what it is
    const { readStep } = await import("../editor/store");
    const { readMeta } = await import("../review");
    const { saveDraft } = await import("../editor/store");
    const { markStart } = await import("../editor/preview");
    /** A version's step starts (the server's runner, a computer's package): its mark then, as the engine records it. */
    const started = async (edit: typeof e) => {
      await saveDraft(edit.id, "v1", { timeline: { ...(TIMELINE as object), sources: Object.fromEntries(edit.sources.map((id) => [id, {}])) }, notes: [] } as never);
      const left = editLeaves(edit.id, "v1");
      if (left.ok) markStart(edit.id, "v1", left.mark);
    };
    const filed = async (edit: typeof e) => {
      mkdirSync(path.dirname(previewFile(edit.id, "v1")), { recursive: true });
      writeFileSync(previewFile(edit.id, "v1"), "a-rendered-cut");
      await fileInReview(edit, "v1", TIMELINE);
      const m = await readMeta(readStep(edit.id, "review")!["v1"]!.assetId);
      const v = m!.versions.at(-1)!;
      return { blurred: !!v.blurred, asFilmed: !!v.asFilmed };
    };
    const make = async (sources: string[]) => {
      const one = (await createEdit("tinyacrobatics", { name: "Tiny Acrobatics one", sources }, false, "ws_kids"))!;
      await started(one);
      return one;
    };
    // a blurred render with a file kept as filmed: as filmed, never "blurred"
    expect(await filed(await make([yes.versionId, no.versionId]))).toEqual({ blurred: false, asFilmed: true });
    expect(await filed(await make([no.versionId]))).toEqual({ blurred: false, asFilmed: true }); // only files kept as filmed
    expect(await filed(await make([yes.versionId]))).toEqual({ blurred: true, asFilmed: false }); // only blurred renders
    // a file kept as filmed when the cut's steps started, switched to Blur faces and covered before the cut is filed: the
    // cut was made from its original, so it is filed as filmed, never "blurred"
    const late = (await body(onMac("lib_kids", "Late switch.mov", { blur: false, sha256: sha("late-original") }))) as { assetId: string; versionId: string };
    const switched = await make([late.versionId]);
    expect(await body(app.request(`/api/library/lib_kids/assets/${late.assetId}/blur`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ blur: "yes" }) }))).toEqual({ blur: "yes" });
    await sendBlurred("lib_kids", "Late switch blurred.mp4", "late-blurred-bytes", sha("late-original"));
    expect(editLeaves(switched.id, "v1")).toEqual({ ok: true, mark: "blurred" }); // its end alone would say blurred
    expect(await filed(switched)).toEqual({ blurred: false, asFilmed: true });
    // a step run again now starts blurred, but what an earlier step made as filmed may still be in it: it stays as filmed
    await started(switched);
    expect(await filed(switched)).toEqual({ blurred: false, asFilmed: true });
    // the mark is read from the cut's own sources: a card (an edit's own file) is as filmed, and so is a clip no longer
    // in the Library (deleted while the cut rendered), never "blurred"
    const cut = (await createEdit("tinyacrobatics", { name: "Tiny Acrobatics card", sources: [yes.versionId] }, false, "ws_kids"))!;
    const draft = async (sources: Record<string, unknown>) => {
      await saveDraft(cut.id, "v1", { timeline: { ...(TIMELINE as object), sources }, notes: [] } as never);
      return editLeaves(cut.id, "v1");
    };
    expect(await draft({ [yes.versionId]: {} })).toEqual({ ok: true, mark: "blurred" });
    expect(await draft({ [yes.versionId]: {}, card: { file: "cards/1.png" } })).toEqual({ ok: true, mark: "asFilmed" });
    expect(await draft({ [yes.versionId]: {}, ver_deleted_mid_render: {} })).toEqual({ ok: true, mark: "asFilmed" });
    // a song in it (a sound has no picture, and never gets a blurred render): nothing waits for it, the mark is the pictures'
    const song = (await body(onMac("lib_kids", "Song.m4a"))) as { versionId: string };
    expect(fileBlur(song.versionId)?.blur).toBe("no");
    expect(mayLeave("lib_kids", { versionId: song.versionId }).ok).toBe(true);
    expect(await draft({ [yes.versionId]: {}, [song.versionId]: {} })).toEqual({ ok: true, mark: "blurred" });
    // a video saved under a sound's name holds a picture: it is no sound, and Blur faces holds it
    const posing = (await body(onMac("lib_kids", "Not a song.m4a", { width: 1080, height: 1920 }))) as { versionId: string };
    expect(fileBlur(posing.versionId)?.blur).toBe("yes");
    expect(mayLeave("lib_kids", { versionId: posing.versionId }).ok).toBe(false);
    expect(editLeaves((await createEdit("tinyacrobatics", { name: "Tiny Acrobatics posing", sources: [posing.versionId] }, false, "ws_kids"))!.id, "")).toMatchObject({ ok: false });
    // what the AI Editor's worker is told of each Library source (the SPEC's contract)
    expect(fileBlur(yes.versionId)).toEqual({ blur: "yes", blurredVersionId: b.versionId });
    expect(fileBlur(no.versionId)).toEqual({ blur: "no", blurredVersionId: null });
    const files = editFiles(e.id);
    // the yes-file keeps its own id (the timeline's) and reads its blurred render; the no-file is itself
    expect(files.find((f) => f.id === yes.versionId)?.play).toBe(b.versionId);
    expect(files.find((f) => f.id === no.versionId)?.play).toBeUndefined();
    expect(playOf(yes.versionId)).toBe(b.versionId);
    expect(playOf(no.versionId)).toBe(no.versionId);
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
  it("is asked for and kept for a clip not blurred too (owner, 2026-11-24)", async () => {
    lib("lib_strips", { upload: "all" });
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('a_strip', 'lib_strips', 'video', 'Strip', 'v_strip', 'tinyacrobatics', 0)").run();
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, probe, mac_path, mac_device) VALUES ('v_strip', 'a_strip', 1, 'mac:v_strip', 9, 'h', 'ready', 'tinyacrobatics', 0, ?, '/Volumes/Tiny Footage/Strip.mov', ?)").run(JSON.stringify({ duration: 3, width: 1080, height: 1920 }), MAC);
    d.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES ('v_strip', 'sprite', 'k-old-strip', 1)").run();
    expect(strayStrips("lib_strips", MAC).map((x) => x.versionId)).toEqual(["v_strip"]);
    d.prepare("UPDATE libraries SET settings = json_set(settings, '$.blurFaces', json('true'), '$.upload', 'proxies') WHERE id = 'lib_strips'").run();
    expect(strayStrips("lib_strips", MAC).map((x) => x.versionId)).toEqual(["v_strip"]);
    expect(await putSprite("lib_strips", "v_strip", JPEG)).toBe(true);
  });

  it("asks for the strip and card picture of a blurred copy that became its clip's version with neither, and stops once it has them", () => {
    lib("lib_copy", { upload: "none" });
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('a_copy', 'lib_copy', 'video', 'Copy', 'v_copy', 'tinyacrobatics', 0)").run();
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, probe, mac_path, mac_device, blurred_of) VALUES ('v_copy', 'a_copy', 2, 'mac:v_copy', 9, 'h2', 'ready', 'tinyacrobatics', 0, ?, '/Volumes/Tiny Footage/Copy blurred.mp4', ?, ?)").run(JSON.stringify({ duration: 3, width: 1080, height: 1920 }), MAC, "a".repeat(64));
    expect(strayStrips("lib_copy", MAC)).toEqual([{ versionId: "v_copy", path: "/Volumes/Tiny Footage/Copy blurred.mp4", thumb: true }]);
    d.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes, cell_w, cell_h) VALUES ('v_copy', 'sprite', 'k-strip', 1, 144, 256), ('v_copy', 'thumb', 'k-thumb', 1, NULL, NULL)").run();
    expect(strayStrips("lib_copy", MAC)).toEqual([]);
  });
});

describe("the chat dock under Blur faces", () => {
  it("a dropped file is kept as filmed: it becomes a Caption Studio project, and in the Media Library it is marked no", async () => {
    const id = "0b5e7f3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    const at = path.join(dir, "assistant", "files", "tinyacrobatics", id);
    mkdirSync(at, { recursive: true });
    writeFileSync(path.join(at, "file"), "chat-drop-original");
    writeFileSync(path.join(at, "meta.json"), JSON.stringify({ id, name: "Drop.mov", mime: "video/quicktime", size: 18, at: Date.now() }));
    const user = { username: "tinyacrobatics", role: "user", cloud: false, off: [] } as never;
    expect(await useFile(user, id, "captions")).toMatchObject({ to: "captions" });
    // into the Media Library (This Mac keeps it here): the owner's drop is stored no
    process.env.CT_LOCAL = "1";
    try {
      const into = await useFile(user, id, "library");
      expect(d.prepare("SELECT blur FROM assets WHERE id = ?").get(into.id)).toEqual({ blur: "no" });
    } finally {
      delete process.env.CT_LOCAL;
    }
    // the chat's save into the library (useFile "library" → saveToLibrary): marked no, kept under the Upload chosen (Blurred)
    const { saveToLibrary } = await import("./routes");
    const file = path.join(dir, "chat-drop.mov");
    writeFileSync(file, "chat-drop-kept-as-filmed");
    const saved = await saveToLibrary("tinyacrobatics", file, "Chat drop.mov", [], "lib_kids", true, undefined, { blur: "no" });
    expect(saved && "assetId" in saved, JSON.stringify(saved)).toBe(true);
    const { assetId, versionId } = saved as { assetId: string; versionId: string };
    expect(d.prepare("SELECT blur FROM assets WHERE id = ?").get(assetId)).toEqual({ blur: "no" });
    expect(mayLeave("lib_kids", { versionId }).ok).toBe(true);
    const card = toCard(d.prepare(`SELECT ${CARD} FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE a.id = ?`).get(assetId) as never);
    expect(card).toMatchObject({ blur: "no" });
    expect(card.notBlurred).toBeUndefined();
    // a picture's address carries its version, so a browser that keeps it for good still gets one made again
    const cardOf = () => toCard(d.prepare(`SELECT ${CARD} FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE a.id = ?`).get(assetId) as never);
    d.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'thumb', 'k-pic', 100)").run(versionId);
    expect(cardOf().thumbUrl).toContain("v=100");
    d.prepare("UPDATE derivatives SET bytes = 200 WHERE version_id = ? AND kind = 'thumb'").run(versionId);
    expect(cardOf().thumbUrl).toContain("v=200");
    rmSync(file);
  });
});

describe("a blurred render saved by the server (Face Blur's covered copy)", () => {
  it("is never the original's bytes, nor any clip not blurred: refused before either Upload way in", async () => {
    const { saveToLibrary } = await import("./routes");
    const known = await body(onMac("lib_kids", "Known original.mov", { sha256: sha("known-original-bytes") }));
    expect(known.versionId).toBeTruthy();
    const file = path.join(dir, "covered-copy.mp4");
    for (const lib of ["lib_kids", "lib_kids_off"]) {
      // the original sent back unchanged (a broken computer), Blurred (kept here) and Off (sent to a computer) alike
      writeFileSync(file, "original-bytes-unchanged");
      expect(await saveToLibrary("tinyacrobatics", file, "Copy.mp4", [], lib, true, undefined, { blurredOf: sha("original-bytes-unchanged") })).toEqual({ error: REFUSED_NOT_BLURRED, code: "failed" });
      // the bytes of another clip of the library that is not blurred
      writeFileSync(file, "known-original-bytes");
      expect(await saveToLibrary("tinyacrobatics", file, "Copy.mp4", [], "lib_kids", true, undefined, { blurredOf: sha("some-other-original") })).toEqual({ error: REFUSED_NOT_BLURRED, code: "failed" });
    }
    REFUSED_BYTES.push("original-bytes-unchanged");
    rmSync(file);
  });
});

describe("each file's blur answer, set once when it comes in (owner, 2026-11-20)", () => {
  const blurOf = (assetId: string) => (d.prepare("SELECT blur FROM assets WHERE id = ?").get(assetId) as { blur: string | null }).blur;

  it("an import nobody answered for is stored null and reads its library's Blur faces: yes there, no elsewhere", async () => {
    const yesFile = await body(onMac("lib_kids", "Intake take.mov"));
    const plain = await body(onMac("lib_plain", "Intake plain.mov"));
    expect([blurOf(yesFile.assetId), blurOf(plain.assetId)]).toEqual([null, null]);
    expect([fileBlur(yesFile.versionId)?.blur, fileBlur(plain.versionId)?.blur]).toEqual(["yes", "no"]);
    // the box ticked on purpose is a yes of its own
    expect(blurOf((await body(onMac("lib_plain", "Ticked.mov", { blur: true }))).assetId)).toBe("yes");
  });

  it("only the owner or an admin keeps a file as filmed: anyone else's blur:false is ignored", async () => {
    createUser("tinyadmin", "secret-tiny-admin", { role: "admin" });
    expect([mayKeepAsFilmed("tinyacrobatics", "lib_kids"), mayKeepAsFilmed("tinyadmin", "lib_kids"), mayKeepAsFilmed("sam", "lib_kids")]).toEqual([true, true, false]);
    expect(blurAtIntake("tinyacrobatics", "lib_kids", false)).toBe("no");
    expect(blurAtIntake("tinyadmin", "lib_kids", false)).toBe("no");
    // a member's "no" is no answer at all: the library's Blur faces decides (yes in lib_kids)
    expect(blurAtIntake("sam", "lib_kids", false)).toBeNull();
    expect(blurAtIntake("sam", "lib_kids", undefined)).toBeNull();
    expect(blurAtIntake("sam", "lib_plain", true)).toBe("yes");
    const kept = await body(onMac("lib_kids", "Kept as filmed.mov", { blur: false }));
    expect(blurOf(kept.assetId)).toBe("no");
  });

  it("the owner's upload with blur:false is taken and kept as filmed; a yes-file's original never leaves", async () => {
    const bytes = "owner-talk-as-filmed";
    const r = await app.request("/api/library/lib_kids/uploads", json({ filename: "Owner talk.mp4", size: bytes.length, blur: false }));
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect((await app.request(`/api/library/uploads/${id}`, { method: "PATCH", headers: { "upload-offset": "0", "content-length": String(bytes.length) }, body: bytes })).status).toBe(204);
    const done = (await body(app.request(`/api/library/uploads/${id}/finish`, { method: "POST" }))) as { assetId: string };
    expect(blurOf(done.assetId)).toBe("no");
    expect(mayLeave("lib_kids", { versionId: vOf(done.assetId) }).ok).toBe(true);
    // a yes-file's original: refused to anyone, and so is a new file with no answer in a Blur faces library
    const yes = await body(onMac("lib_kids", "Yes original.mov"));
    expect(mayLeave("lib_kids", { versionId: yes.versionId })).toMatchObject({ ok: false, body: { message: REFUSED_BLUR } });
    expect(mayLeave("lib_kids", {}).ok).toBe(false);
    expect(mayLeave("lib_kids", { blur: "no" }).ok).toBe(true);
    // a version the server does not know: refused under Blur faces, as before; elsewhere it says nothing against it
    expect(mayLeave("lib_kids", { versionId: "ver_unknown" })).toMatchObject({ ok: false, body: { message: REFUSED_BLUR } });
    expect(mayLeave("lib_plain", { versionId: "ver_unknown" }).ok).toBe(true);
    expect((await mayServe({ id: "lib_kids", versionId: yes.versionId }, "proxy")).ok).toBe(false);
  });

  it("changed later: anyone who may change it marks it yes, which queues the blur; only the owner or an admin marks it no", async () => {
    const { onEvent } = await import("../lib/events");
    const queued: string[] = [];
    onEvent("library.version.blur", (e) => void queued.push(e.versionId));
    const f = await body(onMac("lib_kids", "Changed later.mov"));
    // indexed on its Mac with no answer in a Blur faces library: Face Blur is asked to cover it at once
    expect(queued).toEqual([f.versionId]);
    queued.length = 0;
    const put = (blur: unknown, who?: string) =>
      app.request(`/api/library/lib_kids/assets/${f.assetId}/blur`, { method: "PUT", headers: { "content-type": "application/json", ...(who ? { "x-as": who } : {}) }, body: JSON.stringify({ blur }) });
    expect((await put("maybe")).status).toBe(400);
    expect(await body(put("no"))).toEqual({ blur: "no" });
    expect(blurOf(f.assetId)).toBe("no");
    expect(queued).toEqual([]);
    // its proxy goes when it is marked yes; its card picture and strip stay
    for (const kind of ["thumb", "sprite", "proxy"]) d.prepare("INSERT OR REPLACE INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, ?, ?, 1)").run(f.versionId, kind, `libraries/lib_kids/v/${f.versionId}/${kind}`);
    expect(await body(put("yes"))).toEqual({ blur: "yes" });
    expect(queued).toEqual([f.versionId]);
    expect(pictures(f.versionId).filter((k) => ["thumb", "sprite", "proxy"].includes(k))).toEqual(["sprite", "thumb"]);
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
    const card = (f: string) => /[/\\](thumb|sprite)\.jpg$/.test(f); // a card picture or strip is kept for every clip (owner, 2026-11-24)
    for (const f of ofWalk) expect(card(f) || [...blurred].some((id) => f.includes(id)), f).toBe(true);
    for (const f of files) for (const id of ids) expect(!card(f) && f.includes(id), f).toBe(false);
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
      for (const id of ids) expect(!card(f) && f.includes(id), f).toBe(false);
    }
  });
});

describe("Upload under Blur faces: Blurred is the blurred copies, Proxies the proxies (Original → Blurred copy → Proxy)", () => {
  it("a blurred copy and a file with no faces follow both rows, an original waiting for its blur neither", async () => {
    lib("lib_rows", { upload: "all", blurFaces: true });
    const ORIGINAL = sha("rows-original");
    const yes = await body(onMac("lib_rows", "Rows take.mov", { sha256: ORIGINAL }));
    const kept = await body(onMac("lib_rows", "Rows toy.mov"));
    d.prepare("UPDATE assets SET blur = 'no', blur_note = 'none' WHERE id = ?").run(kept.assetId);
    const blurred = await sendBlurred("lib_rows", "Rows take blurred.mp4", "rows-blurred-bytes", ORIGINAL);
    expect(blurred.status).toBe(200);
    const original = (d.prepare("SELECT id FROM asset_versions WHERE asset_id = ? AND blurred_of IS NULL").get(yes.assetId) as { id: string }).id;
    const rows = (upload: string) => {
      d.prepare("UPDATE libraries SET settings = json_set(settings, '$.upload', ?) WHERE id = 'lib_rows'").run(upload);
      return [versionUpload(blurred.versionId!), versionUpload(kept.versionId), versionUpload(original), keepsOnlyOriginals("lib_rows")];
    };
    // Blurred alone: the copies as they are, a clip with no faces as filmed, and no proxy kept
    expect(rows("originals")).toEqual(["originals", "originals", "none", true]);
    expect(rows("proxies")).toEqual(["proxies", "proxies", "none", false]);
    expect(rows("all")).toEqual(["all", "all", "none", false]);
    expect(rows("none")).toEqual(["none", "none", "none", false]);
    // the card says why a no: Face Blur went over it and found no face
    const card = d.prepare(`SELECT ${CARD} FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE a.id = ?`).get(kept.assetId);
    expect(toCard(card as never)).toMatchObject({ blur: "no", blurNote: "none" });
  });

  it("the migration: Blurred, stored as proxies until now, becomes the Originals part and Generate proxies is stored off, only where Blur faces is on", async () => {
    const { MIGRATIONS } = await import("./schema");
    lib("lib_mig", { upload: "proxies", blurFaces: true, proxy: true });
    lib("lib_mig_plain", { upload: "proxies", proxy: true });
    d.exec(MIGRATIONS.find((m) => m.includes("'$.upload', 'originals'"))!);
    const stored = (id: string) => JSON.parse((d.prepare("SELECT settings FROM libraries WHERE id = ?").get(id) as { settings: string }).settings) as { upload: string; proxy: boolean };
    expect(stored("lib_mig")).toMatchObject({ upload: "originals", proxy: false });
    expect(stored("lib_mig_plain")).toMatchObject({ upload: "proxies", proxy: true });
  });
});
