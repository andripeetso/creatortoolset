import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-export-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-export-test-secret";

const { createUser } = await import("../users");
const app = (await import("../boot")).default;
const { blobs, libraryDb } = await import("../library/db");
const { createEdit, editDir, saveDraft } = await import("./store");
const { frameDuration, time, toFcpxml } = await import("./fcpxml");
const { mediaPaths, namesOf } = await import("./media");
const { toOtio } = await import("./otio");
const { emptyTracks, sourceOf } = await import("./timeline");

const golden = (name: string) => path.join(import.meta.dirname, "golden", name);
/** Compares with the golden file; UPDATE_GOLDEN=1 writes it instead (read the diff before committing one). */
function matchGolden(name: string, text: string) {
  if (process.env.UPDATE_GOLDEN) writeFileSync(golden(name), text);
  expect(text).toBe(readFileSync(golden(name), "utf8"));
}

/** Two cuts at 29.97 fps: Take A (29.97, starts at 01:00:00;00 drop frame) wide, then Take B (59.94, no timecode) punched in. */
function twoCuts(): Timeline {
  const probe = { duration: 20, width: 1080, height: 1920, rotation: 0, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" };
  const tl: Timeline = {
    name: "Tiny Acrobatics v1",
    fps: 29.97,
    width: 1080,
    height: 1920,
    sources: {
      ver_a: sourceOf("ver_a", "Take A", { ...probe, fps: 29.97, timecode: "01:00:00;00" }),
      ver_b: sourceOf("ver_b", "Take B", { ...probe, fps: 59.94 }),
    },
    tracks: emptyTracks(),
    markers: [
      { rec: 0, name: "L1", color: "BLUE", note: "We teach rolls" },
      { rec: 45, name: "L2", color: "BLUE", note: "Join the class & stay" },
    ],
  };
  tl.tracks.V1.items = [
    { src: "ver_a", in: 12, len: 45, rec: 0, link: "c1" },
    { src: "ver_b", in: 300, len: 60, rec: 45, link: "c2", zoom: 1.15, tilt: -34.56 },
  ];
  tl.tracks.A1.items = tl.tracks.V1.items.map(({ zoom: _z, tilt: _t, ...i }) => i);
  return tl;
}
const files = { ver_a: "/Users/tiny/Footage/Take A.mov", ver_b: "/Users/tiny/Footage/Take B.mov" };

beforeAll(() => {
  createUser("mem-a", "password1", { role: "user" });
  libraryDb().exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, storage_config, created_at) VALUES
      ('lib_a', 'mem-a', 'A', 'local', NULL, 0),
      ('lib_s3', 'mem-a', 'Bucket', 's3', '{"mode":"own","endpoint":"http://127.0.0.1:9","region":"us-east-1","bucket":"tiny","pathStyle":true,"accessKey":"test","secretKey":"test"}', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES
      ('ast_1', 'lib_a', 'video', 'Take A', 'mem-a', 0), ('ast_2', 'lib_a', 'video', 'Take A', 'mem-a', 0),
      ('ast_3', 'lib_a', 'video', 'Watched', 'mem-a', 0), ('ast_4', 'lib_s3', 'video', 'Take A', 'mem-a', 0);
  `);
  const add = (id: string, asset: string, key: string, sourcePath: string | null, mime: string) =>
    libraryDb()
      .prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, source_path, bytes, sha256, mime, state, created_by, created_at) VALUES (?, ?, 1, ?, ?, 1, ?, ?, 'ready', 'mem-a', 0)")
      .run(id, asset, key, sourcePath, `sha-${id}`, mime);
  add("ver_1", "ast_1", "libraries/lib_a/v/ver_1/source", null, "video/quicktime");
  add("ver_2", "ast_2", "libraries/lib_a/v/ver_2/source", null, "video/quicktime");
  add("ver_3", "ast_3", "libraries/lib_a/v/ver_3/source", "/Users/tiny/Footage/Watched.mov", "video/quicktime");
  add("ver_4", "ast_4", "libraries/lib_s3/v/ver_4/source", null, "video/mp4");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("AI Editor export", () => {
  it("writes exact frame times: 1001-based for 29.97 and 59.94, whole for 25", () => {
    expect(frameDuration(29.97)).toEqual([1001, 30000]);
    expect(frameDuration(59.94)).toEqual([1001, 60000]);
    expect(frameDuration(23.976)).toEqual([1001, 24000]);
    expect(frameDuration(25)).toEqual([1, 25]);
    expect(time(30, 29.97)).toBe("1001/1000s");
    expect(time(50, 25)).toBe("2s");
    expect(time(0, 25)).toBe("0s");
  });

  it("OTIO of a two-cut timeline matches the golden file: source ranges with timecode, markers, links, transform", () => {
    matchGolden("two-cuts.otio", `${JSON.stringify(toOtio(twoCuts(), files), null, 2)}\n`);
  });

  it("FCPXML of a two-cut timeline matches the golden file", () => {
    matchGolden("two-cuts.fcpxml", toFcpxml(twoCuts(), files));
  });

  it("links a local library's files into the edit's media folder under unique names; a watched file stays where it is", async () => {
    for (const v of ["ver_1", "ver_2"]) {
      const f = path.join(dir, `${v}.bin`);
      writeFileSync(f, v);
      await blobs.put(`libraries/lib_a/v/${v}/source`, f);
    }
    expect(namesOf([{ id: "a", title: "Take/A", source_path: null, mime: "video/mp4" }, { id: "b", title: "take/a", source_path: null, mime: "video/mp4" }])).toEqual({
      a: "Take A.mp4",
      b: "take a 2.mp4",
    });
    // a title that would name the folder itself or its parent, with no known extension, is never "." or ".."
    expect(namesOf([{ id: "a", title: " ..", source_path: null, mime: "video/x-unknown" }, { id: "b", title: ". .", source_path: null, mime: null }])).toEqual({
      a: "Untitled",
      b: "Untitled 2",
    });
    const e = (await createEdit("mem-a", { sources: ["ver_1", "ver_2", "ver_3"] }))!;
    const m = await mediaPaths(e, ["ver_1", "ver_2", "ver_3"]);
    const media = path.join(editDir(e.id), "media");
    expect(m.files).toEqual({ ver_1: path.join(media, "Take A.mov"), ver_2: path.join(media, "Take A 2.mov"), ver_3: "/Users/tiny/Footage/Watched.mov" });
    expect(statSync(m.files.ver_1!).ino).toBe(statSync(await blobs.localCopy("libraries/lib_a/v/ver_1/source")).ino); // a hard link, no copy
    expect(m.downloads).toEqual([]);
    expect((await mediaPaths(e, ["ver_1"])).files.ver_1).toBe(m.files.ver_1); // again: the same name, replaced in place
  });

  it("a bucket library's files are relative media/ paths with a download link; the zip holds both timelines and the list", async () => {
    const e = (await createEdit("mem-a", { name: "Bucket edit", sources: ["ver_4"] }))!;
    const m = await mediaPaths(e, ["ver_4"]);
    expect(m.files).toEqual({ ver_4: "media/Take A.mp4" });
    expect(m.downloads).toHaveLength(1);
    expect(m.downloads[0]!.url).toMatch(/^http:\/\/127\.0\.0\.1:9\/tiny\/libraries\/lib_s3\/v\/ver_4\/source\?.*X-Amz-Signature=/);

    const tl = twoCuts();
    tl.sources = { ver_4: { ...tl.sources.ver_a!, versionId: "ver_4" } };
    for (const t of ["V1", "A1"] as const) tl.tracks[t].items = tl.tracks[t].items.map((i) => ({ ...i, src: "ver_4" }));
    await saveDraft(e.id, "v1", { timeline: tl, notes: [] });
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "mem-a", password: "password1" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const get = (q: string) => app.request(`/api/editor/${e.id}/drafts/v1/export${q}`, { headers: { cookie } });

    const otio = await get("?format=otio");
    expect(otio.headers.get("content-disposition")).toBe('attachment; filename="Bucket edit v1.otio"');
    expect(JSON.stringify(await otio.json())).toContain('"target_url":"media/Take A.mp4"');
    expect(await (await get("?format=fcpxml")).text()).toContain('src="media/Take%20A.mp4"');
    expect((await get("?format=edl")).status).toBe(400);
    const zip = Buffer.from(await (await get("")).arrayBuffer());
    const text = zip.toString("latin1");
    for (const f of ["Bucket edit v1/Bucket edit v1.otio", "Bucket edit v1/Bucket edit v1.fcpxml", "Bucket edit v1/media/Download media.txt"]) expect(text).toContain(f);
  });
});
