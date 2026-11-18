import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// A Workshop project's folder in the workspace's Finals folder (the Exports folder by default): made when the
// project asks for its final, kept through a rename, a video in it counts as the final, and only those subfolders are
// read, into Finals, linked to the project. And finals follow their own upload setting (full files by default).

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = realpathSync(mkdtempSync(path.join(scratch, "workshop-finals-folder-")));
process.env.DATA_DIR = path.join(dir, "data");
process.env.APP_SECRET = "workshop-finals-folder-secret";
process.env.LIBRARY_WATCH_FOLDERS = "1";
process.env.LIBRARY_DISK_RESERVE_GB = "0";
afterAll(() => {
  delete process.env.LIBRARY_WATCH_FOLDERS;
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  rmSync(dir, { recursive: true, force: true });
});

const { createUser } = await import("./users");
const app = (await import("./boot")).default;
const rootReplaced = (await import("./lib/plugin")).pluginReplaces("/api/workshop");
const { libraryDb, versionUpload } = await import("./library/db");
const { scanWatchFolders } = await import("./library/watch");
const { sendsFromComputer } = await import("./library/derived");
const { emitEvent } = await import("./lib/events");

const cookies: Record<string, string> = {};
async function account(username: string) {
  createUser(username, "password1", { role: "admin" });
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { cookie: cookies[user]!, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const library = path.join(dir, "Creator Toolset");
type Finals = { linked: boolean; libraryId: string; finalsId: string; upload: string; folder?: string; reads?: boolean };

describe.skipIf(rootReplaced)("Workshop: a project's folder in the Finals folder", () => {
  it("is made and kept, counts a video in it, and reads only project folders into Finals", async () => {
    await account("maker");
    mkdirSync(path.join(process.env.DATA_DIR!, "storage"), { recursive: true });
    writeFileSync(
      path.join(process.env.DATA_DIR!, "storage", "maker.json"),
      JSON.stringify({ folders: [{ id: "lib", role: "library", name: "Creator Toolset", origin: { host: "this-computer", path: library }, make: true, createdAt: 0, reach: {} }] }),
    );
    const s = (await (await call("maker", "POST", "/api/workshop/sessions", { title: "Tiny Acrobatics: rolls" })).json()) as { id: string };
    const url = `/api/workshop/sessions/${s.id}/finals`;
    const sub = path.join(library, "Tiny Acrobatics rolls");

    const first = (await (await call("maker", "GET", url)).json()) as Finals;
    expect(first.linked).toBe(false);
    expect(first.upload).toBe("all");
    expect(existsSync(sub)).toBe(true);

    // a rename keeps the folder it had
    await call("maker", "PATCH", `/api/workshop/sessions/${s.id}`, { title: "Renamed" });
    expect(((await (await call("maker", "GET", url)).json()) as Finals).linked).toBe(false);
    expect(existsSync(path.join(library, "Renamed"))).toBe(false);

    // a render saved beside the project folders is not a final; the file in the project's folder is
    writeFileSync(path.join(library, "render.mp4"), "not a final");
    writeFileSync(path.join(sub, "final.mp4"), "the final");
    expect(((await (await call("maker", "GET", url)).json()) as Finals).linked).toBe(true);

    const t = Date.now();
    await scanWatchFolders(t);
    await scanWatchFolders(t + 61_000);
    const taken = libraryDb().prepare("SELECT path, version_id FROM watch_seen WHERE library_id = ?").all(first.libraryId) as { path: string; version_id: string }[];
    expect(taken.map((r) => path.basename(r.path))).toEqual(["final.mp4"]);
    const v = taken[0]!.version_id;
    // filed as finished, in Finals
    expect(libraryDb().prepare("SELECT a.filed_roll AS r FROM assets a JOIN asset_versions v ON v.asset_id = a.id WHERE v.id = ?").get(v)).toEqual({ r: "none" });
    expect(versionUpload(v)).toBe("all");

    // once the library has read its size, it is the project's final, its piece named as the project is now
    libraryDb().prepare("UPDATE asset_versions SET probe = ? WHERE id = ?").run(JSON.stringify({ width: 1080, height: 1920 }), v);
    emitEvent("library.version.probed", { libraryId: first.libraryId, versionId: v, owner: "maker" });
    await new Promise((r) => setTimeout(r, 200));
    expect(libraryDb().prepare("SELECT label FROM pieces WHERE workshop_session = ?").all(s.id)).toEqual([{ label: "Renamed" }]);
  });

  it("finals follow their own upload setting", async () => {
    const lib = (libraryDb().prepare("SELECT id FROM libraries LIMIT 1").get() as { id: string }).id;
    const finals = (libraryDb().prepare("SELECT id FROM collections WHERE library_id = ? AND name = 'Finals'").get(lib) as { id: string }).id;
    // footage off by default, finals whole by default
    expect(sendsFromComputer(lib, "a.mp4")).toBe(false);
    expect(sendsFromComputer(lib, "a.mp4", finals)).toBe(true);
    const patch = (settings: unknown) => call("maker", "PATCH", `/api/library/${lib}`, { settings });
    const saved = (await (await patch({ finalsUpload: "none" })).json()) as { settings: { finalsUpload: string } };
    expect(saved.settings.finalsUpload).toBe("none");
    expect(sendsFromComputer(lib, "a.mp4", finals)).toBe(false);
  });
});
