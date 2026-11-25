// Face Blur's automatic covers: what is queued when a file comes into the Media Library, the claim by the Mac that has it,
// the AI's answer, the copy recorded as the clip's blurred version, and each way a file ends (docs/face-blur-intake-prd.md
// §3a). Only the person's AI and the Macs are stood in.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? process.env.TMPDIR ?? tmpdir(), "blur-faces-auto-"));
process.env.LIBRARY_DISK_RESERVE_GB = "0";
delete process.env.APP_SECRET;

const ai = vi.hoisted(() => ({ configured: true, answer: async (): Promise<string> => '{"blur": []}' }));
vi.mock("../../api/ai-vision", () => ({
  anyVisionConfigured: () => ai.configured,
  completeVisionWithFallback: async (_s: string, _u: string, _i: unknown[], _sig: unknown, parse: (t: string) => unknown) => ({ value: parse(await ai.answer()), provider: "test" }),
}));
const macs = vi.hoisted(() => ({ online: new Set<string>(["mac-1"]), kinds: ["faceblur-intake"] as string[] }));
vi.mock("../../api/lib/devices", async (real) => ({
  ...(await real<typeof import("../../api/lib/devices")>()),
  isOnline: (id: string) => macs.online.has(id),
  listDevices: (keep: (d: unknown) => boolean) => [{ id: "mac-1", owner: "ana", name: "Ana's Mac", kinds: macs.kinds }].filter(keep),
}));

const { Hono } = await import("hono");
const { fileBlur, libraryDb, playOf } = await import("../../api/library/db");
const { saveToLibrary } = await import("../../api/library/routes");
const { default: plugin, autoJobs, outOf, queueVersion, resetAuto, sweep, AUTO_LIMITS } = await import("./plugin");

const dir = process.env.DATA_DIR;
const mac = { id: "mac-1", owner: "ana" };
const app = new Hono<{ Variables: { user: unknown } }>();
app.use(async (c, next) => {
  c.set("user", { username: "ana", role: "user", off: [] });
  await next();
});
app.route("/api/x/blur-faces", plugin.routes!);
const call = (method: string, url: string, body?: unknown) =>
  app.request(`/api/x/blur-faces${url}`, { method, headers: { "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const settings = (s: Record<string, unknown>) => call("PUT", "/settings", { mode: "all", who: "Every child's face", look: "blur", resolution: "1080", bitrate: 20, location: "folder", ...s });
const SHA = "a".repeat(64);
const FACES = { faces: [{ id: "F1", picture: "/9j/AAAA", note: "middle left of the frame; 12% of its width; seen for 4.2 s" }], sha256: SHA };
const answerOf = (v: string) => (libraryDb().prepare("SELECT a.blur FROM assets a JOIN asset_versions v ON v.asset_id = a.id WHERE v.id = ?").get(v) as { blur: string | null }).blur;
const auto = async () => (await (await call("GET", "/auto")).json()) as { can: boolean; why?: string; pausedUntil?: number; held?: boolean; running: string[]; failed: { versionId: string; error: string }[] };

let n = 0;
/** A file added to Ana's library the way an upload adds one, with its blur answer (marked Blur faces by default); its version id. */
async function added(ext: "mp4" | "jpg" | "m4a", blur: "yes" | "no" = "yes"): Promise<string> {
  const bytes = ext === "jpg" ? Buffer.from([0xff, 0xd8, 0xff, 0xe0, ++n]) : Buffer.from(`\0\0\0\x18ftypmp42${++n}`, "latin1");
  const file = path.join(dir, `in-${n}.${ext}`);
  writeFileSync(file, bytes);
  const r = await saveToLibrary("ana", file, `Tiny take ${n}.${ext}`, [], "lib_a", true);
  if (!r || !("versionId" in r)) throw new Error(`not added: ${JSON.stringify(r)}`);
  libraryDb().prepare("UPDATE assets SET blur = ? WHERE current_version_id = ?").run(blur, r.versionId);
  // indexed where it is on Ana's Mac (on-mac.ts): its path there and that Mac
  libraryDb().prepare("UPDATE asset_versions SET mac_path = ?, mac_device = 'mac-1' WHERE id = ?").run(`/Volumes/Tiny/Footage/take-${n}.${ext}`, r.versionId);
  return r.versionId;
}
const event = (versionId: string) => ({ libraryId: "lib_a", versionId, owner: "ana" });
const assets = () => (libraryDb().prepare("SELECT title FROM assets WHERE library_id = 'lib_a' ORDER BY created_at, title").all() as { title: string }[]).map((a) => a.title);

beforeAll(async () => {
  // the library's own account (access.ts accountOf): its covered copy becomes the clip's blurred render
  (await import("../../api/users")).createUser("ana", "secret-ana-acrobatics");
  // Upload all: the server keeps what is saved here (under none a save goes to a computer: library/save-on-computer.test.ts)
  libraryDb().prepare(`INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_a', 'ana', 'A', 'local', '{"upload":"all"}', 0)`).run();
});
beforeEach(async () => {
  ai.configured = true;
  ai.answer = async () => '{"blur": []}';
  macs.online = new Set(["mac-1"]);
  macs.kinds = ["faceblur-intake"];
  // nothing left over from the test before
  await resetAuto();
  rmSync(path.join(dir, "plugins", "blur-faces", "auto.json"), { force: true });
});

describe("what comes into the Media Library", () => {
  it("is queued only for a file marked Blur faces with no blurred render yet, on a Mac, and only photos and videos", async () => {
    expect(await queueVersion(event(await added("mp4", "no")))).toBe(false);
    const done = await added("mp4");
    libraryDb().prepare("UPDATE asset_versions SET blurred_of = sha256 WHERE id = ?").run(done); // a blurred render itself
    expect(await queueVersion(event(done))).toBe(false);
    const server = await added("mp4");
    libraryDb().prepare("UPDATE asset_versions SET mac_path = NULL, mac_device = NULL WHERE id = ?").run(server); // on no Mac
    expect(await queueVersion(event(server))).toBe(false);
    expect(await queueVersion(event(await added("mp4")))).toBe(true);
    expect(await queueVersion(event(await added("jpg")))).toBe(true);
    expect(await queueVersion(event(await added("m4a")))).toBe(false);
    expect(autoJobs.waits("ana", "mac-1")).toBe(true);
    expect(autoJobs.waits("ana", "mac-2")).toBe(false); // not the Mac that has them
    expect(autoJobs.waits("bo", "mac-1")).toBe(false);
  });

  it("is queued once, even when it is read again", async () => {
    await settings({});
    const v = await added("mp4");
    expect(await queueVersion(event(v))).toBe(true);
    expect(await queueVersion(event(v))).toBe(false);
  });

  it("queues every file already waiting when the server starts", async () => {
    await settings({});
    const v = await added("mp4");
    expect(await sweep()).toBeGreaterThanOrEqual(1);
    expect(await queueVersion(event(v))).toBe(false); // the sweep has it
  });
});

describe("the Mac that has the file", () => {
  it("writes the copy at the resolution and bitrate set, into the folder the location says", async () => {
    await settings({ resolution: "original", bitrate: 80, location: "beside" });
    const v = await added("mp4");
    await queueVersion(event(v));
    const job = autoJobs.claim(mac)!;
    expect(job.options).toMatchObject({ longSide: "0", bitrate: "80000000", out: "/Volumes/Tiny/Footage" });
    expect(outOf({ location: "custom", folder: "/Volumes/Tiny/Copies" }, "/q", "/Volumes/Tiny/Footage/a.mp4")).toBe("/Volumes/Tiny/Copies");
    expect(outOf({ location: "custom", folder: "" }, "/q", "/Volumes/Tiny/Footage/a.mp4")).toBe("/q"); // no folder chosen yet: the Blurred folder
    expect(outOf({ location: "folder", folder: "/x" }, "/q", "/Volumes/Tiny/Footage/a.mp4")).toBe("/q");
  });

  it("is handed its path, the folder for the copy and the style, and only with an AI provider and Which faces", async () => {
    await settings({ look: "mosaic", strength: 0.9, size: 1.5 });
    const v = await added("mp4");
    await queueVersion(event(v));
    expect(autoJobs.claim({ id: "mac-2", owner: "ana" })).toBeNull(); // another Mac of the account
    ai.configured = false;
    expect(autoJobs.claim(mac)).toBeNull();
    ai.configured = true;
    await call("PUT", "/settings", { who: "  " });
    expect(autoJobs.claim(mac)).toBeNull();
    await call("PUT", "/settings", { who: "Every child's face" });
    const job = autoJobs.claim(mac)!;
    expect(job).toMatchObject({
      kind: "faceblur-intake",
      options: { media: "video", look: "mosaic", strength: "0.9", softness: "0.45", size: "1.5", color: "#343434", longSide: "1920", bitrate: "20000000" },
    });
    expect(job.options!.path).toMatch(/^\/Volumes\/Tiny\/Footage\/take-\d+\.mp4$/);
    expect(job.options!.out).toBe("/Volumes/Tiny/Footage/Blurred"); // no Media folder set up here: beside the original
    expect(job.options!.mode).toBeUndefined(); // always the faces described
    expect(await autoJobs.input()).toBeNull(); // the original is never sent
    expect((await auto()).running).toEqual([v]);
  });

  it("a file with no face, or none the AI chose, is kept as filmed and never queued again", async () => {
    await settings({});
    const v = await added("mp4");
    await queueVersion(event(v));
    const job = autoJobs.claim(mac)!;
    expect(await autoJobs.answer("mac-1", job.id, { nothing: "No face found", sha256: SHA })).toEqual({ reply: { ok: true } });
    expect(answerOf(v)).toBe("no");
    expect(await queueVersion(event(v))).toBe(false);
    const w = await added("mp4");
    await queueVersion(event(w));
    const again = autoJobs.claim(mac)!;
    expect(await autoJobs.answer("mac-1", again.id, FACES)).toEqual({ reply: { blur: [] } });
    expect(answerOf(w)).toBe("no");
    expect((await auto()).failed).toEqual([]);
  });

  it("records the copy as its original's blurred render, played in its place and never covered again", async () => {
    await settings({});
    const v = await added("mp4");
    await queueVersion(event(v));
    const job = autoJobs.claim(mac)!;
    ai.answer = async () => '{"blur": ["F1"]}';
    expect(await autoJobs.answer("mac-1", job.id, { made: { path: "/x.mp4", size: 1, quick: "q" } })).toMatchObject({ status: 400 }); // sha first
    expect(await autoJobs.answer("mac-1", job.id, FACES)).toEqual({ reply: { blur: ["F1"] } });
    expect((libraryDb().prepare("SELECT full_sha256 FROM asset_versions WHERE id = ?").get(v) as { full_sha256: string }).full_sha256).toBe(SHA);
    const made = { path: "/Volumes/Tiny/Footage/Blurred/take blurred.mp4", size: 4321, quick: "copy-quick", duration: 4, width: 1920, height: 1080 };
    expect(await autoJobs.answer("mac-1", job.id, { made })).toEqual({ reply: { ok: true } });
    const blurred = fileBlur(v)?.blurredVersionId;
    expect(blurred).toBeTruthy();
    expect(playOf(v)).toBe(blurred); // the AI Editor reads it in the original's place
    const row = libraryDb().prepare("SELECT asset_id, mac_path, source_key FROM asset_versions WHERE id = ?").get(blurred!) as { asset_id: string; mac_path: string; source_key: string };
    expect(row.mac_path).toBe(made.path); // on the Mac, nothing uploaded
    expect(row.source_key).toMatch(/^mac:/);
    const original = libraryDb().prepare("SELECT asset_id FROM asset_versions WHERE id = ?").get(v) as { asset_id: string };
    expect(row.asset_id).toBe(original.asset_id); // a version of the original's own clip
    expect(await queueVersion(event(blurred!))).toBe(false);
    expect(await queueVersion(event(v))).toBe(false);
    // the library uploads (all hosts proxies): its Mac makes the team's proxy from the copy and sends it
    expect(libraryDb().prepare("SELECT 1 FROM jobs WHERE version_id = ? AND kind = 'send'").get(blurred!)).toBeTruthy();

    // Undo: the clip plays its original again, the copy's version is gone, and the intake holds until Resume
    const before = Date.now() - 60_000;
    const undo = (await (await call("POST", "/auto/undo", { since: before })).json()) as { reverted: { versionId: string; macPath: string }[] };
    expect(undo.reverted).toEqual([{ versionId: blurred, macPath: made.path }]);
    expect((libraryDb().prepare("SELECT current_version_id AS c FROM assets WHERE id = ?").get(original.asset_id) as { c: string }).c).toBe(v);
    expect(libraryDb().prepare("SELECT 1 FROM asset_versions WHERE id = ?").get(blurred!)).toBeUndefined();
    expect(await queueVersion(event(v))).toBe(true); // queued again, but held
    expect(autoJobs.claim(mac)).toBeNull();
    expect((await auto()).held).toBe(true);
    await call("PUT", "/auto", { on: true });
    expect((await auto()).held).toBe(false);

    // the library's Stop holds it as well, until the switch turns it on again
    plugin.start?.();
    const { emitEvent } = await import("../../api/lib/events");
    // a member's Stop leaves the owner's covers running: the hold is the owner's to lift
    emitEvent("library.stopped", { libraryId: "lib_a", by: "bo" });
    await new Promise((r) => setTimeout(r, 20));
    expect((await auto()).held).toBe(false);
    emitEvent("library.stopped", { libraryId: "lib_a", by: "ana" });
    await vi.waitFor(async () => expect((await auto()).held).toBe(true));
    await call("PUT", "/auto", { on: true });
    expect(autoJobs.claim(mac)).toBeTruthy();
  });

  it("a disk that is not connected gives the file back, not offered to that Mac again for a while", async () => {
    await settings({});
    await queueVersion(event(await added("mp4")));
    const job = autoJobs.claim(mac)!;
    expect(await autoJobs.answer("mac-1", job.id, { back: "The disk is not connected" })).toEqual({ reply: { ok: true } });
    expect(autoJobs.claim(mac)).toBeNull();
    expect((await auto()).failed).toEqual([]);
  });

  it("an AI provider that cannot answer gives the file back with no try and pauses the account, never fails it", async () => {
    await settings({});
    const v = await added("mp4");
    await queueVersion(event(v));
    const job = autoJobs.claim(mac)!;
    ai.answer = async () => {
      throw Object.assign(new Error("429 rate_limit_error"), { limited: { until: Date.now() + 60_000 } });
    };
    expect(await autoJobs.answer("mac-1", job.id, FACES)).toMatchObject({ status: 409, back: true });
    expect(autoJobs.claim(mac)).toBeNull(); // paused
    const a = await auto();
    expect(a.pausedUntil).toBeGreaterThan(Date.now());
    expect(a.failed).toEqual([]);
    expect(answerOf(v)).toBe("yes");
  });

  it("an answer the AI can't give for one file (no list) is a try for that file, never a pause: three, and it fails", async () => {
    await settings({});
    const v = await added("mp4");
    await queueVersion(event(v));
    ai.answer = async () => "I can't help with that.";
    for (let t = 1; t <= AUTO_LIMITS.tries; t++) {
      const job = autoJobs.claim(mac)!;
      expect(job).toBeTruthy(); // not paused: the next file (here the same) is handed out at once
      expect(await autoJobs.answer("mac-1", job.id, FACES)).toMatchObject({ status: 409 });
    }
    const a = await auto();
    expect(a.pausedUntil).toBeUndefined();
    expect(a.failed.map((f) => f.versionId)).toEqual([v]);
    expect(autoJobs.claim(mac)).toBeNull();
  });

  it("a copy taken in as a clip of its own first is a failure, kept, so the sweep never queues its original again", async () => {
    await settings({});
    const v = await added("mp4");
    await queueVersion(event(v));
    const job = autoJobs.claim(mac)!;
    ai.answer = async () => '{"blur": ["F1"]}';
    await autoJobs.answer("mac-1", job.id, FACES);
    const made = { path: "/Volumes/Tiny/Footage/Blurred/raced blurred.mp4", size: 999, quick: "raced-quick" };
    // the Mac's folder scan indexed the copy before its record came
    const { indexOnMac } = await import("../../api/library/on-mac");
    await indexOnMac("lib_a", "ana", { name: "raced blurred.mp4", path: made.path, size: made.size, quick: made.quick, device: "mac-1", frames: [] });
    expect(await autoJobs.answer("mac-1", job.id, { made })).toMatchObject({ status: 409 });
    expect((await auto()).failed.map((f) => f.versionId)).toEqual([v]);
    expect(await queueVersion(event(v))).toBe(false); // what the sweep asks for each waiting file
  });

  it("a file in a folder kept as filmed is not queued, and one queued before is dropped when its Mac asks", async () => {
    await settings({});
    const v = await added("mp4");
    await queueVersion(event(v));
    const d = libraryDb();
    const asset = (d.prepare("SELECT asset_id FROM asset_versions WHERE id = ?").get(v) as { asset_id: string }).asset_id;
    d.prepare("UPDATE assets SET blur = NULL WHERE id = ?").run(asset); // no answer of its own: the folder's counts
    d.prepare("INSERT INTO collections (id, library_id, name, kind, created_by, created_at, blur) VALUES ('col_course', 'lib_a', 'Course', 'manual', 'ana', 0, 'no')").run();
    d.prepare("INSERT INTO collection_items (collection_id, asset_id, position, added_by) VALUES ('col_course', ?, 1, 'ana')").run(asset);
    expect(fileBlur(v)?.blur).toBe("no");
    expect(autoJobs.claim(mac)).toBeNull();
    expect(await queueVersion(event(v))).toBe(false);
  });

  it("a failed file says why, until Retry", async () => {
    await settings({});
    const v = await added("mp4");
    await queueVersion(event(v));
    const job = autoJobs.claim(mac)!;
    expect(autoJobs.fail("mac-1", job.id, "The file could not be read.")).toBe(true);
    expect((await auto()).failed.map((f) => f.versionId)).toEqual([v]);
    expect((await call("POST", "/auto/retry", { versionId: v })).status).toBe(200);
    expect(autoJobs.claim(mac)).not.toBeNull();
  });

  it("goes back in the queue when its Mac goes quiet, and fails after three times", async () => {
    await settings({});
    await queueVersion(event(await added("mp4")));
    for (let i = 0; i < AUTO_LIMITS.tries; i++) {
      macs.online = new Set(["mac-1"]);
      expect(autoJobs.claim(mac)).not.toBeNull();
      macs.online = new Set();
      autoJobs.waits("ana", "mac-1");
    }
    expect(autoJobs.waits("ana", "mac-1")).toBe(false);
    expect((await auto()).failed.at(-1)?.error).toMatch(/three times/);
  });
});

describe("Settings", () => {
  it("shows what is missing", async () => {
    await settings({});
    expect(await auto()).toMatchObject({ can: true });
    ai.configured = false;
    expect(await auto()).toMatchObject({ can: false, why: "Needs an AI provider" });
    ai.configured = true;
    macs.kinds = ["faceblur"]; // a Mac app from before
    expect(await auto()).toMatchObject({ can: false, why: "Needs the Mac app" });
  });
});

describe("workspaces", () => {
  it("covers new files only in a workspace where Face Blur is on: after the update, the one the account works in today", async () => {
    const { setPluginsForTest } = await import("../../api/lib/plugin-workspaces");
    // installed before Face Blur could be on per workspace (the first boot's list names it)
    await setPluginsForTest([plugin], ["blur-faces"]);
    const projects = path.join(dir, "workshop", "projects");
    mkdirSync(projects, { recursive: true });
    for (const [id, name, createdAt] of [["ws-tiny", "Tiny Acrobatics", 1], ["ws-homes", "Tiny Homes", 2]] as const)
      writeFileSync(path.join(projects, `${id}.json`), JSON.stringify({ id, owner: "ana", name, createdAt, updatedAt: createdAt }));
    mkdirSync(path.join(dir, "workshop", "users"), { recursive: true });
    writeFileSync(path.join(dir, "workshop", "users", "ana.json"), JSON.stringify({ currentProjectId: "ws-tiny" }));
    for (const [lib, ws] of [["lib_tiny", "ws-tiny"], ["lib_homes", "ws-homes"]])
      libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'ana', ?, 'local', ?, 0)").run(lib, lib, JSON.stringify({ projectId: ws }));
    await settings({}); // in the workspace this request works in, the current one
    const into = async (lib: string) => {
      const v = await added("jpg");
      return queueVersion({ libraryId: lib, versionId: v, owner: "ana" });
    };
    expect(await into("lib_homes")).toBe(false);
    expect(await into("lib_tiny")).toBe(true);
    // switched on in Tiny Homes too, with the switch there on: covered there as well
    const { pluginWorkspacesApp } = await import("../../api/lib/plugin-workspaces");
    const api = new Hono<{ Variables: { user: unknown } }>();
    api.use(async (c, next) => {
      c.set("user", { username: "ana", role: "user", off: [] });
      await next();
    });
    api.route("/api/plugins", pluginWorkspacesApp);
    const put = await api.request("/api/plugins/blur-faces/workspaces", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ only: ["ws-tiny", "ws-homes"] }) });
    expect(put.status).toBe(200);
    expect(await into("lib_homes")).toBe(true);
  });
});
