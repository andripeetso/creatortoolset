import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import { flagsOf } from "../../contracts/library";
import type { AuthVars } from "../auth";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-effort-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_DISK_RESERVE_GB = "0";
// the studio suite runs hosted (CT_MODE=hosted), where a server does video work only by a plug-in's grant; these tests are a
// server's own, so the mode is cleared here and put back after (the server-work setup file turns its work on)
const hostedWas = process.env.CT_MODE;
delete process.env.CT_MODE;

// every file here is a 30-second clip with sound: a browser plays it as it is, and the sound is one a transcript reads
vi.mock("./media/probe", async (real) => ({
  ...(await real<typeof import("./media/probe")>()),
  probe: () => Promise.resolve({ duration: 30, width: 1280, height: 720, fps: 30, rotation: 0, format: "mp4", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" }),
}));

const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { tick } = await import("./worker");
const { queueLook } = await import("./shots");
const { onEvent } = await import("../lib/events");

afterAll(() => {
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  if (hostedWas !== undefined) process.env.CT_MODE = hostedWas;
  rmSync(dir, { recursive: true, force: true });
});

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: "owner-a", role: "user" } as never);
  return next();
});
app.route("/api/library", libraryApp);

const d = libraryDb();
// Analysis effort Off: every step's flag off (flagsOf), the proxies left as they are; and the default one for a control
d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_off', 'owner-a', 'Off', 'local', ?, 0)").run(
  JSON.stringify({ upload: "all", proxy: false, ...flagsOf("off") }),
);
d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_on', 'owner-a', 'On', 'local', ?, 0)").run(
  JSON.stringify({ upload: "all", proxy: false }),
);
d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_blur', 'owner-a', 'Blur', 'local', ?, 0)").run(
  JSON.stringify({ upload: "all", proxy: false, ...flagsOf("off") }),
);

/** A file sent from a Mac and added to `lib` (as the Mac app's upload does); returns its version id. */
async function upload(lib: string, name: string): Promise<string> {
  const body = Buffer.from(`${lib} ${name} original`);
  const post = (url: string, init: RequestInit = {}) => app.request(url, { method: "POST", ...init });
  const init = (await (
    await post(`/api/library/${lib}/uploads`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: name, size: body.length, fromPath: `/Users/tiny/Movies/${name}`, fromDevice: "mac-1" }),
    })
  ).json()) as { id: string };
  await app.request(`/api/library/uploads/${init.id}`, { method: "PATCH", headers: { "upload-offset": "0", "content-length": String(body.length) }, body });
  const id = ((await (await post(`/api/library/uploads/${init.id}/finish`)).json()) as { versionId: string }).versionId;
  d.prepare("INSERT INTO version_places (version_id, device, path, confirmed_at, state) VALUES (?, 'mac-1', ?, ?, 'verified')").run(id, `/Users/tiny/Movies/${name}`, Date.now());
  return id;
}

const jobs = (id: string) => (d.prepare("SELECT kind FROM jobs WHERE version_id = ? ORDER BY kind").all(id) as { kind: string }[]).map((j) => j.kind);
/** Runs the queue until nothing is due (bounded: a failed step waits, it never spins here). */
async function drain(kinds?: string[]): Promise<void> {
  for (let n = 0; n < 40 && (await tick(Date.now(), kinds)); n++);
}

describe("Analysis effort Off", () => {
  it("a 3-clip import makes no AI call: no description, transcript, look, search by meaning or provider request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const clips = [await upload("lib_off", "one.mp4"), await upload("lib_off", "two.mp4"), await upload("lib_off", "three.mp4")];
    await drain();
    for (const id of clips) {
      expect(jobs(id)).toContain("thumb"); // the pictures still come: no AI
      expect(jobs(id)).not.toEqual(expect.arrayContaining(["describe"]));
      expect(jobs(id)).not.toEqual(expect.arrayContaining(["transcribe"]));
      expect(jobs(id)).not.toEqual(expect.arrayContaining(["look"]));
      expect(jobs(id)).not.toEqual(expect.arrayContaining(["embed"]));
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("the same import with the steps on queues their AI jobs (the control for the test above)", async () => {
    const id = await upload("lib_on", "control.mp4");
    await drain(["probe"]);
    expect(jobs(id)).toEqual(expect.arrayContaining(["describe", "transcribe"]));
  });

  it("an edit's own ask still gets a clip's transcript, though the import's is skipped", async () => {
    const { enqueueJob } = await import("./jobs");
    const id = await upload("lib_off", "talk.mp4");
    await drain(["probe"]);
    expect(jobs(id)).not.toContain("transcribe");
    enqueueJob(d, "lib_off", id, "transcribe", "owner-a", true);
    expect(jobs(id)).toContain("transcribe");
  });

  it("an edit's own ask still gets a clip's shot descriptions, and a sweep's does not", async () => {
    const [asked, swept] = [await upload("lib_off", "asked.mp4"), await upload("lib_off", "swept.mp4")];
    await drain(["probe"]);
    d.prepare("UPDATE assets SET roll = 'b' WHERE current_version_id IN (?, ?)").run(asked, swept);
    expect(queueLook(d, swept, "owner-a")).toBe(false);
    expect(queueLook(d, asked, "owner-a", false, true)).toBe(true);
    expect(jobs(asked)).toContain("look");
    expect(jobs(swept)).not.toContain("look");
  });
});

describe("a settings save under Hosted proxies", () => {
  const patch = (settings: object) => app.request("/api/library/lib_off", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings }) });
  it("no save queues a proxy for the clips already here: not Effort, not hosting, not the switch; Make for the missing does", async () => {
    const id = await upload("lib_off", "old.mp4");
    await drain(["probe"]);
    d.prepare("DELETE FROM jobs WHERE version_id = ? AND kind = 'proxy'").run(id); // a clip from before, never given a proxy
    await patch(flagsOf("medium"));
    expect(jobs(id)).not.toContain("proxy");
    await patch({ upload: "none" });
    await patch({ upload: "all" }); // the switch is off: hosting alone makes none (owner, 2026-11-25)
    expect(jobs(id)).not.toContain("proxy");
    await patch({ upload: "none", proxy: true });
    await patch({ upload: "all" }); // the switch on and hosting on: still nothing for a clip from before (owner: a switch never touches old files)
    expect(jobs(id)).not.toContain("proxy");
    await app.request("/api/library/lib_off/made/proxy", { method: "POST" });
    expect(jobs(id)).toContain("proxy");
  });
  it("Generate proxies off, the server keeping only proxies: a file it holds keeps its waiting proxy, a computer's file loses its", async () => {
    await patch({ upload: "all", proxy: true });
    const [held, onMac] = [await upload("lib_off", "held.mp4"), await upload("lib_off", "on-a-mac.mp4")];
    await drain(["probe"]);
    d.prepare("UPDATE asset_versions SET source_key = 'mac:' || id WHERE id = ?").run(onMac);
    await patch({ upload: "proxies" });
    const { enqueueJob } = await import("./jobs");
    for (const v of [held, onMac]) enqueueJob(d, "lib_off", v, "proxy", "owner-a", true);
    for (const v of [held, onMac]) expect(jobs(v), v).toContain("proxy");
    await patch({ proxy: false });
    expect(jobs(held)).toContain("proxy"); // all that plays of it here: nothing would queue it again
    expect(jobs(onMac)).not.toContain("proxy");
    d.prepare("DELETE FROM jobs WHERE version_id IN (?, ?)").run(held, onMac);
    await patch({ upload: "all" });
  });
});

describe("Blur faces turned on and off", () => {
  const patch = (settings: object) => app.request("/api/library/lib_blur", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings }) });
  const blurOf = (id: string) => (d.prepare("SELECT a.blur FROM assets a JOIN asset_versions v ON v.asset_id = a.id WHERE v.id = ?").get(id) as { blur: string | null }).blur;
  it("on: the clips already here stay as filmed (this library only); off again queues no proxy for every clip", async () => {
    const old = await upload("lib_blur", "before.mp4");
    await drain(["probe"]);
    await patch({ blurFaces: true, proxy: false, upload: "proxies" });
    expect(blurOf(old)).toBe("no");
    // only this library's clips get the answer; a file added later has none, so it follows the switch (blurred)
    expect(d.prepare("SELECT COUNT(*) AS n FROM assets WHERE library_id != 'lib_blur' AND blur IS NOT NULL").get()).toEqual({ n: 0 });
    d.prepare("DELETE FROM jobs WHERE version_id = ? AND kind = 'proxy'").run(old);
    await patch({ blurFaces: false });
    expect(jobs(old)).not.toContain("proxy");
  });
  it("on with Blur all files: the clips already here are blurred, each one handed to Face Blur", async () => {
    await patch({ blurFaces: false, upload: "all" });
    const [old, kept] = [await upload("lib_blur", "before-all.mp4"), await upload("lib_blur", "kept-all.mp4")];
    await drain(["probe"]);
    d.prepare("UPDATE assets SET blur = 'no' WHERE current_version_id = ?").run(kept);
    const asked: string[] = [];
    const off = onEvent("library.version.blur", (e) => void asked.push(e.versionId));
    await patch({ blurFaces: true, blurExisting: true, proxy: false, upload: "proxies" });
    off();
    expect(blurOf(old)).toBeNull(); // follows the switch: yes
    expect(asked).toContain(old);
    expect(asked).not.toContain(kept); // kept as filmed on purpose
    await patch({ blurFaces: false });
  });
  it("on with New files only: the clips already here are left as they are, What's made counts them as missing, and its Make hands them to Face Blur", async () => {
    const { libraryMade } = await import("./made");
    await patch({ blurFaces: false, upload: "all" });
    const [old, kept] = [await upload("lib_blur", "before-skip.mp4"), await upload("lib_blur", "kept-skip.mp4")];
    await drain(["probe"]);
    d.prepare("UPDATE assets SET blur = 'no' WHERE current_version_id = ?").run(kept);
    const mark = (v: string) => d.prepare("SELECT blur, blur_note FROM assets WHERE current_version_id = ?").get(v) as { blur: string | null; blur_note: string | null };
    const row = async () => (await libraryMade("lib_blur", "tiny")).find((m) => m.kind === "blur")!;
    // Blur faces off: a file nobody answered for is what the switch would ask about; one kept as filmed is not
    const missing = (await row()).missing;
    expect(missing).toBeGreaterThan(0);
    await patch({ blurFaces: true }); // New files only
    expect(mark(old)).toEqual({ blur: "no", blur_note: "skipped" });
    expect(mark(kept)).toEqual({ blur: "no", blur_note: null });
    expect(await row()).toMatchObject({ missing, queued: 0 }); // nothing ran, nothing is waiting: the same files are missing
    const asked: string[] = [];
    const off = onEvent("library.version.blur", (e) => void asked.push(e.versionId));
    const made = (await (await app.request("/api/library/lib_blur/made/blur", { method: "POST" })).json()) as { files: number };
    off();
    expect(made.files).toBeGreaterThan(0);
    expect(asked).toContain(old);
    expect(asked).not.toContain(kept);
    expect(mark(old)).toEqual({ blur: "yes", blur_note: null });
    expect(await row()).toMatchObject({ missing: 0 });
    // a person's answer says why from then on: no note left
    d.prepare("UPDATE assets SET blur = 'no', blur_note = 'skipped' WHERE current_version_id = ?").run(old);
    const asset = (d.prepare("SELECT id FROM assets WHERE current_version_id = ?").get(old) as { id: string }).id;
    await app.request(`/api/library/lib_blur/assets/${asset}/blur`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ blur: "no" }) });
    expect(mark(old)).toEqual({ blur: "no", blur_note: null });
    // with Blur faces off there is nothing to make: a file marked yes would wait for a blur nobody runs
    await patch({ blurFaces: false });
    expect((await app.request("/api/library/lib_blur/made/blur", { method: "POST" })).status).toBe(400);
  });
});

