import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-access-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { libraryRole } = await import("./access");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const member = (username: string, role: "owner" | "member") => ({ username, role, ai: "own", budgetUsd: 0, joinedAt: 0 });
const workspace = (id: string, members: ReturnType<typeof member>[]) => ({ id, name: id, plan: "team", comped: false, createdAt: 0, members });

beforeAll(() => {
  // two teams, written before the first read so the workspace store loads them
  writeFileSync(
    path.join(dir, "workspaces.json"),
    JSON.stringify({
      workspaces: [workspace("ws_a", [member("owner-a", "owner"), member("mem-a", "member")]), workspace("ws_b", [member("owner-b", "owner")])],
      invites: [],
      spend: {},
    }),
  );
  const insert = libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES (?, ?, ?, 'local', 0)");
  insert.run("lib_a", "ws_a", "A");
  insert.run("lib_b", "ws_b", "B");
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
});
