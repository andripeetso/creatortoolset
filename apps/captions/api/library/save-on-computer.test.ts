import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { WORK_V, type TaskPackage } from "../../contracts/work";

/**
 * Upload none (owner, 2026-11-19): every save into the library lands on the asker's computer, in the workspace's first
 * Source media folder (a finished video: its Final exports folder), through the computer task path, indexed there in place.
 * Nothing is kept on the server. With the computer offline the save waits with one line naming the folder. Under any
 * other Upload the server keeps its copy as before.
 */

const root = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "save-on-computer-"));
const dataDir = path.join(root, "data");
mkdirSync(dataDir);
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = "save-on-computer-test-secret";
process.env.LIBRARY_DISK_RESERVE_GB = "0";
process.env.ELEVENLABS_API_KEY = "";
vi.mock("../plugins.gen", () => ({ serverPlugins: [] }));

// a finished export of tina's, as the export queue leaves one on disk
const exportId = "00000000-0000-4000-8000-000000000001";
mkdirSync(path.join(dataDir, "exports", exportId), { recursive: true });
writeFileSync(path.join(dataDir, "exports", exportId, "out.mp4"), "tiny acrobatics final reel");
writeFileSync(
  path.join(dataDir, "exports", exportId, "job.json"),
  JSON.stringify({ id: exportId, owner: "tina", status: "done", kind: "burn", engine: "native", format: "h264", ext: "mp4", filename: "Tiny reel.mp4", progress: 1, createdAt: Date.now(), finishedAt: Date.now(), params: { duration: 10, width: 1080, height: 1920 } }),
);

const app = (await import("../boot")).default;
const { createUser, findUser, setOff } = await import("../users");
const { pairDevice, setDeviceWork, touchDevice } = await import("../lib/devices");
const { client } = await import("../work/computer");
const { CLAIM_POLL } = await import("../work/routes");
const { runTaskJob, taskTick } = await import("../work/tasks");
const { writeServerWork } = await import("../work/server-work");
const { changeStorage } = await import("../devices-storage");
const { ensureLibrary } = await import("./access");
const { libraryDb } = await import("./db");
const { COMPUTER_SAVE } = await import("./routes");
const { useFile } = await import("../assistant-files");
const { makeVoice } = await import("../editor/voice");
const { findAndAdd } = await import("./sfx");
const { saveMyKey } = await import("../my-keys");
afterAll(() => rmSync(root, { recursive: true, force: true }));

COMPUTER_SAVE.ms = 10_000;
CLAIM_POLL.holdMs = 0;
// the server's video work on: a save under none still never runs here
writeServerWork({ on: true });

const d = libraryDb();
const cookies: Record<string, string> = {};
/** An account, its library at `upload` (set up), its Mac with a Source media and a Final exports folder. */
async function account(name: string, upload: string) {
  setOff(createUser(name, "password1", { role: "user" }), []);
  const r = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: name, password: "password1" }) });
  cookies[name] = r.headers.get("set-cookie")!.split(";")[0]!;
  const lib = (await ensureLibrary(name))!;
  d.prepare("UPDATE libraries SET settings = json_set(COALESCE(settings, '{}'), '$.upload', ?, '$.setupAt', '2026-11-01T00:00:00.000Z') WHERE id = ?").run(upload, lib);
  const mac = pairDevice(name, `${name[0]!.toUpperCase()}${name.slice(1)}'s Mac`);
  const disk = path.join(root, "computers", name);
  const media = path.join(disk, "Source media");
  const finished = path.join(disk, "Final exports");
  await changeStorage(name, (st) => {
    const at = { host: mac.device.id };
    st.folders.push({ id: `${name}-media`, role: "footage", name: "Source media", origin: { ...at, path: media }, make: true, createdAt: Date.now(), reach: {} });
    st.folders.push({ id: `${name}-exports`, role: "library", name: "Final exports", origin: { ...at, path: finished }, make: true, createdAt: Date.now(), reach: {} });
  });
  const o = { server: "http://server.test", token: mac.token, beatMs: 20, fetch: (u: string, i?: RequestInit) => Promise.resolve(app.request(u, i)) };
  const c = client(o);
  /** The Mac comes online: its worker runs library saves. */
  const online = () => {
    setDeviceWork(mac.device.id, { v: WORK_V, steps: [], tasks: ["library-save"] });
    touchDevice(mac.device.id);
  };
  /** The Mac's worker takes the next save and runs it. */
  const takes = async () => {
    for (let i = 0; i < 400; i++) {
      const t = (await c.post<{ task?: TaskPackage }>("work/claim", { v: WORK_V, steps: [], tasks: ["library-save"] })).task;
      if (t) return runTaskJob(t, c, o);
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("no save to take");
  };
  return { lib, mac, media, finished, online, takes };
}

/** Every file under the server's data folder holding exactly `text` (but `except`). */
function serverCopies(text: string, except: string[] = []): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (!except.includes(p) && statSync(p).size === Buffer.byteLength(text) && readFileSync(p, "utf8") === text) out.push(p);
    }
  };
  walk(dataDir);
  return out;
}

/** A file dropped in the chat. */
function drop(user: string, id: string, name: string, text: string): string {
  const dir = path.join(dataDir, "assistant", "files", user, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "file"), text);
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, name, mime: "video/mp4", size: text.length, at: Date.now() }));
  return path.join(dir, "file");
}

/** The version as the library has it: in place on the Mac, verified there, with no stored file. */
function inPlace(versionId: string) {
  const v = d.prepare("SELECT source_key, mac_path, mac_device FROM asset_versions WHERE id = ?").get(versionId) as { source_key: string; mac_path: string; mac_device: string };
  const place = d.prepare("SELECT device, folder_id, path, state FROM version_places WHERE version_id = ?").get(versionId) as { device: string; folder_id: string; path: string; state: string };
  return { ...v, place };
}

const tina = await account("tina", "none");
tina.online();

describe("Upload none: a save lands on the computer, indexed in place", () => {
  it("use_file to the library: into Source media on the Mac, nothing kept on the server", async () => {
    const src = drop("tina", "00000000-0000-4000-8000-0000000000a1", "Handstand.mp4", "tiny acrobatics handstand");
    const [saved] = await Promise.all([useFile(findUser("tina") as never, "00000000-0000-4000-8000-0000000000a1", "library"), tina.takes()]);
    expect(saved).toMatchObject({ to: "library", libraryId: tina.lib, versionId: expect.any(String) });
    const at = path.join(tina.media, "Handstand.mp4");
    expect(readFileSync(at, "utf8")).toBe("tiny acrobatics handstand");
    const v = inPlace(saved.versionId!);
    expect(v).toMatchObject({ mac_path: at, mac_device: tina.mac.device.id, place: { device: tina.mac.device.id, folder_id: "tina-media", path: at, state: "verified" } });
    expect(v.source_key).toMatch(/^mac:/);
    expect(serverCopies("tiny acrobatics handstand", [src])).toEqual([]);
  });

  it("the chat's Save to library (POST /api/assistant/files/:id/use): the same", async () => {
    const src = drop("tina", "00000000-0000-4000-8000-0000000000a2", "Cartwheel.mp4", "tiny acrobatics cartwheel");
    const [res] = await Promise.all([
      app.request("/api/assistant/files/00000000-0000-4000-8000-0000000000a2/use", { method: "POST", headers: { cookie: cookies.tina!, "content-type": "application/json" }, body: JSON.stringify({ to: "library" }) }),
      tina.takes(),
    ]);
    expect(res.status).toBe(200);
    const saved = (await res.json()) as { versionId: string };
    const at = path.join(tina.media, "Cartwheel.mp4");
    expect(inPlace(saved.versionId)).toMatchObject({ mac_path: at, place: { folder_id: "tina-media", state: "verified" } });
    expect(serverCopies("tiny acrobatics cartwheel", [src])).toEqual([]);
  });

  it("a voice: spoken, then into Source media on the Mac", async () => {
    saveMyKey("tina", "ELEVENLABS_API_KEY", "tinas-own");
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://api.elevenlabs.io/")) return real(input, init);
      if (url.includes("/v2/voices")) return Response.json({ voices: [{ voice_id: "v_sam", name: "Sam", category: "premade" }] });
      return new Response("tiny acrobatics voice", { headers: { "content-type": "audio/mpeg" } });
    });
    try {
      const [made] = await Promise.all([makeVoice(findUser("tina") as never, { text: "Hello there", voice: "Sam", name: "Hello" }), tina.takes()]);
      const at = path.join(tina.media, "Hello.mp3");
      expect(inPlace(made.versionId)).toMatchObject({ mac_path: at, place: { folder_id: "tina-media", state: "verified" } });
      expect(readFileSync(at, "utf8")).toBe("tiny acrobatics voice");
      expect(serverCopies("tiny acrobatics voice")).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Export → Library: a finished video goes to Final exports", async () => {
    const [res] = await Promise.all([app.request(`/api/exports/${exportId}/library`, { method: "POST", headers: { cookie: cookies.tina!, "content-type": "application/json" }, body: "{}" }), tina.takes()]);
    expect(res.status).toBe(200);
    const saved = (await res.json()) as { versionId: string };
    const at = path.join(tina.finished, "Tiny reel.mp4");
    expect(inPlace(saved.versionId)).toMatchObject({ mac_path: at, place: { folder_id: "tina-exports", state: "verified" } });
    expect(existsSync(path.join(tina.media, "Tiny reel.mp4"))).toBe(false);
    expect(serverCopies("tiny acrobatics final reel", [path.join(dataDir, "exports", exportId, "out.mp4")])).toEqual([]);
  });

  it("sound effects (the assistant's find_sound_effects): into Source media, in the library's Sound effects folder", async () => {
    // one task per sound: the Mac takes them as they come
    let done = false;
    const worker = (async () => {
      while (!done) await tina.takes().catch(() => {});
    })();
    const r = await findAndAdd("tina", { count: 2 });
    done = true;
    await worker;
    expect(r).toMatchObject({ library: tina.lib, failed: 0 });
    expect((r as { added: unknown[] }).added).toHaveLength(2);
    const rows = d
      .prepare(
        `SELECT v.source_key, p.folder_id, EXISTS (SELECT 1 FROM collection_items ci JOIN collections c ON c.id = ci.collection_id
           WHERE ci.asset_id = a.id AND c.name = 'Sound effects') AS filed
         FROM asset_versions v JOIN assets a ON a.id = v.asset_id JOIN asset_tags t ON t.asset_id = a.id AND t.tag = 'sound effect'
         LEFT JOIN version_places p ON p.version_id = v.id WHERE a.library_id = ? AND v.mac_path LIKE '%.m4a'`,
      )
      .all(tina.lib) as { source_key: string; folder_id: string; filed: number }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ source_key: expect.stringMatching(/^mac:/), folder_id: "tina-media", filed: 1 });
    expect(readdirSync(tina.media).filter((n) => n.endsWith(".m4a"))).toHaveLength(2);
  });
});

describe("Upload none with the computer offline", () => {
  it("the save waits with one line naming the folder; nothing lands in the library; it lands once the Mac is back", async () => {
    const uma = await account("uma", "none");
    drop("uma", "00000000-0000-4000-8000-0000000000b1", "Flip.mp4", "tiny acrobatics flip");
    const saved = await useFile(findUser("uma") as never, "00000000-0000-4000-8000-0000000000b1", "library");
    expect(saved).toMatchObject({ waiting: true, note: `Uma's Mac is offline. I'll save it to Source media (${uma.media}) when it's back.` });
    expect(d.prepare("SELECT COUNT(*) AS n FROM assets WHERE library_id = ?").get(uma.lib)).toEqual({ n: 0 });
    expect(existsSync(path.join(uma.media, "Flip.mp4"))).toBe(false);
    // the server's video work is on, and still the server never takes it
    await taskTick();
    expect(d.prepare("SELECT state, held_by FROM computer_tasks WHERE actor = 'uma'").get()).toEqual({ state: "queued", held_by: null });
    expect(d.prepare("SELECT COUNT(*) AS n FROM assets WHERE library_id = ?").get(uma.lib)).toEqual({ n: 0 });
    uma.online();
    expect(await uma.takes()).toBe("done");
    const at = path.join(uma.media, "Flip.mp4");
    expect(readFileSync(at, "utf8")).toBe("tiny acrobatics flip");
    const v = d.prepare("SELECT v.id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ?").get(uma.lib) as { id: string };
    expect(inPlace(v.id)).toMatchObject({ mac_path: at, place: { folder_id: "uma-media", state: "verified" } });
    // the bytes it held for the Mac are gone with the task
    expect(serverCopies("tiny acrobatics flip", [path.join(dataDir, "assistant", "files", "uma", "00000000-0000-4000-8000-0000000000b1", "file")])).toEqual([]);
  });

  it("with no Source media folder on any computer, the answer says to add one; nothing is kept", async () => {
    const wes = await account("wes", "none");
    await changeStorage("wes", (st) => void (st.folders = st.folders.filter((f) => f.role !== "footage")));
    drop("wes", "00000000-0000-4000-8000-0000000000c1", "Roll.mp4", "tiny acrobatics roll");
    await expect(useFile(findUser("wes") as never, "00000000-0000-4000-8000-0000000000c1", "library")).rejects.toThrow(/Source media folder/);
    expect(d.prepare("SELECT COUNT(*) AS n FROM assets WHERE library_id = ?").get(wes.lib)).toEqual({ n: 0 });
  });
});

describe("any other Upload: as before", () => {
  it("under all the server keeps its copy and no computer task is made", async () => {
    const vic = await account("vic", "all");
    vic.online();
    drop("vic", "00000000-0000-4000-8000-0000000000d1", "Bridge.mp4", "tiny acrobatics bridge");
    const saved = await useFile(findUser("vic") as never, "00000000-0000-4000-8000-0000000000d1", "library");
    const v = d.prepare("SELECT source_key, mac_path FROM asset_versions WHERE id = ?").get(saved.versionId!) as { source_key: string; mac_path: string | null };
    expect(v).toEqual({ source_key: `libraries/${vic.lib}/v/${saved.versionId}/source`, mac_path: null });
    expect(d.prepare("SELECT COUNT(*) AS n FROM computer_tasks WHERE actor = 'vic'").get()).toEqual({ n: 0 });
    expect(existsSync(path.join(vic.media, "Bridge.mp4"))).toBe(false);
  });
});
