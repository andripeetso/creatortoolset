import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "users-two-"));
delete process.env.APP_SECRET;
const file = path.join(process.env.DATA_DIR, "users.json");
const onDisk = () => {
  try {
    return (JSON.parse(readFileSync(file, "utf-8")) as { users: Array<{ username: string; displayName?: string; role: string }> }).users;
  } catch {
    return [];
  }
};
const named = (name: string) => onDisk().find((u) => u.username === name);

// two server processes on one users.json, as during a no-downtime swap
const old = await import("./users");
old.createUser("ana", "password1");
await vi.waitFor(() => expect(named("ana")).toBeTruthy());
vi.resetModules();
const fresh = await import("./users");
expect(fresh).not.toBe(old);

it("an account made on the new process stays when the old one writes", async () => {
  fresh.createUser("bea", "password1");
  await vi.waitFor(() => expect(named("bea")).toBeTruthy());
  old.setDisplayName(old.findUser("ana")!, "Ana");
  await vi.waitFor(() => expect(named("ana")?.displayName).toBe("Ana"));
  expect(named("bea")).toBeTruthy();
  expect(old.findUser("bea")).toBeTruthy();
});

it("each process writes only the fields it changed", async () => {
  fresh.setRole(fresh.findUser("ana")!, "team");
  await vi.waitFor(() => expect(named("ana")?.role).toBe("team"));
  old.setDisplayName(old.findUser("ana")!, "Ana Old");
  await vi.waitFor(() => expect(named("ana")?.displayName).toBe("Ana Old"));
  expect(named("ana")?.role).toBe("team");
});

it("an account deleted on one process stays deleted when the other writes", async () => {
  old.deleteUser("bea");
  await vi.waitFor(() => expect(named("bea")).toBeUndefined());
  expect(fresh.wasDeleted("bea")).toBe(true);
  fresh.setDisplayName(fresh.findUser("ana")!, "Ana New");
  await vi.waitFor(() => expect(named("ana")?.displayName).toBe("Ana New"));
  expect(named("bea")).toBeUndefined();
  expect(fresh.findUser("bea")).toBeNull();
});
