import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Edit } from "../../contracts/editor";

// A phone's New edit: the clips' uploads are started, the edit is made from their ids, and it starts by itself
// when the last one is in, with the clips as its sources in the order picked.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-uploads-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-uploads-test-secret";

const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb } = await import("../library/db");

const cookies: Record<string, string> = {};
beforeAll(async () => {
  for (const u of ["maker", "other"]) {
    setOff(createUser(u, "password1", { role: "user" }), []);
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: u, password: "password1" }),
    });
    cookies[u] = res.headers.get("set-cookie")!.split(";")[0]!;
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const call = (user: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(url, {
    method,
    headers: { cookie: cookies[user]!, ...(body instanceof Buffer ? headers : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: body instanceof Buffer ? (body as never) : JSON.stringify(body) }),
  });
const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
const clip = (salt: number) => Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 7 + salt) % 251));

async function start(user: string, salt: number): Promise<{ id: string; data: Buffer }> {
  const { libraries } = await json<{ libraries: { id: string }[] }>(call(user, "GET", "/api/library"));
  const data = clip(salt);
  const { id } = await json<{ id: string }>(call(user, "POST", `/api/library/${libraries[0]!.id}/uploads`, { filename: `Clip ${salt}.mp4`, size: data.length }));
  return { id, data };
}
async function send(user: string, u: { id: string; data: Buffer }): Promise<any> {
  const r = await call(user, "PATCH", `/api/library/uploads/${u.id}`, u.data, { "upload-offset": "0", "content-length": String(u.data.length) });
  expect(r.status).toBeLessThan(300);
  return json(call(user, "POST", `/api/library/uploads/${u.id}/finish`));
}
const jobs = (id: string) => libraryDb().prepare("SELECT kind, state FROM edit_jobs WHERE edit_id = ?").all(id);
const { uploadFinished } = await import("./store");
// waits for every finished upload's work queued before it (one chain): a no-op of an upload nobody waits on
const settle = () => uploadFinished("-", "-");

describe.skipIf(rootReplaced)("AI Editor: an edit from clips still uploading", () => {
  it("waits for every clip, then starts with them as its sources in the order picked", async () => {
    const a = await start("maker", 1);
    const b = await start("maker", 2);
    const { id } = await json<{ id: string }>(call("maker", "POST", "/api/editor", { name: "From the phone", uploads: [a.id, b.id] }));
    let e = await json<Edit>(call("maker", "GET", `/api/editor/${id}`));
    expect(e).toMatchObject({ sources: [], uploads: [{ id: a.id }, { id: b.id }] });

    const vb = (await send("maker", b)).versionId;
    await settle();
    expect(jobs(id)).toEqual([]); // one clip still on its way
    const va = (await send("maker", a)).versionId;
    await settle();
    e = await json<Edit>(call("maker", "GET", `/api/editor/${id}`));
    expect(e.sources).toEqual([va, vb]);
    expect(e.uploads).toBeUndefined();
    expect(jobs(id)).toEqual([{ kind: "analyze", state: expect.any(String) }]);
  });

  it("takes a clip already in the library as its version", async () => {
    const a = await start("maker", 3);
    const first = await send("maker", a);
    const again = await start("maker", 3); // the same bytes once more
    const { id } = await json<{ id: string }>(call("maker", "POST", "/api/editor", { uploads: [again.id] }));
    expect((await send("maker", again)).duplicateOf).toBeTruthy();
    await settle();
    expect((await json<Edit>(call("maker", "GET", `/api/editor/${id}`))).sources).toEqual([first.versionId]);
  });

  it("refuses uploads that are not the caller's or already finished", async () => {
    const theirs = await start("other", 4);
    expect((await call("maker", "POST", "/api/editor", { uploads: [theirs.id] })).status).toBe(404);
    const done = await start("maker", 5);
    await send("maker", done);
    expect((await call("maker", "POST", "/api/editor", { uploads: [done.id] })).status).toBe(404);
    expect((await call("maker", "POST", "/api/editor", { uploads: ["nope"] })).status).toBe(404);
  });
});
