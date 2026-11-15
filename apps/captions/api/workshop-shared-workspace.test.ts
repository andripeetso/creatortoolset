import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { expect, it } from "vitest";

// The team owner gives a member some of their workspaces (Settings → Team → Access): those show in the member's
// switcher, and the owner's Workshop projects there open to read. Nothing else of the owner's does, and nothing is written.
const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "ws-shared-"));
process.env.DATA_DIR = dataDir;
const { workshopApp } = await import("./workshop");
const { workspaceApp } = await import("./workspace");
const { inRequestWorkspace } = await import("./lib/workspace-scope");

const BRAND = "bbbbbbbb-0000-4000-8000-000000000001"; // alex's, given to bo
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002"; // alex's, not given
const EVES = "bbbbbbbb-0000-4000-8000-000000000003"; // another owner's
const S1 = "aaaaaaaa-0000-4000-8000-000000000001"; // alex's, in BRAND
const S2 = "aaaaaaaa-0000-4000-8000-000000000002"; // alex's, in OTHER

const projects = path.join(dataDir, "workshop", "projects");
mkdirSync(projects, { recursive: true });
const project = (id: string, owner: string, name: string, createdAt: number) =>
  writeFileSync(path.join(projects, `${id}.json`), JSON.stringify({ id, owner, name, audience: "", voice: "", cta: "", notes: "", createdAt, updatedAt: createdAt }));
project(BRAND, "alex", "Tiny Acrobatics", 1);
project(OTHER, "alex", "Northlight", 2);
project(EVES, "eve", "Eve's brand", 3);

function session(id: string, owner: string, projectId: string, text: string) {
  const dir = path.join(dataDir, "workshop", "sessions", id);
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, owner, projectId, title: text, query: "", status: "draft", sources: [], drafts: [], createdAt: 1, updatedAt: 5 }));
  writeFileSync(
    path.join(dir, "docs", "cccccccc-0000-4000-8000-000000000001.json"),
    JSON.stringify({ id: "cccccccc-0000-4000-8000-000000000001", sessionId: id, kind: "reel", title: "Reel", frameworkIds: [], versions: [], nextBlock: 2, nextVersion: 1, createdAt: 1, updatedAt: 2, blocks: [{ id: "b1", text, author: "user", at: 1 }] }),
  );
}
session(S1, "alex", BRAND, "Brand words");
session(S2, "alex", OTHER, "Other words");

writeFileSync(
  path.join(dataDir, "workspaces.json"),
  JSON.stringify({
    workspaces: [
      {
        id: "team-1",
        name: "Team",
        plan: "team",
        comped: false,
        createdAt: 0,
        members: [
          { username: "alex", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 },
          { username: "bo", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0 },
          { username: "cy", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0 },
        ],
      },
    ],
    invites: [],
    spend: {},
  }),
);

const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  c.set("user", { username: c.req.header("x-test-user") ?? "", role: "team", cloud: true, off: [] });
  await next();
});
app.use("*", inRequestWorkspace);
app.route("/api/workshop", workshopApp as never);
app.route("/api/workspace", workspaceApp as never);

const call = (user: string, method: string, url: string, body?: unknown, ws?: string) =>
  app.request(url, {
    method,
    headers: { "x-test-user": user, "Content-Type": "application/json", ...(ws ? { "x-ct-workspace": ws } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

it("the owner gives only their own workspaces, and the member's switcher lists just those", async () => {
  const set = await call("alex", "PATCH", "/api/workspace/members/bo", { workspaces: [BRAND, EVES, "junk"] });
  expect(set.status).toBe(200);
  const view = (await set.json()) as { members: { username: string; workspaces?: string[] }[]; brands: { id: string }[] };
  expect(view.members.find((m) => m.username === "bo")?.workspaces).toEqual([BRAND]);
  expect(view.brands.map((b) => b.id).sort()).toEqual([BRAND, OTHER]);
  const ws = (await (await call("bo", "GET", "/api/workshop/workspace")).json()) as { projects: { id: string }[] };
  expect(ws.projects.map((p) => p.id)).toEqual([BRAND]);
  expect((await call("bo", "PATCH", "/api/workshop/workspace", { currentProjectId: OTHER })).status).not.toBe(200);
});

it("in a given workspace the owner's projects there are listed and open to read; writes and other workspaces are 404", async () => {
  const rows = (await (await call("bo", "GET", `/api/workshop/sessions?projectId=${BRAND}`, undefined, BRAND)).json()) as { id: string; readOnly?: boolean }[];
  expect(rows).toEqual([expect.objectContaining({ id: S1, readOnly: true })]);
  const read = await call("bo", "GET", `/api/workshop/team/sessions/${S1}`);
  expect(read.status).toBe(200);
  expect(((await read.json()) as { pieces: { blocks: { text: string }[] }[] }).pieces[0]!.blocks[0]!.text).toBe("Brand words");
  expect((await call("bo", "GET", `/api/workshop/team/sessions/${S2}`)).status).toBe(404);
  expect((await call("cy", "GET", `/api/workshop/team/sessions/${S1}`)).status).toBe(404);
  expect((await call("bo", "GET", `/api/workshop/sessions/${S1}`)).status).toBe(404);
  expect((await call("bo", "PATCH", `/api/workshop/sessions/${S1}`, { title: "mine now" })).status).toBe(404);
});

it("taking the workspace away holds at the next request", async () => {
  expect((await call("alex", "PATCH", "/api/workspace/members/bo", { workspaces: [] })).status).toBe(200);
  expect((await call("bo", "GET", `/api/workshop/team/sessions/${S1}`)).status).toBe(404);
  const ws = (await (await call("bo", "GET", "/api/workshop/workspace")).json()) as { projects: { id: string }[] };
  expect(ws.projects).toEqual([]);
});
