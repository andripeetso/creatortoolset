import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";

// this computer's model, stood in for: every text becomes (0, 0, 1, 0)
vi.mock("../lib/device-embed", async (real) => ({
  ...(await real<typeof import("../lib/device-embed")>()),
  embedOnDevice: async (texts: string[]) => texts.map(() => Float32Array.from([0, 0, 1, 0])),
}));

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
const { catchUpEmbeds, cosineTop, embedChunks, embedModel, embedRoute, embedVersion, rrf } = await import("./embed");
const { DEVICE_EMBED_MODEL } = await import("../lib/device-embed");

afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.CT_LOCAL;
  delete process.env.CT_MODE;
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

describe("on this computer", () => {
  const models = (id: string) => (libraryDb().prepare("SELECT DISTINCT model FROM embeddings WHERE version_id = ?").all(`ver-${id}`) as { model: string }[]).map((r) => r.model);
  const queued = (lib: string) =>
    (libraryDb().prepare("SELECT version_id FROM jobs WHERE library_id = ? AND kind = 'embed' AND state = 'queued' ORDER BY version_id").all(lib) as { version_id: string }[]).map((r) => r.version_id);

  it("a key first, else this computer when the server is on it, and a hosted server still asks for the key", () => {
    process.env.CT_LOCAL = "1";
    expect(embedRoute("local")).toEqual({ model: DEVICE_EMBED_MODEL, device: true });
    process.env.OPENAI_API_KEY = "test-key";
    expect(embedRoute("local")).toEqual({ model: embedModel(), key: "test-key" });
    delete process.env.OPENAI_API_KEY;
    process.env.CT_MODE = "hosted";
    expect(() => embedRoute("local")).toThrow("Add your OpenAI key in Settings → API keys");
  });

  it("with no key, a version's vectors are made here and replace the key's; a search compares only the same model", async () => {
    process.env.CT_LOCAL = "1";
    expect(models("ast-new")).toEqual([embedModel()]);
    await embedVersion(libraryDb(), "ver-ast-new", "local");
    expect(models("ast-new")).toEqual([DEVICE_EMBED_MODEL]);
    // the other clips still hold the key's vectors: never compared with a query made here
    expect((await search("local", "upside down")).map((h) => [h.asset.id, h.seconds])).toEqual([
      ["ast-new", undefined],
      ["ast-new", 0],
    ]);
  });

  it("catch-up queues the clips with no vectors of the route's model, once, and leaves a failed one for its Retry", () => {
    const d = libraryDb();
    d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_b', 'local', 'B', 'local', 0)").run();
    const add = (id: string, said: boolean) => {
      d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_b', 'video', ?, ?, 'local', 1)").run(id, id, `ver-${id}`);
      d.prepare(
        `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at)
         VALUES (?, ?, 1, 'k', 1, ?, '{"duration":60}', 'ready', 'local', 1)`,
      ).run(`ver-${id}`, id, `sha-${id}`);
      if (said) saveTranscript(d, `ver-${id}`, "device", "et", [{ start: 0, end: 2, text: "Tere." }]);
    };
    add("b-old", true); // made before search by meaning ran without a key: no vectors
    add("b-key", true); // the key's vectors, and the key is gone
    add("b-here", true); // already this computer's
    add("b-failed", true);
    add("b-song", false); // nothing said or described (music): never
    add("b-parked", true); // a Retry that found no key: parked, though its vectors are this computer's
    putVec("b-key", 0, 0, vec(1, 0, 0));
    for (const v of ["ver-b-here", "ver-b-parked"])
      d.prepare("INSERT INTO embeddings (version_id, chunk, start_s, model, dims, vec) VALUES (?, 0, 0, ?, 4, ?)").run(v, DEVICE_EMBED_MODEL, new Uint8Array(16));
    d.prepare(
      `INSERT INTO jobs (library_id, version_id, kind, state, actor) VALUES ('lib_b', 'ver-b-key', 'embed', 'done', 'local'),
       ('lib_b', 'ver-b-failed', 'embed', 'failed', 'local'), ('lib_b', 'ver-b-parked', 'embed', 'needs_key', 'local')`,
    ).run();
    // a hosted server with no key: nothing to make them with
    catchUpEmbeds(d);
    expect(queued("lib_b")).toEqual([]);
    process.env.CT_LOCAL = "1";
    catchUpEmbeds(d);
    expect(queued("lib_b")).toEqual(["ver-b-key", "ver-b-old", "ver-b-parked"]);
    // a key added: the key's model is the one to have, so this computer's go again too
    process.env.OPENAI_API_KEY = "test-key";
    d.prepare("DELETE FROM jobs WHERE library_id = 'lib_b' AND state = 'queued'").run();
    catchUpEmbeds(d);
    expect(queued("lib_b")).toEqual(["ver-b-here", "ver-b-old", "ver-b-parked"]);
  });
});
