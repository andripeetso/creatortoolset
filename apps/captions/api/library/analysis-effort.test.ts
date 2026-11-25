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
  it("changing Effort queues no proxy for the clips without one; turning hosting on does", async () => {
    const id = await upload("lib_off", "old.mp4");
    await drain(["probe"]);
    d.prepare("DELETE FROM jobs WHERE version_id = ? AND kind = 'proxy'").run(id); // a clip from before, never given a proxy
    await patch(flagsOf("medium"));
    expect(jobs(id)).not.toContain("proxy");
    await patch({ upload: "none" });
    await patch({ upload: "all" });
    expect(jobs(id)).toContain("proxy");
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
    const old = await upload("lib_blur", "before-all.mp4");
    await drain(["probe"]);
    const asked: string[] = [];
    const off = onEvent("library.version.blur", (e) => void asked.push(e.versionId));
    await patch({ blurFaces: true, blurExisting: true, proxy: false, upload: "proxies" });
    off();
    expect(blurOf(old)).toBeNull(); // follows the switch: yes
    expect(asked).toContain(old);
    await patch({ blurFaces: false });
  });
});

describe("files already blurred when they came in", () => {
  const mark = (body: object) => app.request("/api/library/lib_on/already-blurred", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const row = (id: string) => d.prepare("SELECT v.blurred_of, v.sha256, v.full_sha256 FROM asset_versions v WHERE v.id = ?").get(id) as { blurred_of: string | null; sha256: string; full_sha256: string | null };
  it("a SHA-256 marks that file as its own blurred copy and no other; all marks the rest but a file kept as filmed; Undo; nothing queued", async () => {
    const [master, other, kept] = [await upload("lib_on", "master.mp4"), await upload("lib_on", "other.mp4"), await upload("lib_on", "kept.mp4")];
    d.prepare("UPDATE assets SET blur = 'no' WHERE current_version_id = ?").run(kept);
    await drain(["probe"]);
    const sha = row(master).full_sha256 ?? row(master).sha256;
    expect((await mark({ sha256: ["not-a-sha"] })).status).toBe(400);
    const before = (d.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;
    expect(await (await mark({ sha256: [sha] })).json()).toEqual({ files: 1, versions: [master] });
    expect(row(master).blurred_of).toBe(sha);
    expect(row(other).blurred_of).toBeNull();
    const all = (await (await mark({ all: true })).json()) as { files: number; versions: string[] };
    expect(row(other).blurred_of).not.toBeNull();
    expect(row(kept).blurred_of).toBeNull(); // kept as filmed on purpose
    expect(((await (await mark({ unmark: all.versions })).json()) as { files: number }).files).toBe(all.files);
    expect(row(other).blurred_of).toBeNull();
    expect(row(master).blurred_of).toBe(sha); // not part of that Undo
    expect((d.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n).toBe(before);
  });
});
