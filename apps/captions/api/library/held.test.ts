import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";
import type { Intake } from "../../contracts/library";
import { WORK_V, type TaskPackage } from "../../contracts/work";

/**
 * R13 (docs/media-library-proxies-prd.md): under Blur faces a file from a phone or a browser is taken and held. No one
 * plays, shares or downloads it; the main computer (the library owner's, with its Source media folder) pulls it into
 * Imports, and only then is it processed. Blurred: the held file is deleted. No faces, or kept as filmed: it stays as the
 * clip's uploaded original where Upload's Originals part is on, and is deleted where it is off. Nothing goes for its age.
 */
const root = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "held-"));
const dir = path.join(root, "data");
mkdirSync(dir);
process.env.DATA_DIR = dir;
process.env.LIBRARY_DISK_RESERVE_GB = "0";
// the team: the owner gave the member the workspace "kids-ws" (Settings → Team)
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
          { username: "sam", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0, workspaces: ["kids-ws"] },
        ],
      },
    ],
    invites: [],
    spend: {},
  }),
);
mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
for (const [id, at] of [["kids-ws", 0], ["second-ws", 1]] as const)
  writeFileSync(path.join(dir, "workshop", "projects", `${id}.json`), JSON.stringify({ id, owner: "tinyacrobatics", name: id, createdAt: at, updatedAt: at }));

// Face Blur's queue, stood in: what it says of each version (lib/plugin.ts DeviceJobSlot.preparing)
const blur = vi.hoisted(() => ({ jobs: [] as { versionId: string; running?: true; waiting?: true; failed?: true; error?: string }[] }));
vi.mock("../lib/plugin", async (real) => ({
  ...(await real<typeof import("../lib/plugin")>()),
  pluginDeviceJobs: () => [{ kind: "faceblur-intake", waits: () => false, claim: () => null, preparing: () => blur.jobs }],
}));

const { sessionCookieFor } = await import("../auth");
const { libraryDb, blobs } = await import("./db");
const { libraryApp, serveGate } = await import("./routes");
const { mayGoPublic, mayPull, mayReceive, mayServe, REFUSED_BLUR, REFUSED_COPY, REFUSED_NO_MAIN } = await import("./upload-gate");
const { heldFile, resumeHeld, settleHeld } = await import("./held");
const { versionSource } = await import("./access");
const { toCard, CARD } = await import("./query");
const { createUser, setOff } = await import("../users");
const { pairDevice, setDeviceWork, touchDevice } = await import("../lib/devices");
const { changeStorage } = await import("../devices-storage");
const { onEvent } = await import("../lib/events");
const { workApp, CLAIM_POLL } = await import("../work/routes");
const { client } = await import("../work/computer");
const { runTaskJob, taskFor, taskTick } = await import("../work/tasks");
const { recordCopy } = await import("../../editor-steps/blur-faces/copy");

CLAIM_POLL.holdMs = 0;
createUser("tinyacrobatics", "secret-tiny-acrobatics");
setOff(createUser("sam", "secret-sam-acrobatics"), []); // every tool on: the member may add to the workspace's Media Library
afterAll(() => {
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  rmSync(root, { recursive: true, force: true });
});

const app = new Hono<{ Variables: AuthVars }>();
app.use("/api/library/*", async (c, next) => {
  c.set("user", { username: c.req.header("x-as") ?? "tinyacrobatics", role: "user", off: [], read: [] } as never);
  return next();
});
app.route("/api/library", libraryApp);
app.route("/api/devices/relay/work", workApp);

const d = libraryDb();
const LIB = "lib_kids";
d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'tinyacrobatics', 'L', 'local', ?, 0)").run(
  LIB,
  JSON.stringify({ upload: "originals", blurFaces: true, proxy: false, describe: false, embed: false, transcribe: false, projectId: "kids-ws" }),
);
// a second workspace whose library no computer has a Source media folder for
d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_two', 'tinyacrobatics', 'Two', 'local', ?, 1)").run(
  JSON.stringify({ upload: "originals", blurFaces: true, projectId: "second-ws" }),
);
const stored = (upload: string) => d.prepare("UPDATE libraries SET settings = json_set(settings, '$.upload', ?) WHERE id = ?").run(upload, LIB);

/** A computer of `owner` with a Source media folder for the workspace, and its worker. */
async function computer(owner: string, name: string) {
  const mac = pairDevice(owner, name);
  const media = path.join(root, "computers", name, "Source media");
  mkdirSync(media, { recursive: true });
  await changeStorage(owner, (st) => {
    st.folders.push({ id: `${owner}-media`, role: "footage", name: "Source media", origin: { host: mac.device.id, path: media }, make: true, createdAt: Date.now(), reach: {}, workspace: "kids-ws" });
  });
  const o = { server: "http://server.test", token: mac.token, beatMs: 20, fetch: (u: string, i?: RequestInit) => Promise.resolve(app.request(u, i)) };
  const c = client(o);
  const claim = async () => (await c.post<{ task?: TaskPackage }>("work/claim", { v: WORK_V, steps: [], tasks: ["library-save"] })).task;
  return {
    id: mac.device.id,
    imports: path.join(media, "Imports", new Date().toISOString().slice(0, 10)),
    online: () => {
      setDeviceWork(mac.device.id, { v: WORK_V, steps: [], tasks: ["library-save"] });
      touchDevice(mac.device.id);
    },
    claim,
    /** Its worker takes the next save and runs it. */
    takes: async () => {
      const t = await claim();
      if (!t) throw new Error("no save to take");
      return runTaskJob(t, c, o);
    },
  };
}
const main = await computer("tinyacrobatics", "Tiny Mac");
const sams = await computer("sam", "Sam Mac");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const PHONE = { cookie: sessionCookieFor("tinyacrobatics", true)!, "x-ct-origin": "phone" };
const start = (body: Record<string, unknown>, headers: Record<string, string> = {}, lib = LIB) =>
  app.request(`/api/library/${lib}/uploads`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
type Done = { status: number; assetId?: string; versionId?: string; held?: boolean; libraryId?: string; duplicateOf?: string; message?: string };
/** An upload from a browser (or `headers`: the phone, a member): start, bytes, finish. */
async function upload(name: string, bytes: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): Promise<Done> {
  const r = await start({ filename: name, size: bytes.length, ...extra }, headers);
  if (r.status !== 201) return { status: r.status, message: ((await r.json()) as { message?: string }).message };
  const { id, direct } = (await r.json()) as { id: string; direct?: unknown };
  expect(direct).toBeUndefined();
  const as = headers["x-as"] ? { "x-as": headers["x-as"] } : {};
  expect((await app.request(`/api/library/uploads/${id}`, { method: "PATCH", headers: { ...as, "upload-offset": "0", "content-length": String(bytes.length) }, body: bytes })).status).toBe(204);
  const done = await app.request(`/api/library/uploads/${id}/finish`, { method: "POST", headers: as });
  return { status: done.status, ...((await done.json()) as Omit<Done, "status">) };
}
const version = (id: string) =>
  d.prepare("SELECT held, source_key, state, mac_path, mac_device, from_path, quick, blurred_of FROM asset_versions WHERE id = ?").get(id) as {
    held: number | null; source_key: string; state: string; mac_path: string | null; mac_device: string | null; from_path: string | null; quick: string | null; blurred_of: string | null;
  };
const jobsOf = (versionId: string) => (d.prepare("SELECT kind FROM jobs WHERE version_id = ? ORDER BY kind").all(versionId) as { kind: string }[]).map((j) => j.kind);
/** Every file under the server's data folder holding exactly `text`. */
function onServer(text: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else if (statSync(f).size === Buffer.byteLength(text) && readFileSync(f, "utf8") === text) out.push(f);
    }
  };
  walk(dir);
  return out;
}
const intake = async (assets?: string[], who?: string) =>
  ((await (await app.request(`/api/library/${LIB}/intake${assets ? `?assets=${assets.join(",")}` : ""}`, { headers: who ? { "x-as": who } : {} })).json()) as { items: Intake[] }).items;
const one = async (assetId: string) => (await intake([assetId]))[0]!;
const keptAsFilmed = (assetId: string, blur = "no") =>
  app.request(`/api/library/${LIB}/assets/${assetId}/blur`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ blur }) });
/** The main computer's blurred copy of `versionId` recorded, as Face Blur records it (editor-steps/blur-faces copy.ts). */
async function blurred(versionId: string, name: string) {
  const original = (d.prepare("SELECT sha256 FROM asset_versions WHERE id = ?").get(versionId) as { sha256: string }).sha256;
  const r = await recordCopy(LIB, "tinyacrobatics", main.id, { path: path.join(main.imports, "Blurred", `${name} blurred.mp4`), size: 77 + name.length, quick: sha(`blurred:${name}`) }, original);
  await vi.waitFor(() => expect(version(versionId).held).toBeNull());
  return r as { assetId: string; versionId: string };
}
const asked: string[] = [];
onEvent("library.version.blur", (e) => void asked.push(e.versionId));

describe("the gate: a file to blur from a phone or a browser is taken and held", () => {
  it("the rule: a person's and a phone's original are held under every Upload; a computer's own, a smaller copy and a picture cut from one are refused", () => {
    for (const upload of ["none", "proxies", "originals", "all"]) {
      stored(upload);
      expect(mayReceive("original", { id: LIB }, "person"), upload).toEqual({ ok: true });
      expect(mayReceive("original", { id: LIB }, "phone"), upload).toEqual({ ok: true });
      expect(mayReceive("original", { id: LIB }, "computer"), upload).toMatchObject({ ok: false, body: { message: REFUSED_BLUR } });
      expect(mayReceive("proxy", { id: LIB }, "phone"), upload).toMatchObject({ ok: false, body: { message: REFUSED_COPY } });
      expect(mayReceive("derivative", { id: LIB }, "person").ok, upload).toBe(false);
    }
    stored("originals");
  });

  it("with no computer that has the library's Source media folder it is refused, saying what to add", async () => {
    const r = await start({ filename: "Nowhere.mp4", size: 4 }, {}, "lib_two");
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "upload_refused", message: REFUSED_NO_MAIN });
  });

  it("a browser's file is held: on the server, played, shared, downloaded and handed to no one, and nothing is made of it", async () => {
    const bytes = "tiny acrobatics handstand, as filmed";
    const up = await upload("Handstand.mp4", bytes);
    expect(up).toMatchObject({ status: 200, held: true, libraryId: LIB, assetId: expect.any(String), versionId: expect.any(String) });
    const v = up.versionId!;
    expect(version(v)).toMatchObject({ held: 1, source_key: `mac:${v}`, state: "ready", mac_path: null, quick: expect.any(String) });
    // the one copy on the server is the held file, outside the library's store
    expect(onServer(bytes)).toEqual([heldFile(v)]);
    expect(jobsOf(v)).toEqual([]);
    for (const who of [undefined, "sam"]) {
      for (const kind of ["source", "play", "proxy"]) {
        const r = await app.request(`/api/library/media/${v}/${kind}`, { headers: who ? { "x-as": who } : {} });
        expect(r.status, `${who ?? "owner"} ${kind}`).toBe(409);
        expect(await r.text()).not.toContain(bytes);
      }
    }
    expect((await serveGate(v, "source", { key: version(v).source_key, what: "original" })).ok).toBe(false);
    expect((await mayServe({ id: LIB, versionId: v }, "original", { toComputer: true })).ok).toBe(false);
    expect(mayGoPublic(v).ok).toBe(false);
    expect(await versionSource("tinyacrobatics", v)).toBeNull();
    // the one way out: the main computer's pull, while its master is not there yet
    expect(mayPull(v)).toEqual({ ok: true });
    // the card and the progress say where it is: the main computer is not online
    const card = toCard(d.prepare(`SELECT ${CARD} FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE a.id = ?`).get(up.assetId!) as never);
    expect(card).toMatchObject({ held: true, notBlurred: true });
    expect(await one(up.assetId!)).toEqual({ assetId: up.assetId, versionId: v, step: "held", waiting: true });
    expect(await intake()).toEqual([{ assetId: up.assetId, versionId: v, step: "held", waiting: true }]);
    // the same file again is not added again
    expect(await upload("Handstand copy.mp4", bytes)).toMatchObject({ status: 200, duplicateOf: up.assetId });
    expect(onServer(bytes)).toEqual([heldFile(v)]);
  });

  it("with the main computer away it waits, held: nothing goes for its age", async () => {
    const [v] = (await intake()).map((i) => i.versionId);
    await taskTick(Date.now() + 400 * 86_400_000);
    expect(taskFor("library-save", `held:${v}`)).toMatchObject({ state: "queued" });
    expect(version(v!).held).toBe(1);
    expect(existsSync(heldFile(v!))).toBe(true);
    // a start that sweeps the uploads nobody finished leaves it too
    expect((await start({ filename: "Another.mp4", size: 4 })).status).toBe(201);
    expect(existsSync(heldFile(v!))).toBe(true);
  });
});

describe("the main computer pulls it, and only then is it processed", () => {
  it("a member's file goes to the library owner's main computer, never the member's; the master is in Imports, and Face Blur is asked", async () => {
    const bytes = "tiny acrobatics cartwheel, sent by sam";
    const up = await upload("Cartwheel.mp4", bytes, { "x-as": "sam" }, { blur: false }); // a member's "kept as filmed" is no answer
    expect(up).toMatchObject({ status: 200, held: true });
    const v = up.versionId!;
    sams.online();
    expect(await sams.claim()).toBeUndefined();
    asked.length = 0;
    main.online();
    // the oldest first: the browser's Handstand, then sam's
    expect(await main.takes()).toBe("done");
    expect(await main.takes()).toBe("done");
    const at = path.join(main.imports, "Cartwheel.mp4");
    expect(readFileSync(at, "utf8")).toBe(bytes);
    expect(version(v)).toMatchObject({ held: 1, mac_path: at, mac_device: main.id, source_key: `mac:${v}` });
    expect(d.prepare("SELECT device, folder_id, path, state FROM version_places WHERE version_id = ?").get(v)).toEqual({ device: main.id, folder_id: "tinyacrobatics-media", path: at, state: "verified" });
    expect(asked).toContain(v);
    // held until it is blurred: still on the server, and no longer handed to any computer
    expect(onServer(bytes)).toEqual([heldFile(v)]);
    expect(mayPull(v).ok).toBe(false);
    expect(jobsOf(v)).toEqual([]);
    // how far it is, read by the member who sent it too
    expect((await intake([up.assetId!], "sam"))[0]).toEqual({ assetId: up.assetId, versionId: v, step: "computer", waiting: true });
    blur.jobs = [{ versionId: v }];
    expect(await one(up.assetId!)).toMatchObject({ step: "computer" });
    expect((await one(up.assetId!)).waiting).toBeUndefined();
    blur.jobs = [{ versionId: v, running: true }];
    expect(await one(up.assetId!)).toMatchObject({ step: "blurring" });
    blur.jobs = [{ versionId: v, failed: true, error: "Needs Which faces" }];
    expect(await one(up.assetId!)).toEqual({ assetId: up.assetId, versionId: v, step: "failed", failed: "blur", error: "Needs Which faces" });
    blur.jobs = [];
  });

  it("faces found: once the blurred copy is recorded the held file is deleted, and what goes up follows Upload", async () => {
    const held = await intake();
    expect(held.map((i) => i.step)).toEqual(["computer", "computer"]);
    for (const [i, name] of [[held[0]!, "Handstand"], [held[1]!, "Cartwheel"]] as const) {
      const copy = await blurred(i.versionId, name);
      expect(copy.assetId).toBe(i.assetId);
      // the hold ends just behind the answer that recorded the copy (routes.ts: once its transaction is in), not within it
      await vi.waitFor(() => expect(existsSync(heldFile(i.versionId))).toBe(false));
      // the original is where its master is, on the main computer, and nowhere on the server
      expect(version(i.versionId)).toMatchObject({ held: null, source_key: `mac:${i.versionId}`, mac_device: main.id });
      // Upload → Blurred: the blurred copy's computer sends it
      expect(jobsOf(copy.versionId)).toContain("send");
      expect(await one(i.assetId)).toEqual({ assetId: i.assetId, versionId: copy.versionId, step: "done", result: "blurred" });
    }
    expect(onServer("tiny acrobatics handstand, as filmed")).toEqual([]);
    expect(onServer("tiny acrobatics cartwheel, sent by sam")).toEqual([]);
    expect(await intake()).toEqual([]);
  });

  it("no faces, or kept as filmed: the held file is the clip's uploaded original where Upload's Originals part is on, and deleted where it is off", async () => {
    const kept = await upload("Toy.mp4", "a toy, no faces, kept");
    const dropped = await upload("Ball.mp4", "a ball, no faces, dropped");
    // answered before its master is on the main computer: it still waits for that computer
    expect((await keptAsFilmed(kept.assetId!)).status).toBe(200);
    expect(version(kept.versionId!)).toMatchObject({ held: 1, mac_path: null });
    asked.length = 0;
    expect(await main.takes()).toBe("done");
    expect(asked).toEqual([]); // nothing to blur
    const key = `libraries/${LIB}/v/${kept.versionId}/source`;
    expect(version(kept.versionId!)).toMatchObject({ held: null, source_key: key, mac_path: null, from_path: path.join(main.imports, "Toy.mp4") });
    expect(readFileSync(await blobs.localCopy(key), "utf8")).toBe("a toy, no faces, kept");
    expect(existsSync(heldFile(kept.versionId!))).toBe(false);
    expect(jobsOf(kept.versionId!)).toEqual(["probe"]);
    expect((await mayServe({ id: LIB, versionId: kept.versionId! }, "original")).ok).toBe(true);
    expect(await one(kept.assetId!)).toMatchObject({ step: "done", result: "asFilmed" });
    // Upload → Blurred off: it stays on the main computer only
    stored("proxies");
    expect(await main.takes()).toBe("done");
    expect(version(dropped.versionId!).held).toBe(1);
    expect((await keptAsFilmed(dropped.assetId!)).status).toBe(200);
    expect(version(dropped.versionId!)).toMatchObject({ held: null, source_key: `mac:${dropped.versionId}`, mac_path: path.join(main.imports, "Ball.mp4") });
    expect(onServer("a ball, no faces, dropped")).toEqual([]);
    // and from there it follows Upload as a file added now: Proxies is on, so its computer is asked to send
    expect(jobsOf(dropped.versionId!)).toEqual(["send"]);
    // decided before it landed: once its master is there the held file goes, it is processed as a file indexed on that
    // computer (its transcript, as the library's own account) and follows Upload the same way
    d.prepare("UPDATE libraries SET settings = json_set(settings, '$.transcribe', json('true')) WHERE id = ?").run(LIB);
    const early = await upload("Kite.mp4", "a kite, no faces, early");
    expect((await keptAsFilmed(early.assetId!)).status).toBe(200);
    expect(await main.takes()).toBe("done");
    expect(version(early.versionId!)).toMatchObject({ held: null, source_key: `mac:${early.versionId}` });
    expect(onServer("a kite, no faces, early")).toEqual([]);
    expect(jobsOf(early.versionId!)).toEqual(["send", "transcribe"]);
    expect((d.prepare("SELECT actor FROM jobs WHERE version_id = ? AND kind = 'transcribe'").get(early.versionId!) as { actor: string }).actor).toBe("tinyacrobatics");
    d.prepare("UPDATE libraries SET settings = json_set(settings, '$.transcribe', json('false')) WHERE id = ?").run(LIB);
    stored("originals");
  });

  it("a late answer never deletes the file of a clip changed meanwhile, and a hold ends once", async () => {
    const up = await upload("Late.mp4", "kept as filmed, then a late blurred copy");
    expect(await main.takes()).toBe("done");
    expect(await settleHeld(up.versionId!)).toBeNull(); // still to blur: it waits
    await keptAsFilmed(up.assetId!);
    const key = version(up.versionId!).source_key;
    expect(key).toBe(`libraries/${LIB}/v/${up.versionId}/source`);
    // Face Blur's copy lands after the owner kept the clip as filmed: the stored original is not this answer's to delete
    const original = (d.prepare("SELECT sha256 FROM asset_versions WHERE id = ?").get(up.versionId!) as { sha256: string }).sha256;
    await recordCopy(LIB, "tinyacrobatics", main.id, { path: path.join(main.imports, "Blurred", "Late blurred.mp4"), size: 91, quick: sha("blurred:Late") }, original);
    await new Promise((r) => setImmediate(r));
    expect(version(up.versionId!).source_key).toBe(key);
    expect(readFileSync(await blobs.localCopy(key), "utf8")).toBe("kept as filmed, then a late blurred copy");
    expect(await settleHeld(up.versionId!)).toBeNull();
  });
});

describe("what stops it, and what cleans up", () => {
  it("a copy that failed says why, keeps the file held, and is asked for again", async () => {
    const up = await upload("Stuck.mp4", "the copy to the main computer failed");
    d.prepare("UPDATE computer_tasks SET state = 'failed', error = 'No room on the disk' WHERE kind = 'library-save' AND ref = ?").run(`held:${up.versionId}`);
    expect(await one(up.assetId!)).toEqual({ assetId: up.assetId, versionId: up.versionId, step: "failed", failed: "copy", error: "No room on the disk" });
    expect(existsSync(heldFile(up.versionId!))).toBe(true);
    expect((await app.request(`/api/library/${LIB}/assets/${up.assetId}/intake/retry`, { method: "POST" })).status).toBe(200);
    expect(taskFor("library-save", `held:${up.versionId}`)).toMatchObject({ state: "queued" });
    expect(await main.takes()).toBe("done");
    expect(version(up.versionId!).mac_path).toBe(path.join(main.imports, "Stuck.mp4"));
  });

  it("a clip deleted for good takes its held file with it; at start a file with no clip goes and a file with no pull is asked for again", async () => {
    const gone = await upload("Gone.mp4", "trashed before the main computer had it");
    const waits = await upload("Waits.mp4", "its pull was lost with a restart");
    await app.request(`/api/library/${LIB}/assets/${gone.assetId}`, { method: "DELETE" });
    expect(((await (await app.request(`/api/library/${LIB}/trash/empty`, { method: "POST" })).json()) as { deleted: number }).deleted).toBe(1);
    expect(onServer("trashed before the main computer had it")).toEqual([]);
    expect(taskFor("library-save", `held:${gone.versionId}`)).toBeUndefined();
    d.prepare("DELETE FROM computer_tasks WHERE ref = ?").run(`held:${waits.versionId}`);
    writeFileSync(heldFile("no-such-version"), "left by a clip removed while the server was off");
    await resumeHeld();
    expect(existsSync(heldFile("no-such-version"))).toBe(false);
    expect(existsSync(heldFile(waits.versionId!))).toBe(true);
    expect(taskFor("library-save", `held:${waits.versionId}`)).toMatchObject({ state: "queued" });
  });
});

describe("R10: what the iPhone app's upload does under each stored Upload, Blur faces on", () => {
  const probe = { duration: 3, width: 1280, height: 720, fps: 30, rotation: 0, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" };
  /** The start body of the phone's own 720p copy of an original of `size` bytes (PhoneMade.swift). */
  const copyOf = (bytes: string, size: number) => ({ quick: sha(`quick:${bytes}`), proxy: { size, probe, sha256: sha(bytes) } });

  it.each(["none", "proxies", "originals", "all"])("stored %s", async (value) => {
    stored(value);
    const phone = (bytes: string, extra: Record<string, unknown> = {}) => upload(`${bytes}.mp4`, bytes, PHONE, extra);
    // a file to blur: its original is held, whatever is stored; the 720p copy the app sends under "proxies" is refused
    const original = await phone(`to blur, original, ${value}`);
    expect(original).toMatchObject({ status: 200, held: true });
    expect(version(original.versionId!)).toMatchObject({ held: 1, source_key: `mac:${original.versionId}` });
    const copy = `to blur, 720p copy, ${value}`;
    expect(await phone(copy, copyOf(copy, 5000))).toMatchObject({ status: 409, message: REFUSED_COPY });
    // kept as filmed (the owner's switch on the phone): never held, and what the server keeps follows what is sent
    const filmed = await phone(`as filmed, original, ${value}`, { blur: false });
    expect(filmed).toMatchObject({ status: 200, versionId: expect.any(String) });
    expect(filmed.held).toBeUndefined();
    expect(version(filmed.versionId!)).toMatchObject({ held: null, source_key: `libraries/${LIB}/v/${filmed.versionId}/source` });
    // a viewer gets that original only where the Originals part is on; under none and proxies it waits for a computer
    expect((await mayServe({ id: LIB, versionId: filmed.versionId! }, "original")).ok).toBe(value === "originals" || value === "all");
    // its 720p copy is taken under every value (the one proxy every library takes) and is all the server has of it
    const small = `as filmed, 720p copy, ${value}`;
    const sent = await phone(small, { blur: false, ...copyOf(small, 5000) });
    expect(sent).toMatchObject({ status: 200, versionId: expect.any(String) });
    expect(d.prepare("SELECT d.storage_key = v.source_key AS same, v.bytes FROM asset_versions v JOIN derivatives d ON d.version_id = v.id AND d.kind = 'proxy' WHERE v.id = ?").get(sent.versionId!)).toEqual({ same: 1, bytes: 5000 });
    expect((await mayServe({ id: LIB, versionId: sent.versionId! }, "proxy")).ok).toBe(value === "proxies" || value === "all");
  });
});
