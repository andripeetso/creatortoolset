import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-roll-"));
process.env.DATA_DIR = dir;
delete process.env.APP_SECRET;
const { libraryDb, openLibraryDb } = await import("./db");
const { MIGRATIONS } = await import("./schema");
const { buildAssetQuery, pageOf } = await import("./query");
const { expandCollection, collectionApp } = await import("./collections");
const { recordVersion, saveToLibrary } = await import("./routes");
const { saveTranscript } = await import("./transcribe");
const { saveDescribed } = await import("./describe");
const { decideRoll, fileRoll, rollFromSpeech, rollLine, sortAfter, sortRoll, sortUnsorted } = await import("./roll");
const { footageTargetFor } = await import("../editor/ingest");
const { searchApp } = await import("./search");
const { brollRows } = await import("../editor/broll");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const seg = (start: number, end: number, words: number) => ({ start, end, text: Array.from({ length: words }, (_, i) => `w${i}`).join(" ") });

describe("the free signals", () => {
  // what each made-up clip is, and what the rule calls it with no AI
  const cases: [string, number, boolean, ReturnType<typeof seg>[] | null, "a" | "b" | null][] = [
    ["a voice talking nearly the whole 30 s", 30, true, [seg(0.4, 9.8, 26), seg(10.5, 19.6, 25), seg(20.3, 29.5, 27)], "a"],
    ["a silent cutaway", 12, false, null, "b"],
    ["music only, nothing transcribed", 20, true, [], "b"],
    ["a few words in the background", 20, true, [seg(6, 8.5, 5)], "b"],
    ["a long clip with one sentence", 60, true, [seg(12, 15, 10)], "b"],
    ["a short take, talked through (5 s)", 5, true, [seg(0.2, 4.8, 14)], null],
    ["talk for a third of it", 24, true, [seg(2, 10, 22)], null],
    // measured on the on-device transcript of a sung line: 12 s of 20 sung, 21 words (talk: 3 to 3.7 words a second)
    ["a sung line over 20 s", 20, true, [seg(3, 9, 11), seg(9.2, 15, 10)], null],
    ["sound, not transcribed (no key yet)", 30, true, null, null],
  ];
  it.each(cases)("%s", (_what, duration, sound, segments, want) => {
    expect(rollFromSpeech(duration, sound, segments)).toBe(want);
  });

  it("counts overlapping segments once, and nothing past the clip's end", () => {
    expect(rollFromSpeech(10, true, [seg(0, 4, 15), seg(0, 4, 10)])).toBe(null); // 4 s of 10 (counted twice it would be A)
    expect(rollFromSpeech(20, true, [seg(0, 8, 15), seg(19, 40, 8)])).toBe(null); // 9 s of 20 (the 21 s past the end would make it A)
  });
});

describe("the AI's answer from the same call", () => {
  it("may turn an A into a B and settles an unclear clip, but never makes a clear B an A", () => {
    expect(decideRoll("a", undefined)).toBe("a");
    expect(decideRoll("a", "b")).toBe("b");
    expect(decideRoll(null, "a")).toBe("a");
    expect(decideRoll(null, undefined)).toBe("b"); // nobody can tell: B-roll
    expect(decideRoll("b", "a")).toBe("b");
  });
});

describe("sorting the clips in a library", () => {
  const d = () => libraryDb();
  const probe = (duration: number, sound = true) => JSON.stringify({ duration, width: 1920, height: 1080, vcodec: "h264", acodec: sound ? "aac" : "" });
  let n = 0;
  /** An asset whose current version has `probeJson`; returns its version id. */
  function clip(kind = "video", probeJson: string | null = probe(30), collectionId?: string): string {
    const v = `ver-${++n}`;
    const assetId = recordVersion(d(), { libraryId: "lib_r", versionId: v, sourceKey: `k/${v}`, filename: kind === "video" ? `C${n}.mp4` : kind === "audio" ? `S${n}.m4a` : `P${n}.jpg`, size: 1, sha256: `sha-${n}`, by: "ana", collectionId });
    d().prepare("UPDATE asset_versions SET probe = ? WHERE id = ?").run(probeJson, v);
    d().prepare("DELETE FROM jobs WHERE version_id = ?").run(v);
    return assetId && v;
  }
  const rollOf = (v: string) => (d().prepare("SELECT a.roll FROM assets a WHERE a.current_version_id = ?").get(v) as { roll: string | null }).roll;
  const talk = [seg(0.4, 9.8, 26), seg(10.5, 19.6, 25), seg(20.3, 29.5, 27)];

  beforeAll(() => {
    d().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_r', 'ana', 'R', 'local', 0)").run();
  });

  it("waits for the transcript, then sorts by it; the description's answer is read when it comes", () => {
    const v = clip();
    d().prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor) VALUES ('lib_r', ?, 'transcribe', 'queued', 'ana')").run(v);
    expect(sortRoll(d(), v)).toBe(null);
    expect(rollOf(v)).toBe(null); // not B while its words are still to come
    saveTranscript(d(), v, "device", "en", talk);
    d().prepare("UPDATE jobs SET state = 'done' WHERE version_id = ?").run(v);
    sortAfter({ kind: "transcribe", version_id: v });
    expect(rollOf(v)).toBe("a");
    saveDescribed(d(), v, { description: "Waves crash on rocks.", tags: [], roll: "b" }, "test");
    sortAfter({ kind: "describe", version_id: v });
    expect(rollOf(v)).toBe("b"); // a song's lyrics over the sea: the AI saw no one talking
  });

  it("an unclear clip is settled by the AI, else B-roll; a silent clip is B-roll at once", () => {
    const unclear = clip("video", probe(5));
    saveTranscript(d(), unclear, "device", "en", [seg(0.2, 4.8, 14)]);
    expect(sortRoll(d(), unclear)).toBe("b");
    saveDescribed(d(), unclear, { description: "A person talks to the camera.", tags: [], roll: "a" }, "test");
    expect(sortRoll(d(), unclear)).toBe("a");
    expect(sortRoll(d(), clip("video", probe(12, false)))).toBe("b");
  });

  it("sound and pictures get no roll; a clip not probed yet is left as it is", () => {
    expect(sortRoll(d(), clip("audio", JSON.stringify({ duration: 30, acodec: "aac", vcodec: "" })))).toBe(null);
    expect(sortRoll(d(), clip("image", JSON.stringify({ duration: 0, vcodec: "mjpeg", width: 10, height: 10 })))).toBe(null);
    const later = clip("video", null);
    expect(sortRoll(d(), later)).toBe(null);
    expect(rollOf(later)).toBe(null);
  });

  it("footage put in the AI Editor's A-roll folder is A-roll for good, silent or not", async () => {
    const target = await footageTargetFor("ana");
    const v = clip("video", probe(12, false), target!.collectionId);
    expect(sortRoll(d(), v)).toBe("a");
    // added to it afterwards (the New edit sheet adds each upload again): filed too, and the folder lists it
    const other = clip("video", probe(12, false));
    expect(sortRoll(d(), other)).toBe("b");
    const app = new Hono<{ Variables: AuthVars }>();
    app.use(async (c, next) => (c.set("user", { username: "ana", role: "user" } as never), next()));
    app.route("/api/library", collectionApp);
    const assetOf = (ver: string) => (d().prepare("SELECT id FROM assets WHERE current_version_id = ?").get(ver) as { id: string }).id;
    const r = await app.request(`/api/library/lib_r/collections/${target!.collectionId}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetIds: [assetOf(other)] }),
    });
    expect(await r.json()).toEqual({ added: 1 });
    expect(sortRoll(d(), other)).toBe("a");
    const listed = expandCollection("lib_r", { collectionId: target!.collectionId })!;
    const { sql, params, limit } = buildAssetQuery("lib_r", listed);
    const page = pageOf(d().prepare(sql).all(...params) as never, limit);
    expect(page.items.map((i) => i.versionId)).toEqual(expect.arrayContaining([other, v])); // and every other clip sorted A-roll
    expect(page.items.every((i) => i.roll === "a")).toBe(true);
  });

  it("the list and a typed search narrow to one roll, and the list to versions", async () => {
    const a = buildAssetQuery("lib_r", { roll: "a" });
    const rows = d().prepare(a.sql).all(...a.params) as { roll: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.roll === "a")).toBe(true);
    const b = buildAssetQuery("lib_r", { roll: "b", versions: ["ver-1"] });
    expect(d().prepare(b.sql).all(...b.params)).toHaveLength(1); // ver-1: the lyrics over the sea
    const app = new Hono<{ Variables: AuthVars }>();
    app.use(async (c, next) => (c.set("user", { username: "ana", role: "user" } as never), next()));
    app.route("/api/library", searchApp);
    const hits = (await (await app.request("/api/library/lib_r/search?q=C&roll=b")).json()) as { asset: { roll?: string } }[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.asset.roll === "b")).toBe(true);
  });

  it("a smart B-roll folder gives the AI Editor's B-roll step every clip sorted B-roll", () => {
    d().prepare(`INSERT INTO collections (id, library_id, parent_id, name, kind, query, created_at, created_by) VALUES ('col_bs', 'lib_r', NULL, 'B-roll', 'smart', '{"roll":"b"}', 0, 'ana')`).run();
    const pool = brollRows("col_bs").map((r) => r.id);
    const b = buildAssetQuery("lib_r", { roll: "b", kind: ["video"] });
    expect(pool.sort()).toEqual((d().prepare(b.sql).all(...b.params) as { version_id: string }[]).map((r) => r.version_id).sort());
    expect(pool.length).toBeGreaterThan(1);
  });

  describe("finished work has no roll: only raw material is A-roll or B-roll", () => {
    const assetOf = (ver: string) => (d().prepare("SELECT id FROM assets WHERE current_version_id = ?").get(ver) as { id: string }).id;
    const cardOf = (ver: string) => {
      const q = buildAssetQuery("lib_r", { versions: [ver] });
      return pageOf(d().prepare(q.sql).all(...q.params) as never, q.limit).items[0]!;
    };
    const listed = (roll: "a" | "b", ver: string) => {
      const q = buildAssetQuery("lib_r", { roll });
      return (d().prepare(q.sql).all(...q.params) as { version_id: string }[]).some((r) => r.version_id === ver);
    };
    const talking = () => {
      const v = clip();
      saveTranscript(d(), v, "device", "en", talk);
      return v;
    };

    it("a Review video (and an AI Editor draft filed in Review) is never sorted, also when it is talked through", () => {
      const v = talking();
      mkdirSync(path.join(dir, "review", assetOf(v)), { recursive: true });
      writeFileSync(path.join(dir, "review", assetOf(v), "meta.json"), "{}");
      expect(sortRoll(d(), v)).toBe(null);
      expect(cardOf(v)).toMatchObject({ review: true, finished: true });
      expect(cardOf(v).roll).toBeUndefined();
      expect(listed("a", v) || listed("b", v)).toBe(false);
    });

    it("a raw clip that becomes a Finals version loses its roll then; the AI Editor's footage too", async () => {
      const v = talking();
      const filed = clip("video", probe(12, false), (await footageTargetFor("ana"))!.collectionId);
      expect([sortRoll(d(), v), sortRoll(d(), filed)]).toEqual(["a", "a"]);
      d().prepare("INSERT INTO pieces (id, library_id, collection_id, label, created_by, created_at) VALUES ('pce_1', 'lib_r', NULL, 'Reel', 'ana', 0)").run();
      d().prepare("INSERT INTO piece_items (id, piece_id, version_id, position) VALUES ('pi_1', 'pce_1', ?, 1), ('pi_2', 'pce_1', ?, 2)").run(v, filed);
      for (const x of [v, filed]) {
        expect(cardOf(x).roll).toBeUndefined(); // at once, before any sort
        expect(cardOf(x).finished).toBe(true);
        expect(listed("a", x)).toBe(false);
      }
      const aroll = expandCollection("lib_r", { collectionId: (await footageTargetFor("ana"))!.collectionId })!;
      const q = buildAssetQuery("lib_r", aroll);
      expect((d().prepare(q.sql).all(...q.params) as { version_id: string }[]).map((r) => r.version_id)).not.toContain(filed);
      await sortUnsorted(d()); // the next start: the stored roll goes too
      expect([rollOf(v), rollOf(filed)]).toEqual([null, null]);
      expect(sortRoll(d(), v)).toBe(null);
    });

    it("a finished file saved into the library (a Caption Studio export, a Finals file) is never sorted; footage the assistant adds is", async () => {
      const file = path.join(dir, "export.mp4");
      writeFileSync(file, "captioned reel");
      const saved = (await saveToLibrary("ana", file, "Reel captioned.mp4", [], "lib_r")) as { versionId: string };
      writeFileSync(file, "a raw take");
      const raw = (await saveToLibrary("ana", file, "Take.mp4", [], "lib_r", true)) as { versionId: string };
      for (const x of [saved.versionId, raw.versionId]) {
        d().prepare("UPDATE asset_versions SET probe = ? WHERE id = ?").run(probe(30), x);
        saveTranscript(d(), x, "device", "en", talk);
      }
      expect(sortRoll(d(), saved.versionId)).toBe(null);
      expect(cardOf(saved.versionId).finished).toBe(true);
      expect(sortRoll(d(), raw.versionId)).toBe("a");
      // and putting the export in the A-roll folder does not make it A-roll
      fileRoll(d(), assetOf(saved.versionId), "a");
      expect(sortRoll(d(), saved.versionId)).toBe(null);
    });
  });

  it("clips from before are sorted from what they have, with no job run", async () => {
    const old = clip();
    saveTranscript(d(), old, "deepgram", "en", talk);
    d().prepare("UPDATE assets SET roll = NULL").run();
    expect(await sortUnsorted(d())).toBeGreaterThan(1);
    expect(rollOf(old)).toBe("a");
    expect(d().prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'transcribe'").get()).toEqual({ n: 1 }); // only the first test's
  });
});

describe("the A-roll folder people already have", () => {
  it("one of videos only becomes the smart A-roll folder, its videos filed as A-roll; one holding anything else stays as it is", () => {
    const at = MIGRATIONS.findIndex((m) => m.includes("filed_roll"));
    const file = path.join(dir, "before.db");
    const old = new DatabaseSync(file);
    for (const m of MIGRATIONS.slice(0, at)) old.exec(m);
    old.exec(`PRAGMA user_version = ${at}`);
    old.exec(`
      INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_o', 'bo', 'O', 'local', 0), ('lib_m', 'mo', 'M', 'local', 0);
      INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES
        ('take', 'lib_o', 'video', 'Take', 'bo', 0), ('sea', 'lib_o', 'video', 'Sea', 'bo', 0), ('reel', 'lib_o', 'video', 'Reel', 'bo', 0),
        ('mtake', 'lib_m', 'video', 'Take', 'mo', 0), ('still', 'lib_m', 'image', 'Still', 'mo', 0);
      INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('v_take', 'take', 1, 'k1', 1, 's1', 'ready', 'bo', 0), ('v_reel', 'reel', 1, 'k2', 1, 's2', 'ready', 'bo', 0);
      INSERT INTO derived_from (version_id, source_version_id, note) VALUES ('v_reel', 'v_take', 'export');
      INSERT INTO collections (id, library_id, parent_id, name, kind, query, created_at, created_by) VALUES
        ('col_a', 'lib_o', NULL, 'A-roll', 'manual', NULL, 0, 'bo'), ('col_b', 'lib_o', NULL, 'B-roll', 'manual', NULL, 0, 'bo'), ('col_m', 'lib_m', NULL, 'A-roll', 'manual', NULL, 0, 'mo');
      INSERT INTO collection_items (collection_id, asset_id, position, added_by) VALUES ('col_a', 'take', 1, 'bo'), ('col_b', 'sea', 1, 'bo'), ('col_m', 'mtake', 1, 'mo'), ('col_m', 'still', 2, 'mo');
    `);
    old.close();
    const db = openLibraryDb(file);
    expect(db.prepare("SELECT id, kind, query FROM collections ORDER BY id").all()).toEqual([
      { id: "col_a", kind: "smart", query: '{"roll":"a"}' },
      { id: "col_b", kind: "manual", query: null }, // a person's own B-roll folder is theirs
      { id: "col_m", kind: "manual", query: null }, // a picture in it: left exactly as it is
    ]);
    expect(db.prepare("SELECT id, filed_roll FROM assets ORDER BY id").all()).toEqual([
      { id: "mtake", filed_roll: null },
      { id: "reel", filed_roll: "none" }, // an export saved before: finished work
      { id: "sea", filed_roll: null },
      { id: "still", filed_roll: null },
      { id: "take", filed_roll: "a" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM collection_items").get()).toEqual({ n: 4 }); // every row kept
    db.close();
  });
});

describe("the line the assistant says", () => {
  const card = (roll?: "a" | "b", kind: "video" | "audio" = "video", probed = true) => ({ kind, state: "processing" as const, ...(roll ? { roll } : {}), ...(probed ? { durationS: 9, ...(kind === "video" ? { width: 1920 } : {}) } : {}) });
  it("says what was added and how it was sorted", () => {
    expect(rollLine([...Array(3)].map(() => card("a")).concat([...Array(9)].map(() => card("b"))))).toBe("12 clips added: 3 A-roll, 9 B-roll");
    expect(rollLine([card("a"), card("b"), card(undefined, "video", false)])).toBe("3 clips added: 1 A-roll, 1 B-roll, 1 still being sorted");
    expect(rollLine([card(), card()])).toBe("2 clips added: still being sorted into A-roll and B-roll");
    expect(rollLine([card("b"), card(undefined, "audio")])).toBe("1 clip added: 1 B-roll. 1 other file added too");
    expect(rollLine([card(undefined, "audio")])).toBe("1 file added");
    expect(rollLine([card("a"), { ...card(), finished: true as const }])).toBe("1 clip added: 1 A-roll. 1 other file added too"); // a Finals reel: never waited for
  });
});
