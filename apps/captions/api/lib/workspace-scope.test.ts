import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "ws-scope-"));
process.env.DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const { inRequestWorkspace, currentWorkspaceId, inCurrentWorkspace } = await import("./workspace-scope");
const { workspaceScope } = await import("./workshop/workspace");

const projects = path.join(dataDir, "workshop", "projects");
mkdirSync(projects, { recursive: true });
const project = (id: string, createdAt: number) =>
  writeFileSync(path.join(projects, `${id}.json`), JSON.stringify({ id, owner: "ana", name: id, createdAt, updatedAt: createdAt }));
project("first", 1); // the oldest: things from before workspaces belong to it
project("second", 2);
const users = path.join(dataDir, "workshop", "users");
mkdirSync(users, { recursive: true });
writeFileSync(path.join(users, "ana.json"), JSON.stringify({ currentProjectId: "first" }));

const user = { username: "ana", role: "user" } as never;
const app = new Hono().use(inRequestWorkspace).get("/", async (c) => {
  const keep = await inCurrentWorkspace(user);
  const things = [{ id: "a", projectId: "first" }, { id: "b", projectId: "second" }, { id: "old" }];
  return c.json({ ws: await currentWorkspaceId(user), here: things.filter((t) => keep!(t.projectId)).map((t) => t.id) });
});
const get = async (headers: Record<string, string> = {}) => (await app.request("/", { headers })).json();

it("keeps each workspace's things to it, by the window's header", async () => {
  expect(await get({ "x-ct-workspace": "second" })).toEqual({ ws: "second", here: ["b"] });
  // no header: the stored current one; a thing from before workspaces is the first brand's
  expect(await get()).toEqual({ ws: "first", here: ["a", "old"] });
  // a workspace that isn't the person's is ignored
  expect(await get({ "x-ct-workspace": "someone-elses" })).toEqual({ ws: "first", here: ["a", "old"] });
});

it("a chat's own workspace wins over the window's header", async () => {
  const r = await workspaceScope.run({ id: "first" }, () => get({ "x-ct-workspace": "second" }));
  expect(r).toEqual({ ws: "first", here: ["a", "old"] });
});
