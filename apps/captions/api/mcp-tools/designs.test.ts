import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "design-tools-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = "design-tools-secret";

const { createUser, newApiKey } = await import("../users");
const app = (await import("../boot")).default;
const { mintJobToken } = await import("../auth");
const { ffmpegCommand } = await import("../ffmpeg-runtime");
const { blobs, libraryDb } = await import("../library/db");
const { setOff } = await import("../users");

const ana = createUser("ana", "password1");
const nico = createUser("nico", "password1");
const anaKey = `Bearer ${newApiKey(ana, "full")}`;
const nicoKey = `Bearer ${newApiKey(nico, "full")}`;

type Layer = { id: string; type: string; text?: string; size?: number; fill?: string };
type Frame = { id: string; n: number; name?: string; w: number; h: number; words?: string; background: string; layers: Layer[] };
/** What design_make and design_update answer. */
type Made = { id: string; name: string; link: string; frames: number; existed?: true; left_out?: string[]; no_pictures?: string; picture_added?: string; changed?: Array<{ frame: string; n: number; new?: true; layers: string[] }> };
/** What design_get answers for one design. */
type Read = { id: string; link: string; how: string; fonts: string[]; no_pictures?: string; frames: Frame[]; pictures: Array<{ id: string; what: string }> };

/** One tool call through POST /api/mcp: as an AI key from outside the app makes it, or with any other authorization. */
const tool = async <T = Made>(authorization: string, name: string, args: Record<string, unknown> = {}) => {
  const r = (await (await app.request("/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()) as {
    result: { content: Array<{ type: string; text: string }>; isError?: boolean };
  };
  const text = r.result.content[0]!.text;
  return { error: !!r.result.isError, text, out: (text.startsWith("{") ? JSON.parse(text) : {}) as T };
};

const SESSION = "eeeeeeee-0000-4000-8000-0000000000b1";
const DOC = "eeeeeeee-0000-4000-8000-0000000000b2";
const slides = ["Roll the mat out\n\nOn a soft floor, with you next to it.", "Try it today"];
const dir = path.join(dataDir, "workshop", "sessions", SESSION);
mkdirSync(path.join(dir, "docs"), { recursive: true });
writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id: SESSION, owner: "ana", title: "Floor time", query: "", sources: [], drafts: [], createdAt: 1, updatedAt: 1 }));
writeFileSync(
  path.join(dir, "docs", `${DOC}.json`),
  JSON.stringify({ id: DOC, sessionId: SESSION, kind: "carousel", title: "Tiny Acrobatics floor time", frameworkIds: [], versions: [], nextBlock: 9, nextVersion: 1, createdAt: 1, updatedAt: 1, blocks: slides.map((text, k) => ({ id: `b${k + 1}`, text, author: "user", at: 1 })) }),
);

// a video of ana's in the library, for a cover
beforeAll(async () => {
  const video = path.join(dataDir, "Tiny Acrobatics take.mp4");
  execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=360x640:rate=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
  libraryDb().exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'ana', 'A', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_t', 'lib_a', 'video', 'Tiny Acrobatics take', 'ana', 0);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('ver_t', 'ast_t', 1, 'libraries/lib_a/v/ver_t/source', 1, 'sha-t', 'ready', 'ana', 0);
  `);
  await blobs.put("libraries/lib_a/v/ver_t/source", video);
}, 60_000);

const text = { type: "text", font: "Bebas Neue", size: 150, color: "#111111", align: "left", x: 90, y: 500, w: 900, h: 400 };

describe("the Designer's tools", () => {
  it("an AI starts a piece's design, reads how to design it, designs a frame, changes one layer, and finds the design again", async () => {
    const made = await tool(anaKey, "design_make", { session: SESSION, doc: DOC });
    expect(made.error).toBe(false);
    expect(made.out).toMatchObject({ name: "Tiny Acrobatics floor time", frames: 2 });
    expect(made.out.link).toMatch(new RegExp(`/design/${made.out.id}$`));
    expect(made.out).not.toHaveProperty("existed");

    const read = (await tool<Read>(anaKey, "design_get", { id: made.out.id })).out;
    expect(read.frames.map((f) => [f.id, f.n, f.w, f.h, f.words])).toEqual([["p1", 1, 1080, 1350, slides[0]], ["p2", 2, 1080, 1350, slides[1]]]);
    expect(read.how).toContain('{"type":"drawing"');
    expect(read.how).toContain('"changes"');
    expect(read.fonts).toContain("Bebas Neue");
    expect(read.link).toBe(made.out.link);
    // a test has no browser to draw the frames with: the answer says so, in place of the pictures
    expect(read.no_pictures).toContain("No pictures");
    expect(read).not.toHaveProperty("_images");

    const wrote = await tool(anaKey, "design_update", {
      id: made.out.id,
      frames: [{ id: "p2", background: "#ffd400", layers: [{ type: "drawing", id: "dot", svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#111111"/></svg>', x: 760, y: 90, w: 230, h: 230 }, { ...text, id: "title", text: "Try it today" }, { ...text, y: 1000, text: "Link in bio" }] }],
    });
    expect(wrote.error).toBe(false);
    expect(wrote.out).toMatchObject({ id: made.out.id, frames: 2, changed: [{ frame: "p2", n: 2, layers: ["dot", "title"] }], left_out: ["Frame 2: “Link in bio” is not in its own words: left out"] });

    const patched = await tool(anaKey, "design_update", { id: made.out.id, changes: [{ frame: "p2", layer: "title", set: { size: 220 } }, { frame: "p2", layer: "dot", remove: true }] });
    expect(patched.out.changed).toEqual([{ frame: "p2", n: 2, layers: ["title"] }]);
    const after = (await tool<Read>(anaKey, "design_get", { id: made.out.id })).out;
    expect(after.frames[1]).toMatchObject({ background: "#ffd400", layers: [{ id: "title", type: "text", text: "Try it today", size: 220 }] });

    // the piece has its design: asking again hands that one back; and the list has it
    expect((await tool(anaKey, "design_make", { session: SESSION, doc: DOC })).out).toMatchObject({ id: made.out.id, existed: true, frames: 2 });
    const list = (await tool<{ designs: Array<{ id: string; name: string; frames: number; from?: string; link: string }> }>(anaKey, "design_get")).out.designs;
    expect(list).toContainEqual(expect.objectContaining({ id: made.out.id, name: "Tiny Acrobatics floor time", frames: 2, from: "a Workshop carousel" }));
  });

  it("blank frames to design from nothing, a second frame of another size beside them, and a cover from a library video's frame", async () => {
    const made = await tool(anaKey, "design_make", { format: "square", name: "Launch post" });
    expect(made.out).toMatchObject({ name: "Launch post", frames: 1 });
    const circle = { type: "shape", shape: "ellipse", fill: "#ff5500", x: 240, y: 240, w: 600, h: 600 };
    const wrote = await tool(anaKey, "design_update", { id: made.out.id, frames: [{ id: "p1", background: "#111111", layers: [circle] }, { name: "Thumbnail", w: 1280, h: 720, layers: [circle, { ...text, text: "New words" }] }] });
    // a frame given whole names all its layers; the new one is said to be new, with its id
    expect(wrote.out).toMatchObject({ frames: 2, changed: [{ frame: "p1", n: 1, layers: ["l1"] }, { n: 2, new: true, layers: ["l1", "l2"] }] });
    expect(wrote.out.changed![0]).not.toHaveProperty("new");
    expect(wrote.out).not.toHaveProperty("left_out");
    // a moment of a library video into this design: its id comes back, for an image layer. Laid under the other
    // layers, those keep their ids, and the answer names only the layers this call wrote
    const thumb = wrote.out.changed![1]!.frame;
    const picture = (await tool(anaKey, "design_update", { id: made.out.id, picture: { version: "ver_t", t: 1 } })).out.picture_added!;
    expect(picture).toMatch(/^[0-9a-f]{8}\.jpg$/);
    const placed = await tool(anaKey, "design_update", { id: made.out.id, changes: [{ frame: thumb, add: { type: "image", picture, fit: "cover", x: 0, y: 0, w: 1280, h: 720 }, at: "back" }, { frame: thumb, layer: "l2", set: { color: "#ffee00" } }] });
    expect(placed.out.changed).toEqual([{ frame: thumb, n: 2, layers: ["l3", "l2"] }]);
    expect(placed.out).not.toHaveProperty("left_out");
    expect((await tool<Read>(anaKey, "design_get", { id: made.out.id })).out.frames[1]!.layers).toMatchObject([{ id: "l3", type: "image", picture }, { id: "l1", type: "shape" }, { id: "l2", type: "text", color: "#ffee00" }]);
    expect((await tool(anaKey, "design_update", { id: made.out.id, picture: { version: "ver_nope", t: 1 } })).error).toBe(true);
    expect((await tool<Read>(anaKey, "design_get", { id: made.out.id })).out.frames.map((f) => [f.name, f.w, f.h, f.layers.length])).toEqual([[undefined, 1080, 1080, 1], ["Thumbnail", 1280, 720, 3]]);

    const cover = await tool(anaKey, "design_make", { version: "ver_t", t: 1, title: "Floor time", format: "thumbnail" });
    expect(cover.out).toMatchObject({ name: "Floor time", frames: 1 });
    const read = (await tool<Read>(anaKey, "design_get", { id: cover.out.id })).out;
    expect(read.pictures).toMatchObject([{ what: "the video's own frame" }]);
    expect(read.frames[0]).not.toHaveProperty("words");
    expect(read.frames[0]!.layers.map((l) => l.type)).toEqual(["image", "text"]);
    expect((await tool(nicoKey, "design_make", { version: "ver_t", t: 1 })).error).toBe(true);
  });

  it("the assistant in the app has the same three tools, and they are refused for an account whose Designer is switched off", async () => {
    const dock = `Bearer ${mintJobToken("ana", "turn-design")}`;
    const listed = (await (await app.request("/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: dock }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) })).json()) as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.map((t) => t.name).filter((n) => n.startsWith("design_"))).toEqual(["design_get", "design_make", "design_update"]);
    const made = await tool(dock, "design_make", { format: "portrait", name: "From the dock" });
    expect(made.out).toMatchObject({ name: "From the dock", frames: 1 });
    expect((await tool(dock, "design_update", { id: made.out.id, frames: [{ id: "p1", layers: [{ ...text, text: "Hello" }] }] })).out.changed).toMatchObject([{ frame: "p1", layers: ["l1"] }]);
    setOff(nico, ["design"]);
    const off = await tool(nicoKey, "design_get");
    expect(off.error).toBe(true);
    expect(off.text).toContain("isn't switched on");
  });

  it("says in words what it cannot do, and another account's design is not found", async () => {
    expect((await tool(anaKey, "design_make", {})).text).toContain("Say what to design");
    expect((await tool(anaKey, "design_update", {})).text).toContain("Give the design's id");
    const { out } = await tool(anaKey, "design_make", { session: SESSION, doc: DOC });
    const theirs = await tool(nicoKey, "design_get", { id: out.id });
    expect(theirs.error).toBe(true);
    const nothing = await tool(anaKey, "design_update", { id: out.id, frames: [{ id: "p1", layers: [{ ...text, text: "Other words" }] }] });
    expect(nothing.error).toBe(true);
    expect(nothing.text).toContain("is not in its own words");
  });
});
