import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";

// a browser's word "proxy", the chat's save to the library, the disk reserve per person, and one finish across processes
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "upload-hardening-"));
process.env.DATA_DIR = dir;
// the disk has 100 GB free, whatever disk the test runs on
const GiB = 1024 ** 3;
vi.mock("../lib/uploads", async (real) => ({ ...(await real<typeof import("../lib/uploads")>()), freeBytes: async () => 100 * 1024 ** 3 }));

const { sessionCookieFor } = await import("../auth");
const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { REFUSED_NONE } = await import("./upload-gate");
const { librariesHere, ensureLibrary } = await import("./access");
const { useFile } = await import("../assistant-files");
const { createUser, findUser } = await import("../users");

for (const u of ["ana", "ben", "cara", "dee", "eli"]) createUser(u, `secret-${u}-tiny-acrobatics`);

afterAll(() => {
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  rmSync(dir, { recursive: true, force: true });
});

const d = libraryDb();
const library = (id: string, owner: string, upload: string) =>
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, ?, 'L', 'local', ?, 0)").run(id, owner, JSON.stringify({ upload }));
library("lib_cara", "cara", "none");
library("lib_ana", "ana", "all");
library("lib_ben", "ben", "all");
library("lib_eli", "eli", "all");

/** The library routes as one server process sees them, signed in as `x-user`. */
const serve = (routes: typeof libraryApp) => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use(async (c, next) => {
    c.set("user", { username: c.req.header("x-user") ?? "ana", role: "user" } as never);
    return next();
  });
  return app.route("/api/library", routes);
};
const app = serve(libraryApp);
const hex = (s: string) => createHash("sha256").update(s).digest("hex");
const start = (user: string, lib: string, body: object, headers: Record<string, string> = {}) =>
  app.request(`/api/library/${lib}/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user": user, ...headers },
    body: JSON.stringify({ filename: "Handstand.mp4", ...body }),
  });

describe("a proxy is the phone's word or a computer's, never a browser's", () => {
  const probe = { duration: 3, width: 1280, height: 720, fps: 30, rotation: 0, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" };
  const made = { size: 4, quick: hex("q"), proxy: { size: 5, probe, sha256: hex("wxyz") } };

  it("a browser that calls its file a proxy under none is refused as its original would be; the iPhone app's proxy is taken", async () => {
    const browser = await start("cara", "lib_cara", made);
    expect(browser.status).toBe(409);
    expect(await browser.json()).toMatchObject({ code: "upload_refused", message: REFUSED_NONE });
    const phone = await start("cara", "lib_cara", made, { "x-ct-origin": "phone", cookie: sessionCookieFor("cara", true)! });
    expect(phone.status).toBe(201);
    // its bytes and its finish are taken too
    const { id } = (await phone.json()) as { id: string };
    const part = await app.request(`/api/library/uploads/${id}`, { method: "PATCH", headers: { "x-user": "cara", "upload-offset": "0", "content-length": "4" }, body: "wxyz" });
    expect(part.status).toBe(204);
    expect((await app.request(`/api/library/uploads/${id}/finish`, { method: "POST", headers: { "x-user": "cara" } })).status).toBe(200);
  });
  // a computer's proxy (its device token, acceptLibraryFile) is upload-gate.test.ts "a computer's proxy job"
});

describe("saving a chat file to the Media Library asks the upload gate", () => {
  it("refused under Upload none with the library's own words; saved under all", async () => {
    await ensureLibrary("dee");
    const lib = (await librariesHere("dee"))[0]!.id;
    const setUpload = (v: string) => d.prepare("UPDATE libraries SET settings = json_set(COALESCE(settings, '{}'), '$.upload', ?) WHERE id = ?").run(v, lib);
    const id = randomUUID();
    mkdirSync(path.join(dir, "assistant", "files", "dee", id), { recursive: true });
    writeFileSync(path.join(dir, "assistant", "files", "dee", id, "file"), "abcd");
    writeFileSync(path.join(dir, "assistant", "files", "dee", id, "meta.json"), JSON.stringify({ id, name: "Handstand.mp4", mime: "video/mp4", size: 4, at: Date.now() }));
    const user = findUser("dee") as never;
    setUpload("none");
    await expect(useFile(user, id, "library")).rejects.toThrow(REFUSED_NONE);
    expect(d.prepare("SELECT COUNT(*) AS n FROM assets WHERE library_id = ?").get(lib)).toEqual({ n: 0 });
    setUpload("all");
    const saved = await useFile(user, id, "library");
    expect(saved).toMatchObject({ to: "library", libraryId: lib });
  });
});

describe("the disk reserve: one person's uploads never hold everyone else's", () => {
  // room for one 8 GB upload and `room` GB more
  const reserve = (room: number) => void (process.env.LIBRARY_DISK_RESERVE_GB = String(100 - 8 - room));
  it("ten empty 8 GB starts hold nothing; sent to, only that person's four largest count; an hour without a byte, none", async () => {
    const big = { size: 8 * GiB };
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await start("ana", "lib_ana", big);
      expect(r.status).toBe(201);
      ids.push(((await r.json()) as { id: string }).id);
    }
    // room for ben's 8 GB and 2 GB more: ana's 80 GB declared, none of it sent, holds none of it
    reserve(2);
    expect((await start("ben", "lib_ben", big)).status).toBe(201);
    // a byte to each of ana's ten: still only four of them count (32 GB), not all ten (80 GB)
    for (const id of ids) {
      expect((await app.request(`/api/library/uploads/${id}`, { method: "PATCH", headers: { "x-user": "ana", "upload-offset": "0", "content-length": "1" }, body: "w" })).status).toBe(204);
    }
    expect((await start("ben", "lib_ben", big)).status).toBe(507);
    reserve(34);
    expect((await start("ben", "lib_ben", big)).status).toBe(201);
    // an hour without a byte: abandoned, they hold nothing
    reserve(2);
    d.prepare("UPDATE uploads SET expires_at = ? WHERE created_by = 'ana'").run(Date.now() + 7 * 86_400_000 - 2 * 3_600_000);
    expect((await start("ben", "lib_ben", big)).status).toBe(201);
    delete process.env.LIBRARY_DISK_RESERVE_GB;
  });
});

describe("one finish, whichever server process gets it", () => {
  it("two processes finishing one upload at once: exactly one files it, the other is told it is in progress", async () => {
    // a second server process (the no-downtime swap): its own module state, the same database file
    vi.resetModules();
    const other = serve((await import("./routes")).libraryApp);
    const r = await start("eli", "lib_eli", { size: 4 });
    const { id } = (await r.json()) as { id: string };
    await app.request(`/api/library/uploads/${id}`, { method: "PATCH", headers: { "x-user": "eli", "upload-offset": "0", "content-length": "4" }, body: "wxyz" });
    const finish = (a: typeof app) => a.request(`/api/library/uploads/${id}/finish`, { method: "POST", headers: { "x-user": "eli" } });
    const both = await Promise.all([finish(app), finish(other)]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(await both.find((x) => x.status === 409)!.json()).toMatchObject({ error: "Upload in progress" });
    expect(d.prepare("SELECT COUNT(*) AS n FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = 'lib_eli'").get()).toEqual({ n: 1 });
    expect(d.prepare("SELECT state FROM uploads WHERE id = ?").get(id)).toEqual({ state: "done" });
  });

  it("a finish that finds the upload incomplete leaves it open, to be resumed and finished", async () => {
    const { id } = (await (await start("eli", "lib_eli", { size: 4 })).json()) as { id: string };
    const early = await app.request(`/api/library/uploads/${id}/finish`, { method: "POST", headers: { "x-user": "eli" } });
    expect(early.status).toBe(409);
    expect(d.prepare("SELECT state FROM uploads WHERE id = ?").get(id)).toEqual({ state: "open" });
    await app.request(`/api/library/uploads/${id}`, { method: "PATCH", headers: { "x-user": "eli", "upload-offset": "0", "content-length": "4" }, body: "abcd" });
    expect((await app.request(`/api/library/uploads/${id}/finish`, { method: "POST", headers: { "x-user": "eli" } })).status).toBe(200);
  });
});
