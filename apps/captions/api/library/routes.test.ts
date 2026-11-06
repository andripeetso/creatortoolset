import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

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
  c.set("user", { username: c.req.header("x-user") ?? "", role: "member" } as never);
  return next();
});
app.route("/api/library", libraryApp);

const who = (user: string) => ({ "x-user": user });
const read = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const clip = (n: number, salt = 0) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + salt) % 251));

beforeAll(() => {
  writeFileSync(
    path.join(dir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        { id: "ws_a", name: "a", plan: "team", comped: false, createdAt: 0, members: [
          { username: "owner-a", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 },
          { username: "mem-a", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0 },
        ] },
      ],
      invites: [],
      spend: {},
    }),
  );
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'ws_a', 'A', 'local', 0)").run();
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
});
