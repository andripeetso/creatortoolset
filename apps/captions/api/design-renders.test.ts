import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

// A text clip's PNG (api/designs.ts renders): kept by its content in its design's own folder, a new drawing a new file;
// never for another workspace's design, another account's, an account set to Read for Design, or past the size cap;
// gone with its design.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "design-renders-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "design-renders-test-secret";
afterAll(() => rmSync(dir, { recursive: true, force: true }));

mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
for (const id of ["tiny-a", "tiny-b"]) writeFileSync(path.join(dir, "workshop", "projects", `${id}.json`), JSON.stringify({ id, owner: "ana", name: id, createdAt: 1, updatedAt: 1 }));

const { createUser, findUser, setOff } = await import("./users");
const app = (await import("./boot")).default;

const cookies: Record<string, string> = {};
async function login(username: string) {
  setOff(createUser(username, "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (user: string, workspace: string, method: string, url: string, body?: unknown) =>
  app.request(`/api/designs${url}`, { method, headers: { cookie: cookies[user]!, "x-ct-workspace": workspace, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** The start of a PNG of w × h (its header is all the route reads), with `tail` making the content differ. */
const png = (w: number, h: number, tail = "") => {
  const n = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), n(13), Buffer.from("IHDR"), n(w), n(h), Buffer.from([8, 6, 0, 0, 0]), n(0), Buffer.from(tail)]).toString("base64");
};

let id = "";
beforeAll(async () => {
  await login("ana");
  await login("robin");
  id = ((await (await call("ana", "tiny-a", "POST", "", { format: "cover", blank: true, pages: 0 })).json()) as { id: string }).id;
});

it("keeps a frame's PNG by its content in the design's folder, serves it, and a new drawing is a new file", async () => {
  const r = await call("ana", "tiny-a", "POST", `/${id}/renders`, { png: png(1080, 1920, "a") });
  expect(r.status).toBe(200);
  const first = (await r.json()) as { path: string; w: number; h: number };
  expect(first).toEqual({ path: expect.stringMatching(/\/[0-9a-f]{20}\.png$/), w: 1080, h: 1920 });
  // where the editor's worker fetches it from: inside the owner's designs folder
  expect(first.path.startsWith(path.join(dir, "designs", "ana", id, "renders") + path.sep)).toBe(true);
  expect(((await (await call("ana", "tiny-a", "POST", `/${id}/renders`, { png: png(1080, 1920, "a") })).json()) as { path: string }).path).toBe(first.path);
  const second = ((await (await call("ana", "tiny-a", "POST", `/${id}/renders`, { png: png(1080, 1920, "b") })).json()) as { path: string }).path;
  expect(second).not.toBe(first.path);
  expect(existsSync(first.path)).toBe(true);
  const got = await call("ana", "tiny-b", "GET", `/${id}/renders/${path.basename(first.path)}`);
  expect(got.status).toBe(200);
  expect(got.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await got.arrayBuffer()).toString("base64")).toBe(png(1080, 1920, "a"));
});

it("refuses another workspace's design, another account's, Read, a picture past the size cap and anything not a PNG", async () => {
  expect((await call("ana", "tiny-b", "POST", `/${id}/renders`, { png: png(1080, 1920) })).status).toBe(404);
  expect((await call("robin", "tiny-a", "POST", `/${id}/renders`, { png: png(1080, 1920) })).status).toBe(404);
  expect((await call("robin", "tiny-a", "GET", `/${id}/renders/0123456789abcdef0123.png`)).status).toBe(404);
  const big = await call("ana", "tiny-a", "POST", `/${id}/renders`, { png: png(8193, 1080) });
  expect(big.status).toBe(400);
  expect(await big.json()).toEqual({ error: "A frame's picture is at most 8192 pixels a side" });
  expect((await call("ana", "tiny-a", "POST", `/${id}/renders`, { png: Buffer.from("not a png at all, no").toString("base64") })).status).toBe(400);
  findUser("ana")!.read = ["design"];
  try {
    const ro = await call("ana", "tiny-a", "POST", `/${id}/renders`, { png: png(1080, 1920) });
    expect(ro.status).toBe(403);
    expect(await ro.json()).toMatchObject({ code: "READ_ONLY" });
  } finally {
    findUser("ana")!.read = [];
  }
});

it("a deleted design's PNGs go with it: its clips play nothing (red)", async () => {
  const kept = ((await (await call("ana", "tiny-a", "POST", `/${id}/renders`, { png: png(1080, 1920, "c") })).json()) as { path: string }).path;
  expect((await call("ana", "tiny-a", "DELETE", `/${id}`)).status).toBe(200);
  expect(existsSync(kept)).toBe(false);
  expect((await call("ana", "tiny-a", "GET", `/${id}/renders/${path.basename(kept)}`)).status).toBe(404);
});
