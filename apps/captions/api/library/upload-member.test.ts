import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// A member's add (UNIFIED-PRD §4.3): taken only where Hosted media takes it, refused under Off with the §3.2 line, and
// never indexed from a member's folder. The member is given one Workshop project of the owner's (sharedProjects reads it).
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "upload-member-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_DISK_RESERVE_GB = "0";
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({
    workspaces: [
      {
        id: "tinyacrobatics",
        name: "Tiny Acrobatics",
        plan: "team",
        createdAt: 0,
        members: [
          { username: "tinyacrobatics", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 },
          { username: "sam", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0, workspaces: ["memberws"] },
        ],
      },
    ],
    invites: [],
    spend: {},
  }),
);
mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
writeFileSync(path.join(dir, "workshop", "projects", "memberws.json"), JSON.stringify({ id: "memberws", owner: "tinyacrobatics", name: "Member", createdAt: 0, updatedAt: 0 }));
const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { REFUSED_COMPUTER_OFF } = await import("./upload-gate");

afterAll(() => {
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  rmSync(dir, { recursive: true, force: true });
});

libraryDb().prepare(`INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_mem', 'tinyacrobatics', 'M', 'local', '{"upload":"none","projectId":"memberws"}', 0)`).run();

const member = new Hono<{ Variables: AuthVars }>();
member.use(async (c, next) => {
  c.set("user", { username: "sam", role: "user", off: [], read: [] } as never);
  return next();
});
member.route("/api/library", libraryApp);

const start = () =>
  member.request("/api/library/lib_mem/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename: "Handstand.mp4", size: 4 }),
  });

describe("a member's add (UNIFIED-PRD §4.3)", () => {
  it("is refused under Hosted media Off with the §3.2 line, and taken where Originals is on", async () => {
    const off = await start();
    expect(off.status).toBe(409);
    expect(await off.json()).toMatchObject({ code: "upload_refused", message: REFUSED_COMPUTER_OFF });
    libraryDb().prepare(`UPDATE libraries SET settings = json_set(settings, '$.upload', 'originals') WHERE id = 'lib_mem'`).run();
    expect((await start()).status).toBe(201);
  });

  it("is never indexed from a member's folder", async () => {
    const r = await member.request("/api/library/lib_mem/on-mac", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/Users/sam/Movies/Handstand.mp4", size: 4 }),
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ code: "forbidden" });
  });
});
