import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-embed-"));
process.env.DATA_DIR = dir;
delete process.env.APP_SECRET; // the solo install: "local" is the admin
delete process.env.OPENAI_API_KEY;
const { libraryDb } = await import("./db");
const { searchApp } = await import("./search");
const { indexAsset } = await import("./query");
const { saveTranscript } = await import("./transcribe");
const { cosineTop, embedChunks, embedModel, embedVersion, rrf } = await import("./embed");

afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
});

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "user" } as never);
  return next();
});
app.route("/api/library", searchApp);
const search = async (user: string, q: string) =>
  (await (await app.request(`/api/library/lib_a/search?q=${encodeURIComponent(q)}`, { headers: { "x-user": user } })).json()) as {
    asset: { id: string };
    seconds?: number;
  }[];

const vec = (...xs: number[]) => Float32Array.from(xs);

function seed(id: string, title: string) {
  const d = libraryDb();
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, ?, 'local', 1)").run(id, title, `ver-${id}`);
  d.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at)
     VALUES (?, ?, 1, 'k', 1, ?, '{"duration":60}', 'ready', 'local', 1)`,
  ).run(`ver-${id}`, id, `sha-${id}`);
  indexAsset(d, id);
}
const putVec = (id: string, chunk: number, start: number, v: Float32Array) =>
  libraryDb()
    .prepare("INSERT OR REPLACE INTO embeddings (version_id, chunk, start_s, model, dims, vec) VALUES (?, ?, ?, ?, ?, ?)")
    .run(`ver-${id}`, chunk, start, embedModel(), v.length, new Uint8Array(v.buffer));

/** An embeddings endpoint that answers every input with `q`. */
const answer = (q: number[]) =>
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    return Response.json({ data: input.map((_, index) => ({ index, embedding: q })) });
  });

beforeAll(() => {
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'local', 'A', 'local', 0)").run();
  seed("ast-roll", "Forward roll");
  seed("ast-beam", "Balance beam");
  seed("ast-swing", "Rope swing");
  putVec("ast-roll", 0, 0, vec(1, 0, 0));
  putVec("ast-beam", 0, 0, vec(0, 1, 0));
  putVec("ast-swing", 0, 0, vec(0.6, 0.8, 0));
  putVec("ast-swing", 1, 30, vec(0, 0, 1));
});

describe("ranking", () => {
  it("cosine picks the closest vectors first, and skips another model's length", () => {
    const rows = [{ id: "a", vec: vec(1, 0) }, { id: "b", vec: vec(0.7, 0.7) }, { id: "c", vec: vec(0, 1) }, { id: "x", vec: vec(1, 0, 0) }];
    expect(cosineTop(vec(0, 2), rows).map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(cosineTop(vec(1, 0), rows, 1).map((r) => r.id)).toEqual(["a"]);
  });

  it("RRF: an item high in both lists beats one that tops a single list", () => {
    const fused = rrf([["a", "b", "c"], ["b", "d", "a"]], (x) => x);
    // b: 1/62 + 1/61; a: 1/61 + 1/63; d: 1/62; c: 1/63
    expect(fused).toEqual(["b", "a", "d", "c"]);
  });
});

describe("semantic search", () => {
  it("off: the full-text hits alone, and no embedding call", async () => {
    libraryDb().prepare(`UPDATE libraries SET settings = json_set(settings, '$.embed', json('false')) WHERE id = 'lib_a'`).run();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    process.env.OPENAI_API_KEY = "test-key";
    expect((await search("local", "roll")).map((h) => h.asset.id)).toEqual(["ast-roll"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("on: the closest chunks fused with the full-text hits; a transcript chunk carries its second", async () => {
    libraryDb().prepare(`UPDATE libraries SET settings = json_set(settings, '$.embed', json('true')) WHERE id = 'lib_a'`).run();
    process.env.OPENAI_API_KEY = "test-key";
    answer([0, 1, 0]);
    // "beam" matches one title by words; by meaning: beam, then swing, then roll
    const hits = await search("local", "beam");
    expect(hits.map((h) => [h.asset.id, h.seconds])).toEqual([
      ["ast-beam", undefined],
      ["ast-swing", undefined],
      ["ast-roll", undefined],
      ["ast-swing", 30],
    ]);
  });

  it("a searcher with no key route gets the full-text hits, never an error", async () => {
    answer([0, 1, 0]);
    expect((await search("local", "beam")).map((h) => h.asset.id)).toEqual(["ast-beam"]);
  });
});

describe("embed job", () => {
  it("chunks: title and description, then about 30 s of transcript each", () => {
    const seg = (start: number, text: string) => ({ start, end: start + 2, text });
    expect(embedChunks("Roll", "A person rolls.", [seg(0, "Tuck."), seg(10, "Roll."), seg(31, "Again.")])).toEqual([
      { start: 0, text: "Roll\nA person rolls." },
      { start: 0, text: "Tuck. Roll." },
      { start: 31, text: "Again." },
    ]);
  });

  it("stores one row per chunk with the answer's dims, and needs a key", async () => {
    seed("ast-new", "Handstand");
    saveTranscript(libraryDb(), "ver-ast-new", "deepgram", "en", [{ start: 0, end: 2, text: "Hold it." }]);
    await expect(embedVersion(libraryDb(), "ver-ast-new", "local")).rejects.toThrow("Add your OpenAI key in Settings → API keys");
    process.env.OPENAI_API_KEY = "test-key";
    answer([0.1, 0.2, 0.3, 0.4]);
    await embedVersion(libraryDb(), "ver-ast-new", "local");
    const rows = libraryDb().prepare("SELECT chunk, start_s, dims FROM embeddings WHERE version_id = 'ver-ast-new' ORDER BY chunk").all();
    expect(rows).toEqual([
      { chunk: 0, start_s: 0, dims: 4 },
      { chunk: 1, start_s: 0, dims: 4 },
    ]);
  });
});
