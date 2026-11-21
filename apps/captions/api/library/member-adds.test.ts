import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// A workspace the team's owner gives members has one Media Library, the owner's. A member on Read & write (Settings →
// Team → Access) adds to it as they did to a library of their own: Send to Finals, a Review video's copy, a sound
// effect. A member on Read only adds nothing and is told why. A person on their own is unchanged.
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-member-adds-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_DISK_RESERVE_GB = "0";
afterAll(() => {
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  rmSync(dir, { recursive: true, force: true });
});

const TEAM = "dddddddd-0000-4000-8000-000000000001";
const SOLO = "dddddddd-0000-4000-8000-000000000002";
const projects = path.join(dir, "workshop", "projects");
mkdirSync(projects, { recursive: true });
for (const [id, owner] of [[TEAM, "ana"], [SOLO, "sol"]] as const) {
  writeFileSync(path.join(projects, `${id}.json`), JSON.stringify({ id, owner, name: `Tiny Acrobatics ${owner}`, createdAt: 1, updatedAt: 1 }));
}
const account = (username: string, read: string[] = []) => ({ username, salt: "", hash: "", role: "user", cloud: true, off: [], read, createdAt: 0 });
// cy: the Media Library on Read for this team (the Access grid writes it to the account)
writeFileSync(path.join(dir, "users.json"), JSON.stringify({ users: [account("ana"), account("bo"), account("cy", ["media"]), account("sol")] }));
const member = (username: string, role = "member") => ({ username, role, ai: "own", budgetUsd: 0, joinedAt: 0, ...(role === "member" ? { workspaces: [TEAM] } : {}) });
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({ workspaces: [{ id: "t", name: "Team", plan: "team", comped: false, createdAt: 0, members: [member("ana", "owner"), member("bo"), member("cy")] }], invites: [], spend: {} }),
);

const { libraryDb } = await import("./db");
const { addRole, ensureLibrary, mediaReady, READ_ONLY } = await import("./access");
const { addToFinals, linkFinalsPiece } = await import("./finals");
const { REFUSED_COMPUTER_OFF } = await import("./upload-gate");
const { findAndAdd } = await import("./sfx");
const { reviewApp, readMeta, toLibrary } = await import("../review");
const { inRequestWorkspace } = await import("../lib/workspace-scope");
const { workspaceScope } = await import("../lib/workshop/workspace");

const d = () => libraryDb();
const render = path.join(dir, "render.mp4");
writeFileSync(render, Buffer.from("tiny-acrobatics finished render"));
const finals = (owner: string, libraryId: string, label: string) =>
  addToFinals({ owner, libraryId, label, item: null, kind: "export", width: 1080, height: 1920 }, { file: render, filename: `${label}.mp4` });
const inTeam = <T>(fn: () => Promise<T>) => workspaceScope.run({ id: TEAM }, fn);
const assetsIn = (lib: string) => (d().prepare("SELECT COUNT(*) AS n FROM assets WHERE library_id = ?").get(lib) as { n: number }).n;

const teamLib = (await ensureLibrary("ana", TEAM))!;
// sound effects are kept on this server (a library's Upload reads none until it is set up)
d().prepare(`UPDATE libraries SET settings = json_set(COALESCE(settings, '{}'), '$.upload', 'all') WHERE id = ?`).run(teamLib);

it("one role check: the owner, a member on Read & write, a member on Read only, and nobody else", async () => {
  expect(await ensureLibrary("bo", TEAM)).toBe(teamLib);
  expect(await addRole("ana", teamLib)).toBe("owner");
  expect(await addRole("bo", teamLib)).toBe("member");
  expect(await addRole("cy", teamLib)).toBe("read");
  expect(await addRole("sol", teamLib)).toBeNull();
});

it("a member on Read & write sends to Finals in the owner's library; one on Read only is refused, saying why", async () => {
  const sent = await finals("bo", teamLib, "Tiny member final");
  expect(sent).toMatchObject({ ok: true });
  if (!sent.ok) return;
  expect(d().prepare("SELECT library_id, created_by FROM pieces WHERE id = ?").get(sent.pieceId)).toEqual({ library_id: teamLib, created_by: "bo" });
  expect(d().prepare("SELECT library_id FROM assets WHERE id = ?").get(sent.assetId)).toEqual({ library_id: teamLib });

  const before = assetsIn(teamLib);
  expect(await finals("cy", teamLib, "Tiny read final")).toEqual({ ok: false, code: "no_access", error: READ_ONLY });
  expect(assetsIn(teamLib)).toBe(before);
  // nobody makes a library of their own in the team's workspace
  expect(d().prepare("SELECT COUNT(*) AS n FROM libraries WHERE workspace_id IN ('bo', 'cy')").get()).toEqual({ n: 0 });
});

it("a member fills and links only Finals pieces of their own, never the owner's of the same name", async () => {
  const owners = await finals("ana", teamLib, "Tiny same name");
  const theirs = await finals("bo", teamLib, "Tiny same name");
  if (!owners.ok || !theirs.ok) throw new Error("not sent");
  expect(theirs.pieceId).not.toBe(owners.pieceId);
  expect(await linkFinalsPiece(owners.pieceId, "sess-bo", undefined, "bo")).toBe(false);
  expect(await linkFinalsPiece(theirs.pieceId, "sess-bo", undefined, "bo")).toBe(true);
  expect(await linkFinalsPiece(owners.pieceId, "sess-ana", undefined, "ana")).toBe(true);
  expect(d().prepare("SELECT workshop_session AS s FROM pieces WHERE id = ?").get(owners.pieceId)).toEqual({ s: "sess-ana" });
});

it("a member's final is refused where the owner keeps Finals on their computer (Upload none), as a member's upload is", async () => {
  const set = (v: string | null) => d().prepare(`UPDATE libraries SET settings = json_set(COALESCE(settings, '{}'), '$.finalsUpload', ?) WHERE id = ?`).run(v, teamLib);
  set("none");
  try {
    expect(await finals("bo", teamLib, "Tiny kept on the owner's computer")).toEqual({ ok: false, code: "failed", error: REFUSED_COMPUTER_OFF });
  } finally {
    set(null);
  }
});

it("a person on their own sends to their own library, never the team's", async () => {
  const lib = (await ensureLibrary("sol", SOLO))!;
  expect(d().prepare("SELECT workspace_id FROM libraries WHERE id = ?").get(lib)).toEqual({ workspace_id: "sol" });
  expect(await finals("sol", lib, "Tiny solo final")).toMatchObject({ ok: true });
  expect(await finals("sol", teamLib, "Tiny stray final")).toMatchObject({ ok: false, code: "not_found" });
});

it("a member on Read & write adds a sound effect to the owner's library; one on Read only is refused", async () => {
  const r = await inTeam(() => findAndAdd("bo", { count: 1 }));
  expect(r).toMatchObject({ library: teamLib, failed: 0 });
  expect((r as { added: unknown[] }).added).toHaveLength(1);
  expect(await inTeam(() => findAndAdd("cy", { count: 1 }))).toEqual({ error: READ_ONLY, code: "forbidden" });
});

it("mediaReady with no workspace named reads the library of the one this request works in, as librariesHere does", async () => {
  expect(await inTeam(() => mediaReady("bo"))).toMatchObject({ owner: false, libraryId: teamLib });
  expect(await inTeam(() => mediaReady("ana"))).toMatchObject({ owner: true, libraryId: teamLib });
});

// Review, as each member uploads a video in the team's workspace
const review = new Hono<{ Variables: AuthVars }>();
review.use(async (c, next) => {
  const username = c.req.header("x-test-user")!;
  c.set("user", { username, role: "user", cloud: true, off: [], read: username === "cy" ? ["media"] : [] } as never);
  return next();
});
review.use(inRequestWorkspace);
review.route("/", reviewApp);
const json = (user: string, body: unknown) => ({ method: "POST", headers: { "content-type": "application/json", "x-test-user": user, "x-ct-workspace": TEAM }, body: JSON.stringify(body) });
async function upload(user: string, name: string): Promise<string> {
  const bytes = Buffer.from(`${user} ${name}`);
  const init = (await (await review.request("/uploads", json(user, { name, size: bytes.length }))).json()) as { id: string; partSize: number };
  await review.request(`/uploads/${init.id}/parts/1`, {
    method: "POST",
    headers: { "x-test-user": user, "x-ct-workspace": TEAM, "upload-length": String(bytes.length), "upload-part-size": String(init.partSize), "content-length": String(bytes.length) },
    body: bytes,
  });
  const asset = (await (await review.request(`/uploads/${init.id}/complete`, json(user, {}))).json()) as { id: string };
  // processed (the library's copy follows it), then once more by hand so the copy is settled here
  for (let i = 0; i < 200 && (await readMeta(asset.id))?.versions.some((v) => v.status === "processing" || !v.versionId); i++) await new Promise((r) => setTimeout(r, 50));
  await toLibrary(asset.id);
  return asset.id;
}
const libraryOf = (id: string) => (d().prepare("SELECT library_id FROM assets WHERE id = ?").get(id) as { library_id: string } | undefined)?.library_id;

it("a Review video a member on Read & write uploads is copied into the owner's library; on Read only, it stays in Review", async () => {
  expect(libraryOf(await upload("bo", "Tiny member cut.mp4"))).toBe(teamLib);
  const kept = await upload("cy", "Tiny read cut.mp4");
  expect(await readMeta(kept)).toBeTruthy();
  expect(libraryOf(kept)).toBeUndefined();
});
