import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A Media folder is never inside a Projects or Exports folder (any workspace's: the AI Editor's own output), nor inside
// another workspace's Media folder. Settings, the setup card and Quick setup all add folders through the same route.
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
const dir = mkdtempSync(path.join(scratch, "storage-inside-"));
const shoots = mkdtempSync(path.join(scratch, "storage-inside-shoots-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "storage-inside-secret";
process.env.CT_LOCAL = "1";
const A = "eeeeeeee-0000-4000-8000-0000000000a2";
const B = "eeeeeeee-0000-4000-8000-0000000000b2";
afterAll(() => {
  delete process.env.CT_LOCAL;
  rmSync(dir, { recursive: true, force: true });
  rmSync(shoots, { recursive: true, force: true });
});

mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
for (const [id, name, at] of [[A, "Tiny Acrobatics", 1], [B, "Climbers", 2]] as const)
  writeFileSync(path.join(dir, "workshop", "projects", `${id}.json`), JSON.stringify({ id, owner: "ana", name, createdAt: at, updatedAt: at }));
const shoot = (name: string) => {
  const p = path.join(shoots, name);
  mkdirSync(p, { recursive: true });
  return p;
};

const app = (await import("./boot")).default;
const { createUser } = await import("./users");
const { storageOf } = await import("./devices-storage");

createUser("ana", "password1", { role: "admin" });
const cookie = (await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "ana", password: "password1" }) })).headers.get("set-cookie")!.split(";")[0]!;
const addFolder = (ws: string, role: string, p: string) =>
  app.request("/api/devices/storage/folders", { method: "POST", headers: { "content-type": "application/json", "x-ct-workspace": ws, cookie }, body: JSON.stringify({ role, host: "this-computer", path: p }) });
const line = (name: string, whose: string, use: string) => `That folder is inside ${name}, which is ${whose}'s ${use} folder: pick a folder outside it`;
const refused = async (p: string, error: string) => {
  const r = await addFolder(B, "footage", p);
  expect(r.status).toBe(400);
  expect(((await r.json()) as { error: string }).error).toBe(error);
  expect((await storageOf("ana")).folders.some((f) => f.origin.path === p)).toBe(false);
};

describe("no Media folder inside a Projects or Exports folder, or inside another workspace's Media folder", () => {
  beforeAll(async () => {
    // the other workspace's three folders, and this workspace's own Projects and Exports
    for (const [ws, role, name] of [[A, "footage", "a-media"], [A, "projects", "a-projects"], [A, "library", "a-exports"], [B, "projects", "b-projects"], [B, "library", "b-exports"]])
      expect((await addFolder(ws, role, shoot(name))).status).toBe(200);
  });

  it("another workspace's Media folder", async () => {
    await refused(shoot("a-media/day1"), line("a-media", "Tiny Acrobatics", "Media"));
  });

  it("another workspace's Projects folder", async () => {
    await refused(shoot("a-projects/edit1"), line("a-projects", "Tiny Acrobatics", "Projects"));
  });

  it("another workspace's Exports folder", async () => {
    await refused(shoot("a-exports/finals"), line("a-exports", "Tiny Acrobatics", "Exports"));
  });

  it("an Exports subfolder in the same workspace", async () => {
    await refused(shoot("b-exports/Creator Toolset/Footage/Phone uploads"), line("b-exports", "Climbers", "Exports"));
  });

  it("a Projects subfolder in the same workspace", async () => {
    await refused(shoot("b-projects/Edit 1/Media"), line("b-projects", "Climbers", "Projects"));
  });

  it("the same folder as another workspace's Media folder, or one beside them, is added", async () => {
    expect((await addFolder(B, "footage", path.join(shoots, "a-media"))).status).toBe(200);
    expect((await addFolder(B, "footage", shoot("b-media"))).status).toBe(200);
  });
});
