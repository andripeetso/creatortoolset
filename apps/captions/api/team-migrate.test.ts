import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The first team of a server with accounts but no workspaces.json (lib/workspaces.ts migrate): a team of one, owned by
// the platform admin ADMIN_USERNAME; the other accounts join by invite. Only that first pick reads the
// platform role; once the team exists, ownership grants nothing on the platform (team-owner-role.test.ts).
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "team-migrate-"));
process.env.CT_SERVER = "server";

const { createUser } = await import("./users");
createUser("admin", "secret-admin", { role: "admin" });
createUser("boss", "secret-boss", { role: "admin" });
createUser("ana", "secret-ana");

const { workspaceOf, memberIn } = await import("./lib/workspaces");

describe("the migrated team", () => {
  it("is owned by the server's admin, and no other account is put in it by the update", () => {
    const w = workspaceOf("admin");
    expect(w).not.toBeNull();
    expect(memberIn(w!, "admin")?.role).toBe("owner");
    expect(w!.members).toHaveLength(1);
    expect(workspaceOf("ana")).toBeNull();
  });
});
