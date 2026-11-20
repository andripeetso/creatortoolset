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
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const OWNER = "tinyacrobatics";
mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
for (const [id, name] of [["ws_blur", "Tiny Classes"], ["ws_plain", "Tiny Vlogs"]] as const)
  writeFileSync(path.join(dir, "workshop", "projects", `${id}.json`), JSON.stringify({ id, owner: OWNER, name, createdAt: 0, updatedAt: 0 }));

const { libraryDb } = await import("./db");
const { changeStorage } = await import("../devices-storage");
const { relayFolders } = await import("./report");

const lib = (id: string, settings: Record<string, unknown>) =>
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, ?, 'L', 'local', ?, 0)").run(id, OWNER, JSON.stringify(settings));
lib("lib_blur", { upload: "none", blurFaces: true, projectId: "ws_blur" });
lib("lib_plain", { upload: "none", projectId: "ws_plain" });

const row = (id: string, p: string, workspace: string, role: StorageFolder["role"] = "footage"): StorageFolder =>
  ({ id, role, name: path.basename(p), origin: { host: "mac_1", path: p }, make: false, createdAt: 1, reach: {}, workspace }) as StorageFolder;

describe("the computer's folder list names the Blur faces workspaces of each Media folder", () => {
  it("a Blur faces workspace's folder by its name, a normal one none, one for every workspace the Blur faces ones, never for Exports", async () => {
    await changeStorage(OWNER, (st) => {
      st.folders.push(row("m_blur", "/Volumes/Tiny/FOOTAGE", "ws_blur"), row("m_plain", "/Volumes/Tiny/Vlogs", "ws_plain"), row("m_all", "/Volumes/Tiny/Shared", "*"), row("x_blur", "/Volumes/Tiny/EXPORTS", "ws_blur", "library"));
    });
    const got = Object.fromEntries((await relayFolders({ id: "mac_1", owner: OWNER } as never)).map((f) => [f.id, f.guarded]));
    expect(got).toEqual({ m_blur: ["Tiny Classes"], m_plain: [], m_all: ["Tiny Classes"], x_blur: undefined });
  });
});
