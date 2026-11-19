import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { WORK_V, type TaskPackage } from "../../contracts/work";
import type { MadeVoice } from "../../contracts/editor";

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
// a 100 GB disk, whatever disk the test runs on: what the staging folder holds is not free, as on a real disk
vi.mock("../lib/uploads", async (real) => {
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const used = () => {
    const dir = join(process.env.DATA_DIR!, "library", "staging");
    try {
      return readdirSync(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0);
    } catch {
      return 0;
    }
  };
  return { ...(await real<typeof import("../lib/uploads")>()), freeBytes: async () => 100 * 1024 ** 3 - used() };
});

// a finished export of tina's, as the export queue leaves one on disk
const exportId = "00000000-0000-4000-8000-000000000001";
mkdirSync(path.join(dataDir, "exports", exportId), { recursive: true });
writeFileSync(path.join(dataDir, "exports", exportId, "out.mp4"), "tiny acrobatics final reel");
writeFileSync(
  path.join(dataDir, "exports", exportId, "job.json"),
  JSON.stringify({ id: exportId, owner: "tina", status: "done", kind: "burn", engine: "native", format: "h264", ext: "mp4", filename: "Tiny reel.mp4", progress: 1, createdAt: Date.now(), finishedAt: Date.now(), params: { duration: 10, width: 1080, height: 1920 } }),
);

// a finished 1080p export of eve's, not yet sent to Finals
const eveExport = "00000000-0000-4000-8000-000000000002";
mkdirSync(path.join(dataDir, "exports", eveExport), { recursive: true });
writeFileSync(path.join(dataDir, "exports", eveExport, "out.mp4"), "tiny acrobatics eve's final");
writeFileSync(
  path.join(dataDir, "exports", eveExport, "job.json"),
  JSON.stringify({ id: eveExport, owner: "eve", status: "done", kind: "burn", engine: "native", format: "h264", ext: "mp4", filename: "Eve reel.mp4", progress: 1, createdAt: Date.now(), finishedAt: Date.now(), params: { duration: 10, width: 1080, height: 1920 } }),
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
const { COMPUTER_SAVE, NO_COMPUTER } = await import("./routes");
const { useFile } = await import("../assistant-files");
const { makeVoice } = await import("../editor/voice");
const { findAndAdd } = await import("./sfx");
const { saveMyKey } = await import("../my-keys");
const { addToFinals } = await import("./finals");
const { allEdits } = await import("../editor/store");
afterAll(() => rmSync(root, { recursive: true, force: true }));

COMPUTER_SAVE.ms = 10_000;
CLAIM_POLL.holdMs = 0;
// the server's video work on: a save under none still never runs here
writeServerWork({ on: true });

const d = libraryDb();
const cookies: Record<string, string> = {};
/** An account, its library at `upload` (set up), its Mac with a Source media and a Final exports folder. */
async function account(name: string, upload: string, role: "user" | "admin" = "user") {
  setOff(createUser(name, "password1", { role }), []);
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

/** ElevenLabs answering with `speech` as the voice's bytes, while `run` runs. */
async function elevenLabs(speech: string, run: () => Promise<void>) {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://api.elevenlabs.io/")) return real(input, init);
    if (url.includes("/v2/voices")) return Response.json({ voices: [{ voice_id: "v_sam", name: "Sam", category: "premade" }] });
    return new Response(speech, { headers: { "content-type": "audio/mpeg" } });
  });
  try {
    await run();
  } finally {
    vi.unstubAllGlobals();
  }
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
    await elevenLabs("tiny acrobatics voice", async () => {
      const [made] = await Promise.all([makeVoice(findUser("tina") as never, { text: "Hello there", voice: "Sam", name: "Hello" }), tina.takes()]);
      const at = path.join(tina.media, "Hello.mp3");
      expect(inPlace((made as MadeVoice).versionId)).toMatchObject({ mac_path: at, place: { folder_id: "tina-media", state: "verified" } });
      expect(readFileSync(at, "utf8")).toBe("tiny acrobatics voice");
      expect(serverCopies("tiny acrobatics voice")).toEqual([]);
    });
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

describe("which folder, and no computer at all", () => {
  it("the workspace's own Source media folder comes before one for every workspace, whatever the list order", async () => {
    const ora = await account("ora", "none");
    const every = path.join(root, "computers", "ora", "Every workspace");
    // the folder for every workspace listed first
    await changeStorage("ora", (st) => void st.folders.unshift({ id: "ora-every", role: "footage", name: "Every workspace", workspace: "*", origin: { host: ora.mac.device.id, path: every }, make: true, createdAt: Date.now(), reach: {} }));
    ora.online();
    drop("ora", "00000000-0000-4000-8000-0000000000e1", "Pike.mp4", "tiny acrobatics pike");
    const [saved] = await Promise.all([useFile(findUser("ora") as never, "00000000-0000-4000-8000-0000000000e1", "library"), ora.takes()]);
    expect(inPlace(saved.versionId!)).toMatchObject({ mac_path: path.join(ora.media, "Pike.mp4"), place: { folder_id: "ora-media" } });
    expect(existsSync(path.join(every, "Pike.mp4"))).toBe(false);
  });

  it("with no computer paired at all, the answer says what to do in one sentence; nothing is kept", async () => {
    setOff(createUser("pia", "password1", { role: "user" }), []);
    const lib = (await ensureLibrary("pia"))!;
    d.prepare("UPDATE libraries SET settings = json_set(COALESCE(settings, '{}'), '$.upload', 'none', '$.setupAt', '2026-11-01T00:00:00.000Z') WHERE id = ?").run(lib);
    const src = drop("pia", "00000000-0000-4000-8000-0000000000f1", "Tuck.mp4", "tiny acrobatics tuck");
    await expect(useFile(findUser("pia") as never, "00000000-0000-4000-8000-0000000000f1", "library")).rejects.toThrow(NO_COMPUTER);
    expect(NO_COMPUTER).toBe("Add a computer, or turn on Originals in Settings → Media Library.");
    expect(d.prepare("SELECT COUNT(*) AS n FROM assets WHERE library_id = ?").get(lib)).toEqual({ n: 0 });
    expect(d.prepare("SELECT COUNT(*) AS n FROM computer_tasks WHERE actor = 'pia'").get()).toEqual({ n: 0 });
    expect(serverCopies("tiny acrobatics tuck", [src])).toEqual([]);
  });
});

describe("a save waiting for a computer: the reserve, and 7 days at most", () => {
  it("its bytes on the disk leave that much less room; past 7 days they go and the person is told, naming the file", async () => {
    const MiB = 1024 ** 2;
    const rae = await account("rae", "none");
    drop("rae", "00000000-0000-4000-8000-0000000000a9", "Straddle.mp4", "s".repeat(4 * MiB));
    const saved = await useFile(findUser("rae") as never, "00000000-0000-4000-8000-0000000000a9", "library");
    expect(saved).toMatchObject({ waiting: true });
    const staged = readdirSync(path.join(dataDir, "library", "staging")).filter((n) => n.startsWith(`computer-${rae.lib}-`));
    expect(staged).toHaveLength(1);
    expect(statSync(path.join(dataDir, "library", "staging", staged[0]!)).size).toBe(4 * MiB);
    // a second library of rae's that keeps uploads, to start one in
    d.prepare(`INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_rae_all', 'rae', 'All', 'local', '{"upload":"all","setupAt":"2026-11-01T00:00:00.000Z"}', 0)`).run();
    // the free space as the disk says it now, the waiting 4 MB already out of it: 3 MB of it above the reserve
    const free = await (await import("../lib/uploads")).freeBytes(dataDir);
    process.env.LIBRARY_DISK_RESERVE_GB = String((free - 3 * MiB) / 1024 ** 3);
    const start = (mb: number) =>
      app.request("/api/library/lib_rae_all/uploads", { method: "POST", headers: { cookie: cookies.rae!, "content-type": "application/json" }, body: JSON.stringify({ filename: `Clip ${mb}.mp4`, size: mb * MiB }) });
    try {
      // the waiting bytes are counted once, by the disk: a 2 MB start fits, a 4 MB one does not
      expect((await start(2)).status).toBe(201);
      const refused = await start(4);
      expect(refused.status).toBe(507);
      expect(await refused.json()).toMatchObject({ code: "disk_reserve" });
      // 8 days later the save is dropped: its bytes go, and the inbox says so with the file's name (it came from no chat)
      d.prepare("UPDATE computer_tasks SET created_at = ? WHERE actor = 'rae'").run(Date.now() - 8 * 86_400_000);
      await taskTick();
      expect(d.prepare("SELECT state, error FROM computer_tasks WHERE actor = 'rae'").get()).toEqual({ state: "failed", error: "expired" });
      for (let i = 0; i < 50 && !existsSync(path.join(dataDir, "review", "notifications", "rae.json")); i++) await new Promise((r) => setTimeout(r, 20));
      expect(existsSync(path.join(dataDir, "library", "staging", staged[0]!))).toBe(false);
      const inbox = JSON.parse(readFileSync(path.join(dataDir, "review", "notifications", "rae.json"), "utf8")) as Array<{ kind: string; name: string; text: string }>;
      expect(inbox[0]).toMatchObject({ kind: "failed", name: "Straddle.mp4", text: expect.stringContaining("“Straddle.mp4” was not saved") });
      expect(d.prepare("SELECT COUNT(*) AS n FROM assets WHERE library_id = ?").get(rae.lib)).toEqual({ n: 0 });
      // its 4 MB are free again: the 4 MB start fits now
      expect((await start(4)).status).toBe(201);
    } finally {
      process.env.LIBRARY_DISK_RESERVE_GB = "0";
    }
  });
});

describe("what a waiting save was for happens once it lands", () => {
  it("Finals: under Finals upload none it waits (not a failure), then goes into Final exports and its piece", async () => {
    const fin = await account("fin", "none");
    d.prepare("UPDATE libraries SET settings = json_set(settings, '$.finalsUpload', 'none') WHERE id = ?").run(fin.lib);
    const file = path.join(root, "fin-final.mp4");
    writeFileSync(file, "tiny acrobatics finals cut");
    const out = await addToFinals({ owner: "fin", libraryId: fin.lib, label: "Tiny finals", item: null, kind: "export", width: 1080, height: 1920 }, { file, filename: "Tiny finals.mp4" });
    expect(out).toMatchObject({ ok: false, code: "waiting", error: expect.stringMatching(/^Fin's Mac is offline\. I'll save it to Final exports/) });
    fin.online();
    expect(await fin.takes()).toBe("done");
    const at = path.join(fin.finished, "Tiny finals.mp4");
    const row = d
      .prepare("SELECT v.mac_path, p.label FROM piece_items i JOIN pieces p ON p.id = i.piece_id JOIN asset_versions v ON v.id = i.version_id WHERE p.library_id = ?")
      .get(fin.lib);
    expect(row).toEqual({ mac_path: at, label: "Tiny finals" });
  });

  it("sound effects: their type, source and licence once they land", async () => {
    const sid = await account("sid", "none");
    const r = await findAndAdd("sid", { count: 1 });
    expect(r).toMatchObject({ note: expect.stringMatching(/^Sid's Mac is offline/) });
    expect(d.prepare("SELECT COUNT(*) AS n FROM assets WHERE library_id = ?").get(sid.lib)).toEqual({ n: 0 });
    sid.online();
    expect(await sid.takes()).toBe("done");
    const a = d.prepare("SELECT id FROM assets WHERE library_id = ?").get(sid.lib) as { id: string };
    const tags = (d.prepare("SELECT tag FROM asset_tags WHERE asset_id = ?").all(a.id) as { tag: string }[]).map((t) => t.tag);
    expect(tags).toContain("sound effect");
    expect(tags.length).toBeGreaterThan(1); // its type too
    expect(d.prepare("SELECT license, author FROM asset_sources WHERE asset_id = ?").get(a.id)).toEqual({ license: "CC0", author: "Kenney" });
  });

  it("a voice: its edit is made and started once the voice lands", async () => {
    const vo = await account("vo", "none");
    saveMyKey("vo", "ELEVENLABS_API_KEY", "vos-own");
    await elevenLabs("tiny acrobatics spoken script", async () => {
      const made = await makeVoice(findUser("vo") as never, { text: "Roll, then reach", voice: "Sam", name: "Roll", edit: { name: "Tiny voice edit", versions: 1, targetS: 0 } });
      expect(made).toEqual({ waiting: expect.stringMatching(/^Vo's Mac is offline/), save: expect.any(String) });
    });
    expect(allEdits().some((e) => e.name === "Tiny voice edit")).toBe(false);
    vo.online();
    expect(await vo.takes()).toBe("done");
    const v = d.prepare("SELECT v.id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ?").get(vo.lib) as { id: string };
    const edit = allEdits().find((e) => e.name === "Tiny voice edit");
    expect(edit?.sources).toEqual([v.id]);
    expect(d.prepare("SELECT kind, state FROM edit_jobs WHERE edit_id = ?").get(edit!.id)).toMatchObject({ kind: "analyze" });
  });
});

describe("the rest of a waiting save", () => {
  it("voice_make in a chat waits as use_file does: a running card and the line, then Saved when it lands, Not saved past 7 days", async () => {
    const chu = await account("chu", "none");
    saveMyKey("chu", "ELEVENLABS_API_KEY", "chus-own");
    // the computer that runs the chat's AI (the relay), apart from the Mac that holds the folders
    const runner = pairDevice("chu", "Runner");
    const { saveSettings } = await import("../lib/providers");
    const { DEFAULT_SETTINGS } = await import("../../contracts/providers");
    await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: runner.device.id }] }, "chu");
    const post = (url: string, body: unknown, headers: Record<string, string>) => app.request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect((await post("/api/assistant/turn", { text: "Make two voices" }, { cookie: cookies.chu! })).status).toBe(202);
    const job = (await (await post("/api/devices/relay/wait", {}, { authorization: `Bearer ${runner.token}` })).json()) as { id: string; mcp: { token: string } };
    const tool = async (args: Record<string, unknown>) => {
      const r = (await (await post("/api/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "voice_make", arguments: args } }, { authorization: `Bearer ${job.mcp.token}` })).json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
      expect(r.result.isError ?? false).toBe(false);
      return JSON.parse(r.result.content[0]!.text) as { said: string; save: string };
    };
    let kept = { said: "", save: "" };
    let dropped = { said: "", save: "" };
    await elevenLabs("tiny acrobatics chat voice one", async () => void (kept = await tool({ text: "One", voice: "Sam", name: "Kept" })));
    await elevenLabs("tiny acrobatics chat voice two", async () => void (dropped = await tool({ text: "Two", voice: "Sam", name: "Dropped" })));
    expect(kept.said).toMatch(/^Chu's Mac is offline\. I'll save it to Source media/);
    await post(`/api/devices/relay/${job.id}/done`, { text: "Waiting for your Mac." }, { authorization: `Bearer ${runner.token}` });
    const cards = async () => ((await (await app.request("/api/assistant", { headers: { cookie: cookies.chu! } })).json()) as { messages: Array<{ work?: Array<{ id: string; status: string; detail?: string }> }> }).messages.flatMap((m) => m.work ?? []);
    const card = async (save: string) => (await cards()).find((w) => w.id === `library-save:${save}`);
    expect(await card(kept.save)).toMatchObject({ status: "running" });
    expect(await card(dropped.save)).toMatchObject({ status: "running" });
    // one waits past 7 days: its card ends Not saved
    d.prepare("UPDATE computer_tasks SET created_at = ? WHERE ref = ?").run(Date.now() - 8 * 86_400_000, dropped.save);
    await taskTick();
    await vi.waitFor(async () => expect(await card(dropped.save)).toMatchObject({ status: "failed", detail: "Not saved" }), { timeout: 5000 });
    // the other lands once the Mac is back: its card ends Saved, and the voice is in Source media
    chu.online();
    expect(await chu.takes()).toBe("done");
    expect(await card(kept.save)).toMatchObject({ status: "done", detail: "Saved" });
    expect(readFileSync(path.join(chu.media, "Kept.mp3"), "utf8")).toBe("tiny acrobatics chat voice one");
  });

  it("the Export tray's Finals state: waiting while the computer is offline, sent once the final lands in its piece", async () => {
    const eve = await account("eve", "none", "admin");
    d.prepare("UPDATE libraries SET settings = json_set(settings, '$.finalsUpload', 'none') WHERE id = ?").run(eve.lib);
    const send = await app.request(`/api/exports/${eveExport}/content`, { method: "POST", headers: { cookie: cookies.eve!, "content-type": "application/json" }, body: "{}" });
    expect(await send.json()).toMatchObject({ finals: { status: "waiting", error: expect.stringMatching(/^Eve's Mac is offline\. I'll save it to Final exports/) } });
    const tray = async () =>
      ((await (await app.request("/api/exports", { headers: { cookie: cookies.eve! } })).json()) as Array<{ id: string; finals?: { status: string; pieceId?: string } }>).find((j) => j.id === eveExport)?.finals;
    expect(await tray()).toMatchObject({ status: "waiting" });
    eve.online();
    expect(await eve.takes()).toBe("done");
    const piece = d.prepare("SELECT p.id FROM pieces p JOIN piece_items i ON i.piece_id = p.id WHERE p.library_id = ?").get(eve.lib) as { id: string };
    expect(await tray()).toEqual({ status: "sent", pieceId: piece.id });
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
