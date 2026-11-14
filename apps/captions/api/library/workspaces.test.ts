import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it } from "vitest";
import type { AuthVars } from "../auth";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-workspaces-"));
process.env.DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { inRequestWorkspace } = await import("../lib/workspace-scope");

// three workspaces of ana's; "first" is the oldest, so a library from before workspaces is its
const projects = path.join(dir, "workshop", "projects");
mkdirSync(projects, { recursive: true });
for (const [id, at] of [["first", 1], ["second", 2], ["third", 3]] as const) {
  writeFileSync(path.join(projects, `${id}.json`), JSON.stringify({ id, owner: "ana", name: id, createdAt: at, updatedAt: at }));
}
libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_old', 'ana', 'Old', 'local', 0)").run();

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: "ana", role: "user", off: [] } as never);
  return next();
});
app.use(inRequestWorkspace);
app.route("/api/library", libraryApp);

const list = async (ws: string): Promise<string[]> =>
  ((await (await app.request("/api/library", { headers: { "x-ct-workspace": ws } })).json()) as { libraries: { id: string }[] }).libraries.map((l) => l.id);

it("gives each workspace its own library; the one from before workspaces stays in the first brand", async () => {
  expect(await list("first")).toEqual(["lib_old"]);
  const second = await list("second");
  expect(second).toHaveLength(1);
  expect(second).not.toContain("lib_old");
  expect(await list("second")).toEqual(second); // made once
  // two pages asking at once in a new workspace make one library
  const [a, b] = await Promise.all([list("third"), list("third")]);
  expect(a).toEqual(b);
  expect(a).toHaveLength(1);

  // a library made in the second workspace is listed there only
  const made = (await (await app.request("/api/library", { method: "POST", headers: { "x-ct-workspace": "second", "content-type": "application/json" }, body: JSON.stringify({ name: "Shoots" }) })).json()) as { id: string };
  expect((await list("second")).sort()).toEqual([...second, made.id].sort());
  expect(await list("first")).toEqual(["lib_old"]);
  expect(await list("third")).toEqual(a);
});
