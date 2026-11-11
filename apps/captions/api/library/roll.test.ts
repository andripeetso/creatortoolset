import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
const { recordVersion } = await import("./routes");
const { saveTranscript } = await import("./transcribe");
const { saveDescribed } = await import("./describe");
const { decideRoll, rollFromSpeech, rollLine, sortAfter, sortRoll, sortUnsorted } = await import("./roll");
const { footageTargetFor } = await import("../editor/ingest");

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

  it("the list narrows to one roll and to versions", () => {
    const a = buildAssetQuery("lib_r", { roll: "a" });
    const rows = d().prepare(a.sql).all(...a.params) as { roll: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.roll === "a")).toBe(true);
    const b = buildAssetQuery("lib_r", { roll: "b", versions: ["ver-1"] });
    expect(d().prepare(b.sql).all(...b.params)).toHaveLength(1); // ver-1: the lyrics over the sea
  });

  it("clips from before are sorted from what they have, with no job run", async () => {
    const old = clip();
    saveTranscript(d(), old, "deepgram", "en", talk);
    d().prepare("UPDATE assets SET roll = NULL").run();
    expect(await sortUnsorted(d())).toBeGreaterThan(1);
    expect(rollOf(old)).toBe("a");
    expect(d().prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 1 }); // only the first test's transcribe
  });
});

describe("the A-roll folder people already have", () => {
  it("becomes the smart folder of A-roll: its videos filed as A-roll, a picture in it stays in the library, other folders untouched", () => {
    const at = MIGRATIONS.findIndex((m) => m.includes("filed_roll"));
    const file = path.join(dir, "before.db");
    const old = new DatabaseSync(file);
    for (const m of MIGRATIONS.slice(0, at)) old.exec(m);
    old.exec(`PRAGMA user_version = ${at}`);
    old.exec(`
      INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_o', 'bo', 'O', 'local', 0);
      INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('take', 'lib_o', 'video', 'Take', 'bo', 0), ('still', 'lib_o', 'image', 'Still', 'bo', 0), ('sea', 'lib_o', 'video', 'Sea', 'bo', 0);
      INSERT INTO collections (id, library_id, parent_id, name, kind, query, created_at, created_by) VALUES ('col_a', 'lib_o', NULL, 'A-roll', 'manual', NULL, 0, 'bo'), ('col_b', 'lib_o', NULL, 'B-roll', 'manual', NULL, 0, 'bo');
      INSERT INTO collection_items (collection_id, asset_id, position, added_by) VALUES ('col_a', 'take', 1, 'bo'), ('col_a', 'still', 2, 'bo'), ('col_b', 'sea', 1, 'bo');
    `);
    old.close();
    const db = openLibraryDb(file);
    expect(db.prepare("SELECT kind, query FROM collections WHERE id = 'col_a'").get()).toEqual({ kind: "smart", query: '{"roll":"a"}' });
    expect(db.prepare("SELECT kind FROM collections WHERE id = 'col_b'").get()).toEqual({ kind: "manual" });
    expect(db.prepare("SELECT id, filed_roll FROM assets ORDER BY id").all()).toEqual([
      { id: "sea", filed_roll: null },
      { id: "still", filed_roll: null },
      { id: "take", filed_roll: "a" },
    ]);
    expect(db.prepare("SELECT collection_id, asset_id FROM collection_items").all()).toEqual([{ collection_id: "col_b", asset_id: "sea" }]);
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
  });
});
