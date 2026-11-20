import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it } from "vitest";
import type { AuthVars } from "./auth";

// ensureUseFolder never makes a Projects or Exports row by itself (owner, 2026-11-19): a row is made only when the
// person picks or confirms one. Not set up: the setup card. Set up with no Project files anywhere: its setup again.
// No Exports: the folder card, whose tap makes the row. A computer only helping keeps its own working folder (2026-11-20).
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "use-folder-"));
process.env.DATA_DIR = dir;
delete process.env.CT_LOCAL;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { changeStorage, ensureUseFolder, storageApp, storageOf } = await import("./devices-storage");
const { noteMachine, pairDevice } = await import("./lib/devices");
const { inRequestWorkspace } = await import("./lib/workspace-scope");
const { libraryDb } = await import("./library/db");
const { LIBRARY_WORDS } = await import("../contracts/library");

mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
for (const [id, name] of [["ws-tiny", "Tiny Acrobatics"], ["ws-second", "Second"]])
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
  for (const ws of ["ws-tiny", "ws-second"])
    st.folders.push({ id: `media-${ws}`, role: "footage", name: "Shoots", origin: { host: mac, path: `/Volumes/Tiny Footage/${ws}/Shoots` }, make: false, createdAt: 0, reach: {}, workspace: ws });
});
const rows = async () => JSON.stringify((await storageOf("ana")).folders);

it("a workspace not set up: the setup card for Projects and Exports, and no row is added", async () => {
  const before = await rows();
  for (const role of ["projects", "library"] as const) {
    const r = await ensureUseFolder("ana", "ws-tiny", role, mac);
    expect(r).toMatchObject({ wait: { kind: "setup", workspace: "ws-tiny", owner: true, device: mac, actions: [{ id: "quick_setup" }, { id: "customise" }] } });
  }
  expect(await rows()).toBe(before);
});

it("a member's job in a workspace not set up: a card that says the owner sets it up, with nothing to press", async () => {
  const r = await ensureUseFolder("mem", "ws-tiny", "projects", mac);
  expect(r).toMatchObject({ wait: { kind: "setup", owner: false, line: LIBRARY_WORDS.setupCardMember, actions: [] } });
  expect(LIBRARY_WORDS.setupCardMember).toMatch(/owner/);
});

it("set up with no Project files anywhere: its setup again (no Quick setup); no Exports row: the folder card; no row is added", async () => {
  setUp("ws-tiny");
  const before = await rows();
  expect(await ensureUseFolder("ana", "ws-tiny", "projects", mac)).toMatchObject({
    wait: { kind: "setup", again: true, line: LIBRARY_WORDS.setupAgainLine, actions: [{ id: "customise", open: "/library?setup=1", primary: true }] },
  });
  const card = await ensureUseFolder("ana", "ws-tiny", "projects", mac);
  if ("wait" in card) expect(card.wait.actions).toHaveLength(1);
  expect(await ensureUseFolder("ana", "ws-tiny", "library", mac)).toMatchObject({
    wait: { kind: "exports", device: mac, path: "~/Movies/Creator Toolset/Tiny Acrobatics/Final exports", actions: [{ id: "use_default" }, { id: "choose" }] },
  });
  expect(await rows()).toBe(before);
});

it("the Exports card's tap and the setup's Project files pick make the rows, and the next claim gets them; another workspace still waits", async () => {
  const r = await ensureUseFolder("ana", "ws-tiny", "library", mac);
  if (!("wait" in r)) throw new Error("expected a card");
  const call = r.wait.actions[0]!.call!;
  const post = (body: unknown) => app.request(call.path, { method: call.method, headers: { "content-type": "application/json", "X-CT-Workspace": "ws-tiny" }, body: JSON.stringify(body) });
  expect((await post(call.body)).status).toBe(200);
  expect(await ensureUseFolder("ana", "ws-tiny", "library", mac)).toMatchObject({ role: "library", workspace: "ws-tiny", make: true, origin: { host: mac, path: (call.body as { path: string }).path } });
  const projects = "~/Movies/Creator Toolset/Tiny Acrobatics/Project files";
  expect((await post({ role: "projects", host: mac, path: projects, make: true })).status).toBe(200);
  expect(await ensureUseFolder("ana", "ws-tiny", "projects", mac)).toMatchObject({ role: "projects", workspace: "ws-tiny", origin: { host: mac, path: projects } });
  expect(await ensureUseFolder("ana", "ws-second", "projects", mac)).toMatchObject({ wait: { kind: "setup", workspace: "ws-second" } });
});

it("load balancing: another registration of the same Mac uses its folder; a helper reaching it uses it there; any other helper gets its own, with no card and no row", async () => {
  const machine = (id: string, host: string) => noteMachine(id, { host, cpus: 8, memGb: 32 });
  machine(mac, "Anas-Mac.local");
  const again = pairDevice("ana", "Ana's Mac (2)").device.id;
  machine(again, "anas-mac");
  const projects = "~/Movies/Creator Toolset/Tiny Acrobatics/Project files";
  expect(await ensureUseFolder("ana", "ws-tiny", "projects", again)).toMatchObject({ origin: { host: mac, path: projects } });
  const before = await rows();
  const helper = pairDevice("ana", "helper-box").device.id;
  machine(helper, "helper-box");
  expect(await ensureUseFolder("ana", "ws-tiny", "projects", helper)).toMatchObject({ role: "projects", make: true, origin: { host: helper, path: projects } });
  expect(await rows()).toBe(before);
  // Exports never goes to a helper's own folder: its card stays
  expect(await ensureUseFolder("ana", "ws-second", "library", helper)).toHaveProperty("wait");
  await changeStorage("ana", (st) => {
    for (const f of st.folders) if (f.role === "projects" && f.workspace === "ws-tiny") f.reach[helper] = { path: "/mnt/nas/Project files", at: 1 };
  });
  expect(await ensureUseFolder("ana", "ws-tiny", "projects", helper)).toMatchObject({ origin: { host: helper, path: "/mnt/nas/Project files" } });
});

it("with no workspace named and two of the account's, no folder is picked: the answer says what to choose", async () => {
  expect(await ensureUseFolder("ana", undefined, "projects", mac)).toEqual({ error: "Choose a Project files folder in Settings → Media Library." });
});
