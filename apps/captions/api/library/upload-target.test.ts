import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// A phone's upload goes where the server says for the workspace the request works in (owner, 2026-11-16: "Each
// workspace is its own client"): a plug-in's store where one claims it, else that workspace's own library. An upload in
// one workspace is never listed in another, and a library of another workspace is refused by id.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "upload-target-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_DISK_RESERVE_GB = "0";
afterAll(() => {
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  rmSync(dir, { recursive: true, force: true });
});

const TINY = "cccccccc-0000-4000-8000-000000000001";
const CLIMBERS = "cccccccc-0000-4000-8000-000000000002";
const NOBODYS = "cccccccc-0000-4000-8000-000000000009";
const projects = path.join(dir, "workshop", "projects");
mkdirSync(projects, { recursive: true });
for (const [id, at] of [[TINY, 1], [CLIMBERS, 2]] as const) {
  writeFileSync(path.join(projects, `${id}.json`), JSON.stringify({ id, owner: "ana", name: id, createdAt: at, updatedAt: at }));
}
const member = (username: string, workspaces?: string[]) => ({ username, role: "member", ai: "own", budgetUsd: 0, joinedAt: 0, ...(workspaces ? { workspaces } : {}) });
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({ workspaces: [{ id: "t", name: "Team", plan: "team", comped: false, createdAt: 0, members: [{ ...member("ana"), role: "owner" }, member("bo", [TINY]), member("cy")] }], invites: [], spend: {} }),
);

const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { uploadTargetApp } = await import("./upload-target");
const { inRequestWorkspace } = await import("../lib/workspace-scope");
const { workspaceScope } = await import("../lib/workshop/workspace");
const { mountPlugins } = await import("../lib/plugin");

// a plug-in that keeps one workspace's uploads in a store of its own (as a studio's footage catalog does)
let storeIn: string | null = null;
mountPlugins(new Hono(), [{ id: "store", uploadsTo: () => (storeIn && workspaceScope.getStore()?.id === storeIn ? "store" : null) }]);

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  // "bo:read": bo with the Media Library on Read (Settings → Team → Access)
  const [username, read] = (c.req.header("x-test-user") ?? "").split(":");
  c.set("user", { username, role: "user", off: [], read: read ? ["media"] : [] } as never);
  return next();
});
app.use(inRequestWorkspace);
app.route("/api/upload-target", uploadTargetApp);
app.route("/api/library", libraryApp);

const call = (user: string, url: string, ws?: string, init: RequestInit = {}) =>
  app.request(url, { ...init, headers: { "x-test-user": user, "content-type": "application/json", ...(ws ? { "x-ct-workspace": ws } : {}), ...(init.headers as object) } } as RequestInit);
const post = (user: string, url: string, ws: string | undefined, body: unknown) => call(user, url, ws, { method: "POST", body: JSON.stringify(body) });
const target = async (user: string, ws?: string) => {
  const r = await call(user, "/api/upload-target", ws);
  return r.status === 200 ? ((await r.json()) as { target: string }).target : r.status;
};
const uploads = () => (libraryDb().prepare("SELECT COUNT(*) AS n FROM uploads").get() as { n: number }).n;

/** The phone's upload: start with no library id, send the bytes, finish. */
async function send(user: string, ws: string, filename: string, bytes: string) {
  const start = await post(user, "/api/library/here/uploads", ws, { filename, size: bytes.length });
  expect(start.status).toBe(201);
  const { id } = (await start.json()) as { id: string };
  const sent = await call(user, `/api/library/uploads/${id}`, ws, { method: "PATCH", body: bytes, headers: { "upload-offset": "0", "content-length": String(bytes.length) } });
  expect(sent.status).toBe(204);
  return { id, finish: () => call(user, `/api/library/uploads/${id}/finish`, ws, { method: "POST" }) };
}

/** Every file name the workspace's Media Library lists. */
async function listed(ws: string): Promise<string> {
  const { libraries } = (await (await call("ana", "/api/library", ws)).json()) as { libraries: { id: string }[] };
  const pages = await Promise.all(libraries.map(async (l) => (await call("ana", `/api/library/${l.id}/assets`, ws)).json()));
  return JSON.stringify(pages);
}
const libraryOf = async (ws: string) => ((await (await call("ana", "/api/library", ws)).json()) as { libraries: { id: string }[] }).libraries[0]!.id;

it("files a phone upload in its workspace's own library: never listed in the other workspace", async () => {
  expect((await (await send("ana", CLIMBERS, "climbers.mov", "bbbb")).finish()).status).toBe(200);
  expect((await (await send("ana", TINY, "tiny.mov", "aaaa")).finish()).status).toBe(200);
  expect(await listed(TINY)).toContain("tiny.mov");
  expect(await listed(TINY)).not.toContain("climbers.mov");
  expect(await listed(CLIMBERS)).toContain("climbers.mov");
  expect(await listed(CLIMBERS)).not.toContain("tiny.mov");
});

it("answers the target per workspace, from the plug-in that keeps a workspace's uploads", async () => {
  expect(await target("ana", TINY)).toBe("library");
  expect(await target("ana", CLIMBERS)).toBe("library");
  storeIn = TINY;
  try {
    expect(await target("ana", TINY)).toBe("store");
    expect(await target("ana", CLIMBERS)).toBe("library");
    // the library's own upload refuses that workspace, so it can't be filed beside the store
    const before = uploads();
    expect((await post("ana", "/api/library/here/uploads", TINY, { filename: "x.mov", size: 4 })).status).toBe(409);
    expect(uploads()).toBe(before);
  } finally {
    storeIn = null;
  }
});

it("refuses a workspace the account can't see or may only look at: nothing lands anywhere", async () => {
  const before = uploads();
  for (const [user, ws] of [["ana", NOBODYS], ["cy", TINY], ["bo:read", TINY], ["bo", CLIMBERS]] as const) {
    expect(await target(user, ws)).toBe(403);
    expect((await post(user, "/api/library/here/uploads", ws, { filename: "x.mov", size: 4 })).status).toBe(403);
  }
  storeIn = TINY;
  try {
    expect(await target("ana", NOBODYS)).toBe(403); // never answered for another workspace, the store's either
    expect(await target("bo:read", TINY)).toBe(403);
  } finally {
    storeIn = null;
  }
  expect(uploads()).toBe(before);
  // a member given the workspace on Read & write adds to the owner's library there; the finish asks again
  const mine = await send("bo", TINY, "bo.mov", "cccc");
  expect((await mine.finish()).status).toBe(200);
  const later = await send("bo", TINY, "bo2.mov", "dddd");
  expect((await call("bo:read", `/api/library/uploads/${later.id}/finish`, TINY, { method: "POST" })).status).toBe(404);
  expect(await listed(TINY)).toContain("bo.mov");
});

it("refuses another workspace's library by id when the request names a workspace, and goes on as before when it names none", async () => {
  const climbers = await libraryOf(CLIMBERS);
  expect((await post("ana", `/api/library/${climbers}/uploads`, TINY, { filename: "x.mov", size: 4 })).status).toBe(404);
  expect((await post("ana", `/api/library/${climbers}/uploads/check`, TINY, { size: 4 })).status).toBe(404);
  expect((await post("ana", `/api/library/${climbers}/in-place`, TINY, { path: "/x.mov", size: 4 })).status).toBe(404);
  expect((await post("ana", `/api/library/${climbers}/on-mac`, TINY, {})).status).toBe(404);
  expect((await post("ana", `/api/library/${climbers}/uploads`, CLIMBERS, { filename: "x.mov", size: 4 })).status).toBe(201);
  // an older app names no workspace: as before
  expect((await post("ana", `/api/library/${climbers}/uploads`, undefined, { filename: "x.mov", size: 4 })).status).toBe(201);
  // a chat's own workspace wins over the window's header
  const inChat = await workspaceScope.run({ id: CLIMBERS }, () => post("ana", `/api/library/${climbers}/uploads`, TINY, { filename: "x.mov", size: 4 }));
  expect(inChat.status).toBe(201);
});
