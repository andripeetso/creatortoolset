import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { StorageFolder } from "../../contracts/storage";

// The Mac app refuses a drag of a file in a Blur faces workspace's Media folder onto another server's page: the computer's
// folder list says, per Media folder, which of its workspaces let only blurred footage out (RelayFolder.guarded).
const dir = realpathSync(mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "relay-guarded-")));
process.env.DATA_DIR = dir;
vi.mock("../plugins.gen", () => ({ serverPlugins: [] }));
// "tinymember" was given the owner's "ws_blur" workspace (Settings → Team): their own folder in it reads into it
vi.mock("../lib/workshop/workspace", async (real) => {
  const m = await real<typeof import("../lib/workshop/workspace")>();
  return { ...m, sharedProjects: async (u: string) => (u === "tinymember" ? [{ id: "ws_blur", owner: "tinyacrobatics", name: "Tiny Classes" } as never] : m.sharedProjects(u)) };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const OWNER = "tinyacrobatics";
mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
for (const [id, name] of [["ws_blur", "Tiny Classes"], ["ws_plain", "Tiny Vlogs"], ["ws_catalog", "Tiny Catalog"], ["ws_broken", "Tiny Broken"]] as const)
  writeFileSync(path.join(dir, "workshop", "projects", `${id}.json`), JSON.stringify({ id, owner: OWNER, name, createdAt: 0, updatedAt: 0 }));

const { libraryDb } = await import("./db");
const { changeStorage } = await import("../devices-storage");
const { relayFolders } = await import("./report");
const { mountPlugins } = await import("../lib/plugin");
const { Hono } = await import("hono");
// a plug-in that keeps the "ws_catalog" workspace's footage (a footage catalog), whichever workspace is open
// and for an account with no workspace at all ("": all of its media), as a footage catalog's plug-in answers
// "ws_broken": the plug-in fails to answer whether it serves that workspace, which counts as guarded
const { workspaceScope } = await import("../lib/workshop/workspace");
mountPlugins(new Hono(), [
  {
    id: "catalog",
    keepsBlurred: (u: string, ws: string) => ws === "ws_catalog" || (u === "tinysolo" && ws === ""),
    uploadsTo: () => {
      if (workspaceScope.getStore()?.id === "ws_broken") throw new Error("catalog away");
      return null;
    },
  } as never,
]);

const lib = (id: string, settings: Record<string, unknown>) =>
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, ?, 'L', 'local', ?, 0)").run(id, OWNER, JSON.stringify(settings));
lib("lib_blur", { upload: "none", blurFaces: true, projectId: "ws_blur" });
lib("lib_plain", { upload: "none", projectId: "ws_plain" });

const row = (id: string, p: string, workspace: string, role: StorageFolder["role"] = "footage"): StorageFolder =>
  ({ id, role, name: path.basename(p), origin: { host: "mac_1", path: p }, make: false, createdAt: 1, reach: {}, workspace }) as StorageFolder;

describe("the computer's folder list names the Blur faces workspaces of each Media folder", () => {
  it("a Blur faces workspace's folder by its name, a normal one none, one for every workspace the Blur faces ones, never for Exports", async () => {
    await changeStorage(OWNER, (st) => {
      st.folders.push(row("m_blur", "/Volumes/Tiny/FOOTAGE", "ws_blur"), row("m_plain", "/Volumes/Tiny/Vlogs", "ws_plain"), row("m_all", "/Volumes/Tiny/Shared", "*"),
        row("x_blur", "/Volumes/Tiny/EXPORTS", "ws_blur", "library"), row("m_catalog", "/Volumes/Tiny/Catalog", "ws_catalog"), row("m_broken", "/Volumes/Tiny/Broken", "ws_broken"));
    });
    const got = Object.fromEntries((await relayFolders({ id: "mac_1", owner: OWNER } as never)).map((f) => [f.id, f.guarded && [...f.guarded].sort()]));
    expect(got).toEqual({ m_blur: ["Tiny Classes"], m_plain: [], m_all: ["Tiny Broken", "Tiny Catalog", "Tiny Classes"], x_blur: undefined, m_catalog: ["Tiny Catalog"], m_broken: ["Tiny Broken"] });
  });

  it("a member's folder in the owner's Blur faces workspace is judged by the owner's library", async () => {
    await changeStorage("tinymember", (st) => void st.folders.push({ ...row("mm", "/Volumes/Member/FOOTAGE", "ws_blur"), origin: { host: "mac_m", path: "/Volumes/Member/FOOTAGE" } }));
    expect((await relayFolders({ id: "mac_m", owner: "tinymember" } as never)).map((f) => f.guarded)).toEqual([["Tiny Classes"]]);
  });

  it("an account with no workspace has its one asked about too", async () => {
    await changeStorage("tinysolo", (st) => void st.folders.push({ ...row("ms", "/Volumes/Solo/FOOTAGE", "*"), origin: { host: "mac_s", path: "/Volumes/Solo/FOOTAGE" } }));
    expect((await relayFolders({ id: "mac_s", owner: "tinysolo" } as never)).map((f) => f.guarded)).toEqual([["tinysolo"]]);
  });
});
