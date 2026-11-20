import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it } from "vitest";
import type { AuthVars } from "./auth";

// A workspace with no Project files folder on the computer doing an edit, and no Media folder there to put one next
// to (its footage is elsewhere): ensureUseFolder answers a pause with the card's default, never an error. The card's
// Use <default> is Settings → Folders' own request; after it, the folder is there for the job's next claim.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "projects-wait-"));
process.env.DATA_DIR = dir;
delete process.env.CT_LOCAL;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { storageApp, ensureUseFolder, storageOf } = await import("./devices-storage");
const { pairDevice } = await import("./lib/devices");
const { inRequestWorkspace } = await import("./lib/workspace-scope");
const { libraryDb } = await import("./library/db");

mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
for (const [id, name] of [["ws-tiny", "Tiny Acrobatics"], ["ws-other", "Other"]])
  writeFileSync(path.join(dir, "workshop", "projects", `${id}.json`), JSON.stringify({ id, owner: "ana", name, updatedAt: 1 }));
// both Media Libraries are set up: a folder is what the job waits for (not set up: the setup card, use-folder.test)
for (const id of ["ws-tiny", "ws-other"])
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'ana', 'Library', 'local', ?, 0)").run(`lib_${id.replace("-", "_")}`, JSON.stringify({ projectId: id, setupAt: "2026-11-19T08:00:00.000Z" }));

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: "ana", role: "admin" } as never);
  return next();
});
app.use("/api/*", inRequestWorkspace);
app.route("/api/devices/storage", storageApp);

it("no Project files and no Media folder: a pause with the workspace's default, then Use <default> makes the row", async () => {
  const mac = pairDevice("ana", "Ana's Mac").device.id;
  const r = await ensureUseFolder("ana", "ws-tiny", "projects", mac);
  const wait = { kind: "projects", workspace: "ws-tiny", workspaceName: "Tiny Acrobatics", device: mac, path: "~/Movies/Creator Toolset/Tiny Acrobatics/Project files" };
  expect(r).toMatchObject({ wait: { ...wait, title: "Project files folder for Tiny Acrobatics", actions: [{ id: "use_default" }, { id: "choose" }] } });

  // the card's [Use <default>]: the request ActionCard's addProjectsFolder sends
  const res = await app.request("/api/devices/storage/folders", {
    method: "POST",
    headers: { "content-type": "application/json", "X-CT-Workspace": "ws-tiny" },
    body: JSON.stringify({ role: "projects", host: mac, path: wait.path }),
  });
  expect(res.status).toBe(200);
  const rows = (await storageOf("ana")).folders.filter((f) => f.role === "projects");
  expect(rows).toEqual([expect.objectContaining({ role: "projects", workspace: "ws-tiny", make: true, origin: { host: mac, path: wait.path } })]);
  // the job's next claim finds it: no pause any more, and that workspace only
  expect(await ensureUseFolder("ana", "ws-tiny", "projects", mac)).toEqual(rows[0]);
  expect(await ensureUseFolder("ana", "ws-other", "projects", mac)).toMatchObject({ wait: { workspace: "ws-other", path: "~/Movies/Creator Toolset/Other/Project files" } });
  // Exports gets the same card, with its own folder
  expect(await ensureUseFolder("ana", "ws-other", "library", mac)).toMatchObject({ wait: { kind: "exports", title: "Final exports folder for Other", path: "~/Movies/Creator Toolset/Other/Final exports" } });
});
