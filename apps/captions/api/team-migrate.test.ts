import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The first team of a server with accounts but no workspaces.json (lib/workspaces.ts migrate): its owner is the
// platform admin ADMIN_USERNAME, the other accounts are members on their own AI. Only that first pick reads the
// platform role; once the team exists, ownership grants nothing on the platform (team-owner-role.test.ts).
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "team-migrate-"));
process.env.CT_MODE = "hosted";

const { createUser } = await import("./users");
createUser("admin", "secret-admin", { role: "admin" });
createUser("boss", "secret-boss", { role: "admin" });
createUser("ana", "secret-ana");

const { workspaceOf, memberIn } = await import("./lib/workspaces");

describe("the migrated team", () => {
  it("is owned by the server's admin, and everyone else is a member on their own AI", () => {
    const w = workspaceOf("admin");
    expect(w).not.toBeNull();
    expect(memberIn(w!, "admin")?.role).toBe("owner");
    expect(memberIn(w!, "boss")).toMatchObject({ role: "member", ai: "own" });
    expect(memberIn(w!, "ana")).toMatchObject({ role: "member", ai: "own" });
  });
});
