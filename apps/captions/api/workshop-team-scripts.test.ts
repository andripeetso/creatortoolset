import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

// A team member reads the team owner's Workshop scripts when the owner switched that on for them (Member.scripts).
const dataDir = mkdtempSync(path.join(tmpdir(), "ws-team-scripts-"));
process.env.DATA_DIR = dataDir;
const { workshopApp } = await import("./workshop");
const { workspaceApp } = await import("./workspace");

const sessionsRoot = path.join(dataDir, "workshop", "sessions");
const S1 = "aaaaaaaa-0000-4000-8000-000000000001"; // alex's, to post
const S2 = "aaaaaaaa-0000-4000-8000-000000000002"; // alex's, shelved
const S3 = "aaaaaaaa-0000-4000-8000-000000000003"; // alex's, no pieces yet
const E1 = "eeeeeeee-0000-4000-8000-000000000001"; // eve's, the other team
const DOC_REEL = "cccccccc-0000-4000-8000-000000000001";
const DOC_NOTES = "cccccccc-0000-4000-8000-000000000002";

function session(id: string, owner: string, title: string, status: string, updatedAt: number, docs: Array<{ id: string; kind: string; text: string }>) {
  const dir = path.join(sessionsRoot, id);
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, owner, title, query: "", status, sources: [], drafts: [], createdAt: 1, updatedAt }));
  for (const d of docs) {
    writeFileSync(
      path.join(dir, "docs", `${d.id}.json`),
      JSON.stringify({ id: d.id, sessionId: id, kind: d.kind, title: d.kind, frameworkIds: [], versions: [], nextBlock: 2, nextVersion: 1, createdAt: 1, updatedAt: 2, blocks: [{ id: "b1", text: d.text, author: "user", at: 1 }] }),
    );
  }
}
session(S1, "alex", "Strength training", "toPost", 30, [
  { id: DOC_REEL, kind: "reel", text: "So our sample has its own plan." },
  { id: DOC_NOTES, kind: "notes", text: "private scraps" },
]);
session(S2, "alex", "Shelved idea", "shelved", 20, [{ id: "cccccccc-0000-4000-8000-000000000003", kind: "reel", text: "Shelved words" }]);
session(S3, "alex", "Empty", "draft", 10, []);
session(E1, "eve", "Eve's reel", "draft", 40, [{ id: "cccccccc-0000-4000-8000-000000000004", kind: "reel", text: "Eve's words" }]);

// alex owns team one; bo has the grant on, cy has it off (the default); dee is in another team, granted
writeFileSync(
  path.join(dataDir, "workspaces.json"),
  JSON.stringify({
    workspaces: [
      {
        id: "ws-1",
        name: "Team",
        plan: "team",
        comped: false,
        createdAt: 0,
        members: [
          { username: "alex", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 },
          { username: "bo", role: "member", ai: "own", budgetUsd: 0, scripts: true, joinedAt: 0 },
          { username: "cy", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0 },
        ],
      },
      {
        id: "ws-2",
        name: "Other",
        plan: "team",
        comped: false,
        createdAt: 0,
        members: [
          { username: "eve", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 },
          { username: "dee", role: "member", ai: "own", budgetUsd: 0, scripts: true, joinedAt: 0 },
        ],
      },
    ],
    invites: [],
    spend: {},
  }),
);

// the caller is named in a header: a stand-in for the auth middleware (boot.ts sets the real user)
const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  const username = c.req.header("x-test-user") ?? "";
  c.set("user", { username, role: "team", cloud: true, off: [] });
  await next();
});
app.route("/api/workshop", workshopApp as never);
app.route("/api/workspace", workspaceApp as never);

const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: { "x-test-user": user, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("team scripts: a member reads the owner's scripts only with the grant on", () => {
  it("a member without the grant gets 404 on both routes", async () => {
    expect((await call("cy", "GET", "/api/workshop/team/scripts")).status).toBe(404);
    expect((await call("cy", "GET", `/api/workshop/team/scripts/${S1}/docs`)).status).toBe(404);
  });

  it("a granted member gets the list: minimal fields, newest first, no shelved or piece-less sessions", async () => {
    const rows = (await (await call("bo", "GET", "/api/workshop/team/scripts")).json()) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.id)).toEqual([S1]);
    expect(Object.keys(rows[0]!).sort()).toEqual(["id", "kinds", "owner", "status", "title", "updatedAt"]);
    expect(rows[0]).toMatchObject({ id: S1, title: "Strength training", status: "toPost", kinds: ["reel"], owner: "alex", updatedAt: 30 });
  });

  it("a granted member gets the docs of a session without Notes", async () => {
    const res = await call("bo", "GET", `/api/workshop/team/scripts/${S1}/docs`);
    expect(res.status).toBe(200);
    const docs = (await res.json()) as Array<{ id: string; kind: string; blocks: Array<{ text: string }> }>;
    expect(docs.map((d) => d.id)).toEqual([DOC_REEL]);
    expect(docs[0]!.blocks[0]!.text).toBe("So our sample has its own plan.");
    expect(JSON.stringify(docs)).not.toContain("private scraps");
  });

  it("a granted member gets 404 for a shelved session, and the owner gets 404 on their own list", async () => {
    expect((await call("bo", "GET", `/api/workshop/team/scripts/${S2}/docs`)).status).toBe(404);
    expect((await call("alex", "GET", "/api/workshop/team/scripts")).status).toBe(404);
    expect((await call("alex", "GET", `/api/workshop/team/scripts/${S1}/docs`)).status).toBe(404);
  });

  it("a member of another team gets 404 on the owner's session", async () => {
    expect((await call("dee", "GET", `/api/workshop/team/scripts/${S1}/docs`)).status).toBe(404);
    const rows = (await (await call("dee", "GET", "/api/workshop/team/scripts")).json()) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual([E1]);
  });

  it("a granted member's writes to the owner's session are still refused", async () => {
    expect((await call("bo", "PATCH", `/api/workshop/sessions/${S1}`, { title: "Mine now" })).status).toBe(404);
    expect((await call("bo", "POST", `/api/workshop/sessions/${S1}/docs`, { kind: "reel" })).status).toBe(404);
    expect((await call("bo", "PATCH", `/api/workshop/sessions/${S1}/docs/${DOC_REEL}`, { kind: "ad" })).status).toBe(404);
    expect((await call("bo", "GET", `/api/workshop/sessions/${S1}/docs`)).status).toBe(404);
    const meta = JSON.parse(readFileSync(path.join(sessionsRoot, S1, "meta.json"), "utf-8")) as { title: string };
    expect(meta.title).toBe("Strength training");
  });

  it("the read creates no files in the owner's session", async () => {
    const before = readdirSync(path.join(sessionsRoot, S1, "docs")).sort();
    await call("bo", "GET", `/api/workshop/team/scripts/${S1}/docs`);
    expect(readdirSync(path.join(sessionsRoot, S1, "docs")).sort()).toEqual(before);
  });

  it("only the owner sets the grant: a member's PATCH of it is refused, the owner's works", async () => {
    expect((await call("bo", "PATCH", "/api/workspace/members/cy", { scripts: true })).status).toBe(403);
    expect((await call("bo", "PATCH", "/api/workspace/members/bo", { scripts: false })).status).toBe(403);
    expect((await call("alex", "PATCH", "/api/workspace/members/cy", { scripts: true })).status).toBe(200);
    expect((await call("cy", "GET", "/api/workshop/team/scripts")).status).toBe(200);
    expect((await call("alex", "PATCH", "/api/workspace/members/cy", { scripts: "yes" })).status).toBe(400);
    expect((await call("alex", "PATCH", "/api/workspace/members/cy", { scripts: false })).status).toBe(200);
    expect((await call("cy", "GET", "/api/workshop/team/scripts")).status).toBe(404);
  });
});
