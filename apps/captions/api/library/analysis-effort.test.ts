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

// every file here is a 30-second clip with sound: a browser plays it as it is, and the sound is one a transcript reads
vi.mock("./media/probe", async (real) => ({
  ...(await real<typeof import("./media/probe")>()),
  probe: () => Promise.resolve({ duration: 30, width: 1280, height: 720, fps: 30, rotation: 0, format: "mp4", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" }),
}));

const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { tick } = await import("./worker");
const { queueLook } = await import("./shots");

afterAll(() => {
  delete process.env.LIBRARY_DISK_RESERVE_GB;
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
