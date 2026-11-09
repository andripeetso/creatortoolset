import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-db-bunny-"));
process.env.DATA_DIR = path.join(dir, "data");
const { libraryDb, libraryStore } = await import("./db");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("libraryStore picks the backend a library's storage_kind names", () => {
  it("selects the bunny store for a bunny library, signing links only with a pull zone and token key", () => {
    const db = libraryDb();
    const config = JSON.stringify({ zone: "tinyacrobatics", accessKey: "tiny-zone-password" });
    db.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, storage_config, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("lib_bunny", "owner-a", "B", "bunny", config, 0);
    const store = libraryStore("lib_bunny");
    expect(store.kind).toBe("bunny");
    expect(store.caps).toEqual({ signedUrls: false, localPaths: true });

    const signed = JSON.stringify({ zone: "tinyacrobatics", accessKey: "tiny-zone-password", cdnHost: "tinyacrobatics.b-cdn.net", tokenKey: "tiny-token-key" });
    db.prepare("UPDATE libraries SET storage_config = ? WHERE id = ?").run(signed, "lib_bunny");
    expect(libraryStore("lib_bunny").caps).toEqual({ signedUrls: true, localPaths: false });
  });

  it("refuses a bunny library whose zone or password is missing", () => {
    libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, storage_config, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("lib_bunny_bad", "owner-a", "B", "bunny", "{}", 0);
    expect(() => libraryStore("lib_bunny_bad")).toThrow("not set up");
  });
});
