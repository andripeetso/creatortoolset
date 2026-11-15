import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-related-"));
process.env.DATA_DIR = dir;
delete process.env.APP_SECRET; // the solo install: "local" owns the library
const { libraryDb } = await import("./db");
const { relatedApp } = await import("./related");
const { registerLibrarySlot, resetLibrarySlots } = await import("./sources");

afterAll(() => {
  resetLibrarySlots();
  rmSync(dir, { recursive: true, force: true });
});

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "user" } as never);
  return next();
});
app.route("/api/library", relatedApp);
const related = async (assetId: string, user = "local") => {
  const r = await app.request(`/api/library/lib_a/assets/${assetId}/related`, { headers: { "x-user": user } });
  return { status: r.status, ids: r.ok ? ((await r.json()) as { related: { id: string }[] }).related.map((c) => c.id) : [] };
};

/** A clip whose chunks point the given ways (each a 3-number vector), all of one model unless named. */
function seed(id: string, vecs: number[][], model = "m1") {
  const d = libraryDb();
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, ?, 'local', 1)").run(id, `Tiny Acrobatics ${id}`, `v-${id}`);
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, 'ready', 'local', 1)").run(
    `v-${id}`,
    id,
    `libraries/lib_a/v/v-${id}/source`,
    `sha-${id}`,
  );
  const add = d.prepare("INSERT INTO embeddings (version_id, chunk, start_s, model, dims, vec) VALUES (?, ?, 0, ?, 3, ?)");
  vecs.forEach((v, i) => add.run(`v-${id}`, i, model, new Uint8Array(new Float32Array(v).buffer)));
}

beforeAll(() => {
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'local', 'A', 'local', 0)").run();
  seed("roll", [[1, 0, 0]]);
  seed("near", [[0, 1, 0], [0.95, 0.1, 0]]); // its second chunk (a line said) is close to the roll
  seed("nearer", [[1, 0.05, 0]]);
  seed("far", [[0, 0, 1]]); // below the floor
  seed("other-model", [[1, 0, 0]], "m2"); // the same direction in another model's space: not comparable
  seed("trashed", [[1, 0, 0]]);
  libraryDb().prepare("UPDATE assets SET trashed_at = 1 WHERE id = 'trashed'").run();
  seed("silent", []);
});

describe("clips close in meaning", () => {
  it("lists the closest first, by each clip's closest chunk, within one model, out of the trash", async () => {
    expect(await related("roll")).toEqual({ status: 200, ids: ["nearer", "near"] });
  });

  it("a clip with no vectors, or search by meaning switched off, lists none", async () => {
    expect(await related("silent")).toEqual({ status: 200, ids: [] });
    libraryDb().prepare(`UPDATE libraries SET settings = '{"embed":false}' WHERE id = 'lib_a'`).run();
    try {
      expect(await related("roll")).toEqual({ status: 200, ids: [] });
    } finally {
      libraryDb().prepare("UPDATE libraries SET settings = '{}' WHERE id = 'lib_a'").run();
    }
  });

  it("a clip the viewer may not see never takes a place, and a hidden or trashed clip is not found", async () => {
    registerLibrarySlot("test", { policies: [{ sourceId: "library", canSee: (_v, a) => a.assetId !== "nearer" }] });
    try {
      expect((await related("roll")).ids).toEqual(["near"]);
      expect((await related("nearer")).status).toBe(404);
    } finally {
      resetLibrarySlots();
    }
    expect((await related("trashed")).status).toBe(404);
    expect((await related("roll", "someone-else")).status).toBe(404);
  });
});
