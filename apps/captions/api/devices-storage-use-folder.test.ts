import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it } from "vitest";
import type { AuthVars } from "./auth";

// ensureUseFolder never makes a Projects or Exports folder by itself (owner, 2026-11-19): a folder is made only when the
// person picks or confirms one. Not set up: the setup card. Set up: the folder card. The card's tap makes the row.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "use-folder-"));
process.env.DATA_DIR = dir;
delete process.env.CT_LOCAL;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { changeStorage, ensureUseFolder, storageApp, storageOf } = await import("./devices-storage");
const { pairDevice } = await import("./lib/devices");
const { inRequestWorkspace } = await import("./lib/workspace-scope");
const { libraryDb } = await import("./library/db");
const { LIBRARY_WORDS } = await import("../contracts/library");

mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
for (const [id, name] of [["ws-a", "Tiny Acrobatics"], ["ws-b", "Second"]])
  writeFileSync(path.join(dir, "workshop", "projects", `${id}.json`), JSON.stringify({ id, owner: "ana", name, updatedAt: 1 }));
const setUp = (ws: string) =>
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'ana', 'Library', 'local', ?, 0)").run(`lib_${ws.replace("-", "_")}`, JSON.stringify({ projectId: ws, setupAt: "2026-11-19T08:00:00.000Z" }));

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: "ana", role: "admin" } as never);
  return next();
});
app.use("/api/*", inRequestWorkspace);
app.route("/api/devices/storage", storageApp);

const mac = pairDevice("ana", "Ana's Mac").device.id;
// a Media folder on a drive, where the old code made Project files and Final exports beside it by itself
await changeStorage("ana", (st) => {
  for (const ws of ["ws-a", "ws-b"])
    st.folders.push({ id: `media-${ws}`, role: "footage", name: "Shoots", origin: { host: mac, path: `/Volumes/Tiny Footage/${ws}/Shoots` }, make: false, createdAt: 0, reach: {}, workspace: ws });
});
const rows = async () => JSON.stringify((await storageOf("ana")).folders);

it("a workspace not set up: the setup card for Projects and Exports, and no row is added", async () => {
  const before = await rows();
  for (const role of ["projects", "library"] as const) {
    const r = await ensureUseFolder("ana", "ws-a", role, mac);
    expect(r).toMatchObject({ wait: { kind: "setup", workspace: "ws-a", owner: true, device: mac, actions: [{ id: "quick_setup" }, { id: "customise" }] } });
  }
  expect(await rows()).toBe(before);
});

it("a member's job in a workspace not set up: a card that says the owner sets it up, with nothing to press", async () => {
  const r = await ensureUseFolder("mem", "ws-a", "projects", mac);
  expect(r).toMatchObject({ wait: { kind: "setup", owner: false, line: LIBRARY_WORDS.setupCardMember, actions: [] } });
  expect(LIBRARY_WORDS.setupCardMember).toMatch(/owner/);
});

it("set up with no Projects or Exports row: the folder card, and no row is added", async () => {
  setUp("ws-a");
  const before = await rows();
  expect(await ensureUseFolder("ana", "ws-a", "projects", mac)).toMatchObject({
    wait: { kind: "projects", device: mac, path: "~/Movies/Creator Toolset/Tiny Acrobatics/Project files", actions: [{ id: "use_default" }, { id: "choose" }] },
  });
  expect(await ensureUseFolder("ana", "ws-a", "library", mac)).toMatchObject({
    wait: { kind: "exports", device: mac, path: "~/Movies/Creator Toolset/Tiny Acrobatics/Final exports", actions: [{ id: "use_default" }, { id: "choose" }] },
  });
  expect(await rows()).toBe(before);
});

it("the card's tap (make: true) makes the row, and the next claim gets it; another workspace still waits", async () => {
  for (const role of ["projects", "library"] as const) {
    const r = await ensureUseFolder("ana", "ws-a", role, mac);
    if (!("wait" in r)) throw new Error("expected a card");
    const call = r.wait.actions[0]!.call!;
    const res = await app.request(call.path, { method: call.method, headers: { "content-type": "application/json", "X-CT-Workspace": call.workspace! }, body: JSON.stringify(call.body) });
    expect(res.status).toBe(200);
    expect(await ensureUseFolder("ana", "ws-a", role, mac)).toMatchObject({ role, workspace: "ws-a", make: true, origin: { host: mac, path: (call.body as { path: string }).path } });
  }
  expect(await ensureUseFolder("ana", "ws-b", "projects", mac)).toMatchObject({ wait: { kind: "setup", workspace: "ws-b" } });
});

it("with no workspace named and two of the account's, no folder is picked: the answer says what to choose", async () => {
  expect(await ensureUseFolder("ana", undefined, "projects", mac)).toEqual({ error: "Choose a Project files folder in Settings → Media Library." });
});
