import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it } from "vitest";
import type { AuthVars } from "./auth";

// Caption Studio keeps each workspace's projects (and folders) apart: one made in a workspace is listed only there, and
// one from before workspaces belongs to the first brand.
const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "projects-ws-"));
process.env.DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const workshop = path.join(dataDir, "workshop");
mkdirSync(path.join(workshop, "projects"), { recursive: true });
mkdirSync(path.join(workshop, "users"), { recursive: true });
for (const [id, at] of [["first", 1], ["second", 2]] as const)
  writeFileSync(path.join(workshop, "projects", `${id}.json`), JSON.stringify({ id, owner: "ana", name: id, createdAt: at, updatedAt: at }));
writeFileSync(path.join(workshop, "users", "ana.json"), JSON.stringify({ currentProjectId: "first" }));

// a project from before workspaces: no stamp
const old = randomUUID();
mkdirSync(path.join(dataDir, "projects", old, "clips"), { recursive: true });
writeFileSync(path.join(dataDir, "projects", old, "meta.json"), JSON.stringify({ id: old, name: "Old", owner: "ana", createdAt: 1, updatedAt: 1, duration: 0, clips: [] }));

const { projectsApp } = await import("./projects");
const { foldersApp } = await import("./folders");
const { inRequestWorkspace } = await import("./lib/workspace-scope");

const app = new Hono<{ Variables: AuthVars }>()
  .use(async (c, next) => {
    c.set("user", { username: "ana", role: "user" } as never);
    await next();
  })
  .use(inRequestWorkspace)
  .route("/api/projects", projectsApp)
  .route("/api/folders", foldersApp);
const call = (url: string, ws: string, init: RequestInit = {}) => app.request(url, { ...init, headers: { "x-ct-workspace": ws, "content-type": "application/json" } });
const names = async (ws: string) => ((await (await call("/api/projects", ws)).json()) as { name: string }[]).map((p) => p.name);

it("lists a project only in the workspace it was made in", async () => {
  const made = await call("/api/projects/draft", "second", { method: "POST", body: JSON.stringify({ name: "Made in second", clips: [{ id: randomUUID() }] }) });
  expect(made.status).toBe(200);
  const { id } = (await made.json()) as { id: string };
  expect(await names("second")).toEqual(["Made in second"]);
  expect(await names("first")).toEqual(["Old"]);
  // by id it still opens from the other workspace
  expect((await call(`/api/projects/${id}`, "first")).status).toBe(200);
});

it("keeps folders to their workspace, and none is lost on a change in another", async () => {
  await call("/api/folders/captions", "second", { method: "POST", body: JSON.stringify({ name: "B roll" }) });
  await call("/api/folders/captions", "first", { method: "POST", body: JSON.stringify({ name: "Reels" }) });
  const list = async (ws: string) => ((await (await call("/api/folders/captions", ws)).json()) as { folders: { name: string }[] }).folders.map((f) => f.name);
  expect(await list("second")).toEqual(["B roll"]);
  expect(await list("first")).toEqual(["Reels"]);
});
