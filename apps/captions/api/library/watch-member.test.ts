import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// A member of the owner's workspace reads the library's state (GET /watch, UNIFIED-PRD §3.2) without the owner's folders.
// The workspace and the shared project are written first: homeOf and sharedWith read them once, at first use.
const dir = realpathSync(mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-watch-member-")));
process.env.DATA_DIR = path.join(dir, "data");
process.env.LIBRARY_WATCH_FOLDERS = "1";
const WS = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
mkdirSync(path.join(process.env.DATA_DIR, "workshop", "projects"), { recursive: true });
writeFileSync(
  path.join(process.env.DATA_DIR, "workspaces.json"),
  JSON.stringify({
    workspaces: [
      {
        id: WS,
        name: "Tiny Acrobatics",
        plan: "team",
        comped: true,
        createdAt: 1,
        members: [
          { username: "ownerw", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 1 },
          { username: "memberw", role: "member", ai: "own", budgetUsd: 0, joinedAt: 1, workspaces: [PROJECT] },
        ],
      },
    ],
    invites: [],
    spend: {},
  }),
);
writeFileSync(
  path.join(process.env.DATA_DIR, "workshop", "projects", `${PROJECT}.json`),
  JSON.stringify({ id: PROJECT, owner: "ownerw", name: "Tiny Acrobatics", audience: "", voice: "", cta: "", notes: "", knowledge: [], createdAt: 1, updatedAt: 1 }),
);
const { libraryDb } = await import("./db");
const { watchApp } = await import("./watch");

afterAll(() => {
  delete process.env.LIBRARY_WATCH_FOLDERS;
  rmSync(dir, { recursive: true, force: true });
});

libraryDb()
  .prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_wm', ?, 'Tiny Acrobatics library', 'local', '{}', 1)")
  .run(WS);

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "user" } as never);
  return next();
});
app.route("/api/library", watchApp);
const get = (user: string) => app.request("/api/library/lib_wm/watch", { headers: { "x-user": user } });

describe("GET /api/library/:id/watch for a workspace member", () => {
  it("the owner reads the library's folders", async () => {
    const r = await get("ownerw");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { folders: unknown[] }).folders).toEqual([]);
  });

  it("a member the owner gave the workspace reads its state, with no folders of the owner's", async () => {
    const r = await get("memberw");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { folders: unknown[]; missing: number; copyTo?: string };
    expect(body.folders).toEqual([]);
    expect(body.missing).toBe(0);
    expect(body.copyTo).toBeUndefined();
  });

  it("someone outside the workspace gets 404, as before", async () => {
    expect((await get("stranger")).status).toBe(404);
  });
});
