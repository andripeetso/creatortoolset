// Face Blur's automatic covers: what is queued when a file comes into the Media Library, a Mac's claim, the AI's answer,
// the covered copy added beside the original, and each way a file ends. Only the person's AI and the Macs are stood in.
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
const macs = vi.hoisted(() => ({ online: new Set<string>(["mac-1"]), kinds: ["faceblur"] as string[] }));
vi.mock("../../api/lib/devices", async (real) => ({
  ...(await real<typeof import("../../api/lib/devices")>()),
  isOnline: (id: string) => macs.online.has(id),
  listDevices: (keep: (d: unknown) => boolean) => [{ id: "mac-1", owner: "ana", name: "Ana's Mac", kinds: macs.kinds }].filter(keep),
}));

const { Hono } = await import("hono");
const { libraryDb } = await import("../../api/library/db");
const { saveToLibrary } = await import("../../api/library/routes");
const { default: plugin, autoJobs, queueVersion, resetAuto, AUTO_LIMITS } = await import("./plugin");

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
const settings = (s: Record<string, unknown>) => call("PUT", "/settings", { mode: "all", who: "Every child's face", look: "blur", ...s });

let n = 0;
/** A file added to Ana's library the way an upload adds one, with its blur answer (marked Blur faces by default); its version id. */
async function added(ext: "mp4" | "jpg" | "m4a", blur: "yes" | "no" = "yes"): Promise<string> {
  const bytes = ext === "jpg" ? Buffer.from([0xff, 0xd8, 0xff, 0xe0, ++n]) : Buffer.from(`\0\0\0\x18ftypmp42${++n}`, "latin1");
  const file = path.join(dir, `in-${n}.${ext}`);
  writeFileSync(file, bytes);
  const r = await saveToLibrary("ana", file, `Tiny take ${n}.${ext}`, [], "lib_a", true);
  if (!r || !("versionId" in r)) throw new Error(`not added: ${JSON.stringify(r)}`);
  libraryDb().prepare("UPDATE assets SET blur = ? WHERE current_version_id = ?").run(blur, r.versionId);
  return r.versionId;
}
const event = (versionId: string) => ({ libraryId: "lib_a", versionId, owner: "ana" });
const assets = () => (libraryDb().prepare("SELECT title FROM assets WHERE library_id = 'lib_a' ORDER BY created_at, title").all() as { title: string }[]).map((a) => a.title);

beforeAll(() => {
  // Upload all: the server keeps what is saved here (under none a save goes to a computer: library/save-on-computer.test.ts)
  libraryDb().prepare(`INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_a', 'ana', 'A', 'local', '{"upload":"all"}', 0)`).run();
});
beforeEach(async () => {
  ai.configured = true;
  macs.online = new Set(["mac-1"]);
  macs.kinds = ["faceblur"];
  // nothing left over from the test before
  await resetAuto();
  rmSync(path.join(dir, "plugins", "blur-faces", "auto.json"), { force: true });
});

describe("what comes into the Media Library", () => {
  it("is queued only for a file marked Blur faces with no blurred render yet, and only photos and videos", async () => {
    expect(await queueVersion(event(await added("mp4", "no")))).toBe(false);
    const done = await added("mp4");
    libraryDb().prepare("UPDATE asset_versions SET blurred_of = sha256 WHERE id = ?").run(done); // a blurred render itself
    expect(await queueVersion(event(done))).toBe(false);
    expect(await queueVersion(event(await added("mp4")))).toBe(true);
    expect(await queueVersion(event(await added("jpg")))).toBe(true);
    expect(await queueVersion(event(await added("m4a")))).toBe(false);
    expect(autoJobs.waits("ana")).toBe(true);
    expect(autoJobs.waits("bo")).toBe(false);
  });

  it("is queued once, even when it is read again", async () => {
    await settings({});
    const v = await added("mp4");
    expect(await queueVersion(event(v))).toBe(true);
    expect(await queueVersion(event(v))).toBe(false);
  });
});

describe("a Mac's job", () => {
  it("hands out the file with the settings, and a file with no face ends with no copy", async () => {
    await settings({ look: "mosaic", strength: 0.9, size: 1.5 });
    const v = await added("mp4");
    await queueVersion(event(v));
    const job = autoJobs.claim(mac)!;
    // the style goes along as text, as a device job's options are
    expect(job).toMatchObject({
      kind: "faceblur",
      options: { mode: "all", look: "mosaic", strength: "0.9", softness: "0.45", size: "1.5", color: "#343434", media: "video" },
    });
    expect(autoJobs.claim(mac)).toBeNull();
    expect((await autoJobs.input("mac-1", job.id))?.type).toBe("video/mp4");
    expect(await autoJobs.input("mac-2", job.id)).toBeNull(); // another Mac's
    const before = assets().length;
    expect(await autoJobs.answer("mac-1", job.id, { nothing: "No face found, nothing written" })).toEqual({ reply: { ok: true } });
    expect(assets().length).toBe(before);
    expect(((await (await call("GET", "/auto")).json()) as { failed: unknown[] }).failed).toEqual([]); // fine: nothing to say
  });

  it("adds the covered copy beside the original, linked to it and never covered again", async () => {
    await settings({});
    const v = await added("jpg");
    await queueVersion(event(v));
    const job = autoJobs.claim(mac)!;
    const copy = path.join(dir, "covered.jpg");
    writeFileSync(copy, Buffer.from("\0\0\0\x18ftypmp42", "latin1"));
    expect(await autoJobs.file("mac-1", job.id, copy, "covered.jpg")).toMatchObject({ status: 400 }); // not a JPEG
    writeFileSync(copy, Buffer.from([0xff, 0xd8, 0xff, 0xdb, 7, 7]));
    expect(await autoJobs.file("mac-1", job.id, copy, "covered.jpg")).toEqual({ reply: { ok: true } });
    const made = libraryDb()
      .prepare("SELECT a.title, a.library_id, d.version_id FROM derived_from d JOIN asset_versions v ON v.id = d.version_id JOIN assets a ON a.id = v.asset_id WHERE d.source_version_id = ?")
      .get(v) as { title: string; library_id: string; version_id: string };
    expect(made.library_id).toBe("lib_a"); // the original's library, so the original's workspace
    expect(made.title).toMatch(/ blurred$/);
    expect(libraryDb().prepare("SELECT 1 FROM asset_versions WHERE id = ?").get(v)).toBeTruthy(); // the original stays
    expect(await queueVersion(event(made.version_id))).toBe(false); // the copy comes in too: never covered again
  });

  it("in Only some faces, a failed AI writes nothing and the file says why, until Try again", async () => {
    await settings({ mode: "some" });
    const v = await added("mp4");
    await queueVersion(event(v));
    const job = autoJobs.claim(mac)!;
    const faces = { faces: [{ id: "F1", picture: "/9j/AAAA", note: "middle left of the frame; 12% of its width; seen for 4.2 s" }] };
    ai.configured = false;
    const r = await autoJobs.answer("mac-1", job.id, faces);
    expect(r).toMatchObject({ status: 409 });
    expect((r as { error: string }).error).toMatch(/Nothing was blurred\.$/);
    expect(await autoJobs.file("mac-1", job.id, path.join(dir, "x"), "x")).toMatchObject({ status: 404 }); // no longer the Mac's
    const failed = ((await (await call("GET", "/auto")).json()) as { failed: unknown }).failed as { versionId: string; error: string }[];
    expect(failed.map((f) => f.versionId)).toEqual([v]);
    expect((await call("POST", "/auto/retry", { versionId: v })).status).toBe(200);
    ai.configured = true;
    ai.answer = async () => '{"blur": ["F1"]}';
    const again = autoJobs.claim(mac)!;
    expect(await autoJobs.answer("mac-1", again.id, faces)).toEqual({ reply: { blur: ["F1"] } });
  });

  it("goes back in the queue when its Mac goes quiet, and fails after three times", async () => {
    await settings({});
    await queueVersion(event(await added("mp4")));
    for (let i = 0; i < AUTO_LIMITS.tries; i++) {
      macs.online = new Set(["mac-1"]);
      expect(autoJobs.claim(mac)).not.toBeNull();
      macs.online = new Set();
      autoJobs.waits("ana");
    }
    expect(autoJobs.waits("ana")).toBe(false);
    const failed = ((await (await call("GET", "/auto")).json()) as { failed: unknown }).failed as { error: string }[];
    expect(failed.at(-1)?.error).toMatch(/three times/);
  });
});

describe("the switch", () => {
  it("shows where a Mac of this account can cover, and says why not elsewhere", async () => {
    expect(await (await call("GET", "/auto")).json()).toMatchObject({ can: true });
    macs.kinds = [];
    const r = (await (await call("GET", "/auto")).json()) as { can: boolean; why: string };
    expect(r.can).toBe(false);
    expect(r.why).toMatch(/Mac app/);
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
