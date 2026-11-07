import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-access-"));
process.env.DATA_DIR = dir;
// an account with the Media Library switched off, written before the user store loads
writeFileSync(path.join(dir, "users.json"), JSON.stringify({ users: [{ username: "off-a", salt: "", hash: "", role: "user", cloud: true, off: ["media"], createdAt: 0 }] }));
const { libraryDb } = await import("./db");
const { libraryRole } = await import("./access");
const { similarTo } = await import("./similar");
const { libraryRef } = await import("./attach");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const member = (username: string, role: "owner" | "member") => ({ username, role, ai: "own", budgetUsd: 0, joinedAt: 0 });
const workspace = (id: string, members: ReturnType<typeof member>[]) => ({ id, name: id, plan: "team", comped: false, createdAt: 0, members });

beforeAll(() => {
  // two teams, written before the first read so the workspace store loads them
  writeFileSync(
    path.join(dir, "workspaces.json"),
    JSON.stringify({
      workspaces: [workspace("ws_a", [member("owner-a", "owner"), member("mem-a", "member"), member("off-a", "member")]), workspace("ws_b", [member("owner-b", "owner")])],
      invites: [],
      spend: {},
    }),
  );
  const insert = libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES (?, ?, ?, 'local', 0)");
  insert.run("lib_a", "ws_a", "A");
  insert.run("lib_b", "ws_b", "B");
  const d = libraryDb();
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('ast_a', 'lib_a', 'video', 'Roll', 'v_a', 'owner-a', 0)").run();
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('v_a', 'ast_a', 1, 'k', 1, 'h', 'ready', 'owner-a', 0)").run();
  d.prepare("INSERT INTO derivatives (version_id, kind, inline) VALUES ('v_a', 'fingerprint', ?)").run(JSON.stringify({ phash: ["0000000000000000"] }));
});

describe("libraryRole", () => {
  it("gives the owner and the member of a library's workspace their role", () => {
    expect(libraryRole("owner-a", "lib_a")).toBe("owner");
    expect(libraryRole("mem-a", "lib_a")).toBe("member");
  });

  it("is null across workspaces: nobody from one team reaches the other team's library", () => {
    expect(libraryRole("owner-a", "lib_b")).toBeNull();
    expect(libraryRole("owner-b", "lib_a")).toBeNull();
    expect(libraryRole("mem-a", "lib_b")).toBeNull();
  });

  it("is null for an unknown library or an account in no workspace", () => {
    expect(libraryRole("owner-a", "lib_missing")).toBeNull();
    expect(libraryRole("nobody", "lib_a")).toBeNull();
  });

  it("is null for a member with the Media Library switched off, so the Workshop and the Video Cleaner read nothing of it", () => {
    expect(libraryRole("off-a", "lib_a")).toBeNull();
    expect(libraryRef("off-a", "ast_a", "v_a")).toBeNull();
    expect(similarTo("off-a", ["0000000000000000"]).matches).toEqual([]);
    expect(libraryRef("mem-a", "ast_a", "v_a")).not.toBeNull();
    expect(similarTo("mem-a", ["0000000000000000"]).matches.map((m) => m.assetId)).toEqual(["ast_a"]);
  });
});
