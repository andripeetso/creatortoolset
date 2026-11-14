import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

// The Content Workshop in one workspace: its Knowledge tab lists the sources every workspace reads and the ones kept to
// it, never another workspace's; the "posts in the library" count is that workspace's Analyzer library.
const dataDir = mkdtempSync(path.join(tmpdir(), "ws-workshop-"));
process.env.DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const write = (file: string, v: unknown) => (mkdirSync(path.dirname(file), { recursive: true }), writeFileSync(file, JSON.stringify(v)));
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "aaaaaaaa-0000-4000-8000-000000000002";
const GONE = "aaaaaaaa-0000-4000-8000-000000000009";
for (const [id, at] of [[A, 1], [B, 2]] as const) write(path.join(dataDir, "workshop", "projects", `${id}.json`), { id, owner: "ana", name: id, createdAt: at, updatedAt: at });
write(path.join(dataDir, "workshop", "users", "ana.json"), { currentProjectId: A });

let n = 0;
const source = (name: string, projectId?: string) => {
  const id = `bbbbbbbb-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  write(path.join(dataDir, "workshop", "sources", `${id}.json`), { id, owner: "ana", name, chars: 1, status: "read", createdAt: n, updatedAt: n, ...(projectId ? { projectId } : {}) });
  writeFileSync(path.join(dataDir, "workshop", "sources", `${id}.txt`), "x");
};
source("everyone.md");
source("only-a.md", A);
source("only-b.md", B);
source("only-gone.md", GONE); // kept to a deleted workspace: the first brand's

const post = (id: string, projectId?: string) =>
  write(path.join(dataDir, "instagram", id, "meta.json"), { id, owner: "ana", kind: "reel", slides: [], creator: { username: "tinyacrobatics" }, counts: {}, ...(projectId ? { projectId } : {}) });
post("cccccccc-0000-4000-8000-000000000001", A);
post("cccccccc-0000-4000-8000-000000000002", B);
post("cccccccc-0000-4000-8000-000000000003", B);
post("cccccccc-0000-4000-8000-000000000004"); // from before workspaces: in every workspace's Analyzer

const { Hono } = await import("hono");
const { workshopApp } = await import("./workshop");
const { libraryCountFor } = await import("./instagram");
const { inRequestWorkspace } = await import("./lib/workspace-scope");
const { workspaceScope } = await import("./lib/workshop/workspace");

const user = { username: "ana", role: "user", cloud: true, off: [] } as never;
const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => (c.set("user", user), next()));
app.use("*", inRequestWorkspace);
app.route("/api/workshop", workshopApp as never);
const sources = async (ws: string) =>
  ((await (await app.request("/api/workshop/sources", { headers: { "x-ct-workspace": ws } })).json()) as Array<{ name: string }>).map((s) => s.name);

it("Knowledge lists every workspace's sources and this one's own, never another's", async () => {
  expect(await sources(A)).toEqual(["everyone.md", "only-a.md", "only-gone.md"]);
  expect(await sources(B)).toEqual(["everyone.md", "only-b.md"]);
});

it("the library count is the current workspace's", async () => {
  expect(await workspaceScope.run(A, () => libraryCountFor(user))).toBe(2);
  expect(await workspaceScope.run(B, () => libraryCountFor(user))).toBe(3);
});
