import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-access-"));
process.env.DATA_DIR = dir;
// an account with the Media Library switched off, written before the user store loads
writeFileSync(
  path.join(dir, "users.json"),
  JSON.stringify({
    users: [
      { username: "off-a", salt: "", hash: "", role: "user", cloud: true, off: ["media"], createdAt: 0 },
      { username: "old", salt: "", hash: "", role: "user", cloud: true, off: [], createdAt: 0 },
    ],
  }),
);
// an install from before: its owner's libraries carry the id it had then
writeFileSync(path.join(dir, "workspaces.json"), JSON.stringify({ workspaces: [{ id: "ws_old", members: [{ username: "old", role: "owner" }, { username: "mem", role: "member" }] }] }));
const { libraryDb } = await import("./db");
const { homeOf, libraryChanged, libraryRole } = await import("./access");
const { syncApp } = await import("../lib/sync");
const { similarTo } = await import("./similar");
const { libraryRef } = await import("./attach");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeAll(() => {
  const insert = libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES (?, ?, ?, 'local', 0)");
  insert.run("lib_a", "ana", "A");
  insert.run("lib_b", "bo", "B");
  insert.run("lib_off", "off-a", "Off");
  insert.run("lib_old", "ws_old", "Old");
  const d = libraryDb();
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('ast_a', 'lib_a', 'video', 'Roll', 'v_a', 'ana', 0), ('ast_off', 'lib_off', 'video', 'Roll', 'v_off', 'off-a', 0)").run();
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('v_a', 'ast_a', 1, 'k', 1, 'h', 'ready', 'ana', 0), ('v_off', 'ast_off', 1, 'k2', 1, 'h2', 'ready', 'off-a', 0)").run();
  d.prepare("INSERT INTO derivatives (version_id, kind, inline) VALUES ('v_a', 'fingerprint', ?), ('v_off', 'fingerprint', ?)").run(JSON.stringify({ phash: ["0000000000000000"] }), JSON.stringify({ phash: ["0000000000000000"] }));
});

describe("libraryRole", () => {
  it("is the owner of their own library and nobody else's", () => {
    expect(libraryRole("ana", "lib_a")).toBe("owner");
    expect(libraryRole("ana", "lib_b")).toBeNull();
    expect(libraryRole("bo", "lib_a")).toBeNull();
    expect(libraryRole("ana", "lib_missing")).toBeNull();
  });

  it("keeps an install's old library id for its owner, never for anyone else", () => {
    expect(homeOf("old")).toBe("ws_old");
    expect(libraryRole("old", "lib_old")).toBe("owner");
    expect(libraryRole("mem", "lib_old")).toBeNull();
  });

  it("is null with the Media Library switched off, so the Workshop reads nothing of it", async () => {
    expect(libraryRole("off-a", "lib_off")).toBeNull();
    expect(await libraryRef("off-a", "ast_off", "v_off")).toBeNull();
    expect(similarTo("off-a", ["0000000000000000"]).matches).toEqual([]);
    expect(await libraryRef("ana", "ast_a", "v_a")).not.toBeNull();
    expect(similarTo("ana", ["0000000000000000"]).matches.map((m) => m.assetId)).toEqual(["ast_a"]);
  });
});

describe("libraryChanged", () => {
  /** The newest "library" change this account's open tabs were told about (the stream's hello). */
  const heard = async (user: string) => {
    const { Hono } = await import("hono");
    const app = new Hono<{ Variables: { user: { username: string } } }>();
    app.use("*", async (c, next) => {
      c.set("user", { username: user });
      await next();
    });
    app.route("/", syncApp as never);
    const ac = new AbortController();
    const res = await app.request("/events", { signal: ac.signal });
    const { value } = await res.body!.getReader().read();
    ac.abort();
    return (JSON.parse(/data: (.*)/.exec(new TextDecoder().decode(value))![1]) as { topics: Record<string, number> }).topics.library;
  };

  it("tells the library's own account, an install's old library id included, and nobody else", async () => {
    libraryChanged("lib_old");
    expect(await heard("old")).toBeGreaterThan(0);
    expect(await heard("ws_old")).toBeUndefined();
    libraryChanged("lib_a");
    expect(await heard("ana")).toBeGreaterThan(await heard("old"));
    expect(await heard("bo")).toBeUndefined();
  });
});
