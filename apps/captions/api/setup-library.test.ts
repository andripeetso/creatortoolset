import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "./auth";
import type { SessionUser } from "./users";

// Home's Media Library tile (its amber "needs setup" dot) reads "library" in GET /api/setup. It is the workspace the
// request works in that counts (11-19: the account's oldest library answered, so a new workspace showed ready).

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "setup-library-"));
process.env.DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// two Workshop workspaces of tiny's: ws_old (set up) and ws_new (not)
mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
for (const [id, name, at] of [["ws_old", "Tiny Acrobatics", 1], ["ws_new", "Tiny Vlogs", 5]] as const)
  writeFileSync(path.join(dir, "workshop", "projects", `${id}.json`), JSON.stringify({ id, owner: "tiny", name, audience: "", voice: "", cta: "", notes: "", createdAt: at, updatedAt: at }));

const { setupApp } = await import("./setup");
const { inRequestWorkspace } = await import("./lib/workspace-scope");
const { libraryDb } = await import("./library/db");
const who: SessionUser = { username: "tiny", role: "user", cloud: true, off: [] };
const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", who);
  await next();
});
app.use("*", inRequestWorkspace);
app.route("/api/setup", setupApp);
const have = async (ws: string) => ((await (await app.request("/api/setup", { headers: { "x-ct-workspace": ws } })).json()) as { have: string[] }).have;
const lib = (id: string, s: object) => libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'tiny', 'Library', 'local', ?, 0)").run(id, JSON.stringify(s));

describe("the setup view's Media Library", () => {
  it("is this workspace's: set up in one, not in the other", async () => {
    lib("lib_old", { projectId: "ws_old", setupAt: "2026-11-18T10:00:00.000Z" });
    lib("lib_new", { projectId: "ws_new" });
    expect(await have("ws_old")).toContain("library");
    expect(await have("ws_new")).not.toContain("library");
  });
});
