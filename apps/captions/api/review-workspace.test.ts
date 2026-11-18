import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it } from "vitest";
import type { AuthVars } from "./auth";

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "review-ws-"));
process.env.DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const { reviewApp, addVersion, fileVideo, projectNamed, reviewJobsDone } = await import("./review");
const { inRequestWorkspace } = await import("./lib/workspace-scope");

// two workspaces; "first" is the oldest, so a video from before workspaces is its
const projects = path.join(dataDir, "workshop", "projects");
mkdirSync(projects, { recursive: true });
for (const [id, at] of [["first", 1], ["second", 2]] as const)
  writeFileSync(path.join(projects, `${id}.json`), JSON.stringify({ id, owner: "ana", name: id, createdAt: at, updatedAt: at }));
mkdirSync(path.join(dataDir, "workshop", "users"), { recursive: true });
writeFileSync(path.join(dataDir, "workshop", "users", "ana.json"), JSON.stringify({ currentProjectId: "first" }));

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "ana", role: "user", cloud: false, off: [] });
  await next();
});
app.use("*", inRequestWorkspace);
app.route("/", reviewApp);

const ws = (id?: string): Record<string, string> => (id ? { "x-ct-workspace": id } : {});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (url: string, init: RequestInit = {}): Promise<any> => (await app.request(url, init)).json();
const post = (body: unknown, workspace?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...ws(workspace) },
  body: JSON.stringify(body),
});
const names = async (url: string, workspace?: string) => ((await call(url, { headers: ws(workspace) })) as { name: string }[]).map((x) => x.name).sort();

/** Started in a workspace's window; its parts and complete come with no header (a relay's may not have it). */
async function upload(name: string, workspace: string, to: { assetId?: string; projectId?: string } = {}) {
  const bytes = Buffer.from(name);
  const init = await call("/uploads", post({ name, size: bytes.length, ...to }, workspace));
  await app.request(`/uploads/${init.id}/parts/1`, {
    method: "POST",
    headers: { "upload-length": String(bytes.length), "upload-part-size": String(init.partSize), "content-length": String(bytes.length) },
    body: bytes,
  });
  const asset = await call(`/uploads/${init.id}/complete`, { method: "POST" });
  await reviewJobsDone();
  return asset as { id: string };
}

it("keeps each workspace's videos and folders to it; a video from before workspaces is the first one's", async () => {
  const a = await upload("Tiny A.mp4", "second");
  await upload("Tiny B.mp4", "first");
  // a new version sent from the other window stays where its video is
  await upload("Tiny A2.mp4", "first", { assetId: a.id });
  await addVersion(undefined, { owner: "ana", name: "Old.mp4", mime: "video/mp4", bytes: 1 }, async () => {});
  await reviewJobsDone();

  expect(await names("/", "second")).toEqual(["Tiny A2"]);
  expect(await names("/", "first")).toEqual(["Old", "Tiny B"]);
  expect(await names("/")).toEqual(["Old", "Tiny B"]); // no header: the stored current workspace

  // a folder is its workspace's, and a video filed in it is with it
  const folder = await call("/projects", post({ name: "Tiny folder" }, "second"));
  expect(await names("/projects", "second")).toEqual(["Tiny folder"]);
  expect(await names("/projects", "first")).toEqual([]);
  await upload("Tiny C.mp4", "second", { projectId: folder.id });
  expect(await names("/", "second")).toEqual(["Tiny A2", "Tiny C"]);
  expect(await names("/", "first")).toEqual(["Old", "Tiny B"]);

  // a video from before workspaces filed in that folder (a plug-in's) is with it, and stays when taken out again
  const old = (await addVersion(undefined, { owner: "ana", name: "Older.mp4", mime: "video/mp4", bytes: 1 }, async () => {}))!;
  await reviewJobsDone();
  await fileVideo(old.meta.id, folder.id);
  await app.request(`/assets/${old.meta.id}`, { ...post({ projectId: null }), method: "PATCH" });
  expect(await names("/", "second")).toEqual(["Older", "Tiny A2", "Tiny C"]);
  // a folder found by name in a workspace is that workspace's; none there: a new one, made in it
  expect(await projectNamed("ana", "tiny  FOLDER", "second")).toBe(folder.id);
  expect(await projectNamed("ana", "Tiny folder", "first")).not.toBe(folder.id);

  // a video is still opened by its id from the other workspace
  expect((await app.request(`/assets/${a.id}`, { headers: ws("first") })).status).toBe(200);
});
