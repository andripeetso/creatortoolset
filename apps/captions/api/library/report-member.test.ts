import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

// A member's Media folder in a workspace the team owner gave them: the owner's library is only located against (their
// computer gets place rows), never indexed into, and no library is made in the member's home.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "report-member-"));
process.env.DATA_DIR = dir;
delete process.env.CT_LOCAL;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const BRAND = "bbbbbbbb-0000-4000-8000-000000000003";
mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
writeFileSync(path.join(dir, "workshop", "projects", `${BRAND}.json`), JSON.stringify({ id: BRAND, owner: "ana", name: "Tiny Acrobatics", createdAt: 1, updatedAt: 1 }));
const member = (username: string, role = "member") => ({ username, role, ai: "own", budgetUsd: 0, joinedAt: 0, ...(role === "member" ? { workspaces: [BRAND] } : {}) });
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({ workspaces: [{ id: "t", name: "Tiny Acrobatics", plan: "team", comped: false, createdAt: 0, members: [member("ana", "owner"), member("bo"), member("cy")] }], invites: [], spend: {} }),
);

const { createUser } = await import("../users");
const { libraryDb } = await import("./db");
const { homeOf } = await import("./access");
const { applyReport } = await import("./report");
const { changeStorage } = await import("../devices-storage");
const { pairDevice } = await import("../lib/devices");
createUser("ana", "password1", { role: "admin" });
createUser("bo", "password1", { role: "user" });
createUser("cy", "password1", { role: "user" });

const d = libraryDb();
const quick = (n: number) => n.toString(16).padStart(64, "0");
const DIR = "/Volumes/Tiny Footage/Shoots";
d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_owner', ?, 'Tiny', 'local', ?, 0)").run(homeOf("ana"), JSON.stringify({ projectId: BRAND }));
const version = (id: string, q: number) => {
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_owner', 'video', ?, ?, 'ana', 0)").run(`ast_${id}`, `${id}.mp4`, id);
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, quick) VALUES (?, ?, 1, ?, 10, 'h', 'ready', 'ana', 0, ?)").run(id, `ast_${id}`, `mac:${id}`, quick(q));
};
version("ver_known", 1);
version("ver_known2", 3);

const bo = pairDevice("bo", "Tiny Laptop").device;
await changeStorage("bo", (st) => {
  st.folders.push({ id: "fold_bo", role: "footage", name: "Shoots", origin: { host: bo.id, path: DIR }, make: false, createdAt: 0, reach: {}, workspace: BRAND });
});

const counts = () => ({
  versions: (d.prepare("SELECT COUNT(*) AS n FROM asset_versions").get() as { n: number }).n,
  libraries: (d.prepare("SELECT COUNT(*) AS n FROM libraries WHERE workspace_id = ?").get(homeOf("bo")) as { n: number }).n,
  places: (d.prepare("SELECT COUNT(*) AS n FROM version_places WHERE device = ?").get(bo.id) as { n: number }).n,
});
const file = (name: string, q: number) => ({ path: `${DIR}/${name}`, bytes: 10, mtime: 1_700_000_000_000, quick: quick(q) });
const report = (scan: string, files: ReturnType<typeof file>[]) => ({ id: "fold_bo", state: "ok" as const, scan, complete: true, files, unreadable: [] });

it("a member's shared workspace: a known file gets one place row, an unknown one is skipped, nothing is added", async () => {
  const before = counts();
  const answer = await applyReport(bo, [report("s1", [file("known.mp4", 1), file("new.mp4", 2)])]);
  expect(answer.index).toEqual([]);
  const after = counts();
  expect(after.places - before.places).toBe(1);
  expect(after.versions - before.versions).toBe(0);
  expect(after.libraries - before.libraries).toBe(0);
  expect(after.libraries).toBe(0);
});

it("a member's place at a file their folder now leaves out turns gone, and the owner's clip stays", async () => {
  version("ver_private", 5);
  await applyReport(bo, [{ id: "fold_bo", state: "ok", files: [file("Private/p.mp4", 5)], unreadable: [] }]);
  const place = () => d.prepare("SELECT state FROM version_places WHERE device = ? AND version_id = 'ver_private'").get(bo.id);
  expect(place()).toEqual({ state: "verified" });
  await changeStorage("bo", (st) => {
    st.folders.find((f) => f.id === "fold_bo")!.leaveOut = ["Private"];
  });
  await applyReport(bo, [{ id: "fold_bo", state: "ok", files: [file("Private/p.mp4", 5)], unreadable: [] }]);
  expect(place()).toEqual({ state: "gone" });
  expect(d.prepare("SELECT trashed_at FROM assets WHERE id = 'ast_ver_private'").get()).toEqual({ trashed_at: null });
  await changeStorage("bo", (st) => {
    delete st.folders.find((f) => f.id === "fold_bo")!.leaveOut;
  });
});

it("a stray library of the member's own for that workspace changes nothing: new places still go to the owner's", async () => {
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_stray', ?, 'Library', 'local', ?, 0)").run(homeOf("bo"), JSON.stringify({ projectId: BRAND }));
  const before = counts();
  const answer = await applyReport(bo, [report("s2", [file("known2.mp4", 3), file("new2.mp4", 4)])]);
  expect(answer.index).toEqual([]);
  const after = counts();
  expect(after.places - before.places).toBe(1);
  expect(after.versions - before.versions).toBe(0);
  expect(after.libraries - before.libraries).toBe(0);
  const row = d.prepare("SELECT version_id, folder_id FROM version_places WHERE device = ? AND version_id = 'ver_known2'").all(bo.id) as { version_id: string }[];
  expect(row).toHaveLength(1);
  const strays = d.prepare("SELECT COUNT(*) AS n FROM assets WHERE library_id = 'lib_stray'").get() as { n: number };
  expect(strays.n).toBe(0);
});

it("a member with no workspaces of their own gets no library from a folder for every workspace: nothing is made", async () => {
  const { librariesOf } = await import("./report");
  const folder = { id: "fold_cy", role: "footage", name: "Shoots", origin: { host: "cy-computer", path: DIR }, make: false, createdAt: 0, reach: {}, workspace: "*" } as Parameters<typeof librariesOf>[1];
  const libs = () => (d.prepare("SELECT COUNT(*) AS n FROM libraries WHERE workspace_id = ?").get(homeOf("cy")) as { n: number }).n;
  const before = libs();
  expect(await librariesOf("cy", folder)).toEqual([]);
  expect(libs() - before).toBe(0);
});
