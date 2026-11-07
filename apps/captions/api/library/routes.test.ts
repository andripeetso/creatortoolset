import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";
import { freeBytes } from "../lib/uploads";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-uploads-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");

afterAll(() => {
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  rmSync(dir, { recursive: true, force: true });
});

// the test account is named in x-user; the real gate (api/boot.ts) sets the same user
const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "user" } as never);
  return next();
});
app.route("/api/library", libraryApp);

const who = (user: string) => ({ "x-user": user });
const read = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const clip = (n: number, salt = 0) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + salt) % 251));

beforeAll(() => {
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'owner-a', 'A', 'local', 0)").run();
});

const create = (user: string, size: number, extra: Record<string, unknown> = {}) =>
  app.request("/api/library/lib_a/uploads", {
    method: "POST",
    headers: { ...who(user), "content-type": "application/json" },
    body: JSON.stringify({ filename: "Clip.mp4", size, ...extra }),
  });

const patch = (user: string, id: string, offset: number, body: Buffer | ReadableStream<Uint8Array>, length: number) =>
  app.request(`/api/library/uploads/${id}`, {
    method: "PATCH",
    headers: { ...who(user), "upload-offset": String(offset), "content-length": String(length) },
    body: body as never,
    duplex: "half",
  } as RequestInit);

const head = (user: string, id: string) => app.request(`/api/library/uploads/${id}`, { method: "HEAD", headers: who(user) });
const finish = (user: string, id: string) => app.request(`/api/library/uploads/${id}/finish`, { method: "POST", headers: who(user) });

describe("library uploads", () => {
  it("resumes after a cut connection: the stored bytes give the offset, and the retry from it succeeds", async () => {
    const data = clip(3000, 1);
    const init = await read(create("owner-a", data.length));
    expect(init).toMatchObject({ offset: 0, chunkSize: 32 * 1024 * 1024 });

    // the connection drops partway through a 1000-byte chunk: whatever reached the disk is the offset
    const cut = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(data.subarray(0, 500));
        ctrl.error(new Error("connection reset"));
      },
    });
    const dropped = await patch("owner-a", init.id, 0, cut, 1000);
    expect(dropped.status).toBe(409);
    const { offset } = await read(dropped) as { offset: number };
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThanOrEqual(500);

    // the browser asks where it is, then resumes from there
    expect((await head("owner-a", init.id)).headers.get("upload-offset")).toBe(String(offset));
    const rest = await patch("owner-a", init.id, offset, data.subarray(offset), data.length - offset);
    expect(rest.status).toBe(204);
    expect(rest.headers.get("upload-offset")).toBe("3000");

    const done = await finish("owner-a", init.id);
    expect(done.status).toBe(200);
    expect(await read(done)).toMatchObject({ assetId: expect.any(String), versionId: expect.any(String) });
  });

  it("answers a wrong Upload-Offset with 409 and the offset the file is at", async () => {
    const data = clip(2000, 2);
    const init = await read(create("owner-a", data.length));
    expect((await patch("owner-a", init.id, 0, data.subarray(0, 1000), 1000)).status).toBe(204);
    const stale = await patch("owner-a", init.id, 0, data.subarray(0, 1000), 1000);
    expect(stale.status).toBe(409);
    expect(await read(stale)).toMatchObject({ offset: 1000 });
  });

  it("rejects a finish whose bytes are not all in (size mismatch)", async () => {
    const data = clip(3000, 3);
    const init = await read(create("owner-a", data.length));
    expect((await patch("owner-a", init.id, 0, data.subarray(0, 2000), 2000)).status).toBe(204);
    const early = await finish("owner-a", init.id);
    expect(early.status).toBe(409);
    expect(await read(early)).toMatchObject({ offset: 2000 });
  });

  it("returns duplicateOf for the same sha256 and creates no second asset", async () => {
    const data = clip(1500, 4);
    const count = () => (libraryDb().prepare("SELECT COUNT(*) AS n FROM assets WHERE library_id = 'lib_a'").get() as { n: number }).n;

    const first = await read(create("owner-a", data.length));
    expect((await patch("owner-a", first.id, 0, data, data.length)).status).toBe(204);
    const made = await read(finish("owner-a", first.id));
    const before = count();

    const second = await read(create("owner-a", data.length));
    expect((await patch("owner-a", second.id, 0, data, data.length)).status).toBe(204);
    expect(await read(finish("owner-a", second.id))).toEqual({ duplicateOf: made.assetId });
    expect(count()).toBe(before);
  });

  it("refuses to start an upload when it would leave less than the disk reserve free", async () => {
    process.env.LIBRARY_DISK_RESERVE_GB = "1000000000";
    try {
      const res = await create("owner-a", 1024);
      expect(res.status).toBe(507);
      expect(await read(res)).toMatchObject({ code: "disk_reserve" });
    } finally {
      delete process.env.LIBRARY_DISK_RESERVE_GB;
    }
  });

  it("counts the bytes open uploads may still write against the disk reserve", async () => {
    const GB = 1024 ** 3;
    const free = (await freeBytes(dir)) / GB;
    // the reserve leaves room for one 1 GB upload, not two
    process.env.LIBRARY_DISK_RESERVE_GB = String(free - 1.5);
    try {
      expect((await create("owner-a", GB)).status).toBe(201);
      expect((await create("owner-a", GB)).status).toBe(507);
    } finally {
      delete process.env.LIBRARY_DISK_RESERVE_GB;
    }
  });

  it("replaces an asset with a new version", async () => {
    libraryDb().prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_owner', 'lib_a', 'video', 'O', 'owner-a', ?)").run(Date.now());
    expect((await create("owner-a", 1024, { replacesAssetId: "ast_owner" })).status).toBe(201);
    expect((await create("owner-a", 1024, { replacesAssetId: "ast_missing" })).status).toBe(404);
  });
});

describe("library: an account's first library", () => {
  it("is its own (the local account too), and nobody else's", async () => {
    // "local" is the account every request runs as when sign-in is off; a fresh install's first account is the same case
    const res = await app.request("/api/library", { method: "POST", headers: { ...who("local"), "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(201);
    const { libraries } = await read(app.request("/api/library", { headers: who("local") }));
    expect(libraries).toHaveLength(1);
    expect(await read(app.request("/api/library", { headers: who("owner-a") }))).toMatchObject({ libraries: [{ id: "lib_a" }] });
    expect((await app.request(`/api/library/${libraries[0].id}`, { method: "PATCH", headers: { ...who("owner-a"), "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  });
});

describe("library: uploading into a folder", () => {
  const upload = async (collectionId: string, salt: number) => {
    const data = clip(800, salt);
    const init = await read(create("owner-a", data.length, { collectionId }));
    expect((await patch("owner-a", init.id, 0, data, data.length)).status).toBe(204);
    return read(finish("owner-a", init.id));
  };
  const items = (cid: string) =>
    (libraryDb().prepare("SELECT asset_id, added_by FROM collection_items WHERE collection_id = ?").all(cid) as { asset_id: string; added_by: string }[]);

  beforeAll(() => {
    const add = libraryDb().prepare("INSERT INTO collections (id, library_id, name, kind, query, created_at, created_by) VALUES (?, 'lib_a', ?, ?, ?, 0, 'owner-a')");
    add.run("col_folder", "Folder", "manual", null);
    add.run("col_gone", "Gone", "manual", null);
    add.run("col_smart", "Smart", "smart", "{}");
  });

  it("puts the finished asset in the folder the upload was started in", async () => {
    const { assetId } = await upload("col_folder", 11);
    expect(items("col_folder")).toEqual([{ asset_id: assetId, added_by: "owner-a" }]);
  });

  it("finishes without the folder when it was deleted meanwhile, and refuses a smart folder up front", async () => {
    const data = clip(800, 12);
    const init = await read(create("owner-a", data.length, { collectionId: "col_gone" }));
    libraryDb().prepare("DELETE FROM collections WHERE id = 'col_gone'").run();
    expect((await patch("owner-a", init.id, 0, data, data.length)).status).toBe(204);
    expect(await read(finish("owner-a", init.id))).toMatchObject({ assetId: expect.any(String) });
    expect(items("col_gone")).toEqual([]);
    expect((await create("owner-a", 800, { collectionId: "col_smart" })).status).toBe(409);
  });
});

describe("saving a finished file into the library", () => {
  it("adds a copy as a new asset, made from the versions it names that the caller may read", async () => {
    const { saveToLibrary } = await import("./routes");
    const data = clip(800, 20);
    const init = await read(create("owner-a", data.length));
    await patch("owner-a", init.id, 0, data, data.length);
    const source = (await read(finish("owner-a", init.id))) as { versionId: string };
    const render = path.join(dir, "render.mp4");
    writeFileSync(render, clip(900, 21));

    const saved = (await saveToLibrary("owner-a", render, "Tiny Acrobatics roll captioned.mp4", [source.versionId, "no-such-version"])) as {
      assetId: string;
      versionId: string;
    };
    expect(libraryDb().prepare("SELECT title, created_by FROM assets WHERE id = ?").get(saved.assetId)).toEqual({
      title: "Tiny Acrobatics roll captioned",
      created_by: "owner-a",
    });
    expect(libraryDb().prepare("SELECT source_version_id FROM derived_from WHERE version_id = ?").all(saved.versionId)).toEqual([
      { source_version_id: source.versionId },
    ]);
    expect(readFileSync(render).length).toBe(900); // the file stays where it was
    // the same bytes again: already there; another account: no library
    expect(await saveToLibrary("owner-a", render, "again.mp4", [])).toEqual({ duplicateOf: saved.assetId });
    expect(await saveToLibrary("stranger", render, "x.mp4", [])).toBeNull();
  });
});
