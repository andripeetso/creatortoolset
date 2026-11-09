import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-ingest-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("../library/db");
const { footageTargetFor, A_ROLL } = await import("./ingest");
const { mountPlugins } = await import("../lib/plugin");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeAll(() => {
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_ana', 'ana', 'Ana', 'local', 0)").run();
});

describe("footage from this computer is filed as A-roll", () => {
  it("files into the account's own library, in one A-roll folder made on first use", async () => {
    const first = await footageTargetFor("ana");
    expect(first?.libraryId).toBe("lib_ana");
    const row = libraryDb().prepare("SELECT name, kind, parent_id FROM collections WHERE id = ?").get(first!.collectionId) as Record<string, unknown>;
    expect(row).toEqual({ name: A_ROLL, kind: "manual", parent_id: null });
    expect((await footageTargetFor("ana"))?.collectionId).toBe(first!.collectionId);
  });

  it("gives nothing to an account with no library of its own", async () => {
    expect(await footageTargetFor("bo")).toBeNull();
  });

  it("a plug-in's footageTarget takes over the target, and a throw refuses", async () => {
    const plugin = {
      id: "fake-ingest",
      editor: { footageTarget: (u: string) => (u === "ana" ? { libraryId: "lib_other", collectionId: "col_other" } : null) },
    };
    mountPlugins(new Hono(), [plugin as never]);
    expect(await footageTargetFor("ana")).toEqual({ libraryId: "lib_other", collectionId: "col_other" });
    expect(await footageTargetFor("bo")).toBeNull();

    mountPlugins(new Hono(), [{ id: "bad-ingest", editor: { footageTarget: () => { throw new Error("no key"); } } } as never]);
    await expect(footageTargetFor("ana")).rejects.toThrow("no key");
  });
});
