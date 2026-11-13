import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Design, DesignAnswer, DesignListed, DesignSummary } from "../contracts/design";

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "designs-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = "designs-test-secret";

const { Hono } = await import("hono");
const { designsApp } = await import("./designs");
const { createAnimation, pictureFile } = await import("./editor/animation-styles");
const { change } = await import("./editor/styles");
const { ffmpegCommand } = await import("./ffmpeg-runtime");
const { blobs, libraryDb } = await import("./library/db");
const { CUTOUT_KIND } = await import("../contracts/devices");
const { claimCutout, cutoutFailed, cutoutSent, heldCutout } = await import("./lib/cutouts");
const { pairDevice, setDeviceKinds, touchDevice } = await import("./lib/devices");
const { createUser } = await import("./users");

createUser("jordan", "password1", { role: "user" });
createUser("robin", "password1", { role: "user" });
let as = "jordan";
const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  c.set("user", as === "visitor" ? { username: "visitor", role: "visitor", off: [] } : { username: as, role: "user", cloud: true, off: [] });
  await next();
});
app.route("/api/designs", designsApp as never);
const call = async <T = Record<string, unknown>>(method: string, url: string, body?: unknown, who = "jordan"): Promise<{ status: number; body: T }> => {
  as = who;
  const r = await app.request(url, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as T) : ((await r.arrayBuffer()) as never) };
};

const SESSION = "eeeeeeee-0000-4000-8000-000000000001";
const DOC = "eeeeeeee-0000-4000-8000-000000000002";
const REEL = "eeeeeeee-0000-4000-8000-000000000003";
const slides = ["Roll the mat out\n\nOn a soft floor, with you next to it. ![a mat](pic:abc12345)", "Then the ramp goes down", "Try it today"];
const ws = (...p: string[]) => path.join(dataDir, "workshop", ...p);
const piece = (id: string, kind: string, blocks: string[]) =>
  writeFileSync(ws("sessions", SESSION, "docs", `${id}.json`), JSON.stringify({ id, sessionId: SESSION, kind, title: "Tiny Acrobatics floor time", frameworkIds: [], versions: [], nextBlock: 9, nextVersion: 1, createdAt: 1, updatedAt: 1, blocks: blocks.map((text, k) => ({ id: `b${k + 1}`, text, author: "user", at: 1 })) }));
const video = path.join(dataDir, "Tiny Acrobatics take.mp4");

beforeAll(async () => {
  mkdirSync(ws("sessions", SESSION, "docs"), { recursive: true });
  writeFileSync(ws("sessions", SESSION, "meta.json"), JSON.stringify({ id: SESSION, owner: "jordan", title: "Floor time", query: "", sources: [], drafts: [], createdAt: 1, updatedAt: 1 }));
  piece(DOC, "carousel", slides);
  piece(REEL, "reel", ["A reel"]);
  execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=360x640:rate=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
  libraryDb().exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_j', 'jordan', 'J', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_v', 'lib_j', 'video', 'Tiny Acrobatics take', 'jordan', 0);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('ver_v', 'ast_v', 1, 'libraries/lib_j/v/ver_v/source', 1, 'sha-v', 'ready', 'jordan', 0);
  `);
  const copy = path.join(dataDir, "copy.mp4");
  execFileSync("cp", [video, copy]);
  await blobs.put("libraries/lib_j/v/ver_v/source", copy);
}, 60_000);
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const fromPiece = async () => (await call<Design>("POST", "/api/designs", { format: "portrait", session: SESSION, doc: DOC })).body;

describe("designs: made from a carousel piece", () => {
  it("starts with a page a slide, the slide's own words laid out plainly, in the size picked", async () => {
    const d = await fromPiece();
    expect(d).toMatchObject({ owner: "jordan", name: "Tiny Acrobatics floor time", kind: "carousel", format: "portrait", width: 1080, height: 1350, from: { session: SESSION, doc: DOC }, pictures: [] });
    expect(d.pages.map((p) => p.layers.map((l) => l.type === "text" && l.text))).toEqual([["Roll the mat out", "On a soft floor, with you next to it."], ["Then the ramp goes down"], ["Try it today"]]);
    expect((await call<DesignSummary[]>("GET", `/api/designs?session=${SESSION}&doc=${DOC}`)).body.map((x) => [x.id, x.pages])).toContainEqual([d.id, 3]);
    expect((await call<DesignSummary[]>("GET", `/api/designs?session=${SESSION}&doc=${REEL}`)).body).toEqual([]);
  });

  it("refuses what it cannot design from, in words; another account's piece and design are not found", async () => {
    expect(await call("POST", "/api/designs", { format: "portrait", session: SESSION, doc: REEL })).toEqual({ status: 400, body: { error: "Only a carousel piece has slides to design" } });
    expect(await call("POST", "/api/designs", { format: "cover", session: SESSION, doc: DOC })).toEqual({ status: 400, body: { error: "A carousel's slides take a carousel size" } });
    expect((await call("POST", "/api/designs", { format: "poster", session: SESSION, doc: DOC })).body).toEqual({ error: "Pick one of the picture sizes" });
    expect((await call("POST", "/api/designs", { format: "portrait" })).status).toBe(400);
    expect((await call("POST", "/api/designs", { format: "portrait", session: SESSION, doc: DOC }, "robin")).status).toBe(404);
    const d = await fromPiece();
    for (const [m, u] of [["GET", ""], ["PUT", ""], ["DELETE", ""], ["GET", "/pages"], ["POST", "/pages"], ["GET", "/look"], ["POST", "/pictures"]] as const) expect((await call(m, `/api/designs/${d.id}${u}`, m === "GET" || m === "DELETE" ? undefined : {}, "robin")).status, `${m} ${u}`).toBe(404);
    expect((await call("GET", "/api/designs", undefined, "visitor")).status).toBe(403);
    expect((await call<DesignSummary[]>("GET", "/api/designs", undefined, "robin")).body).toEqual([]);
  });

  it("saves what the person changes by hand, checked for what a page holds and never for whose words they are", async () => {
    const d = await fromPiece();
    const first = d.pages[0]!;
    const { status, body } = await call<Design>("PUT", `/api/designs/${d.id}`, { name: "  Floor time, bold  ", pages: [{ ...first, background: "#FFE08A", layers: [{ ...first.layers[0], x: -20, text: "My own new words", size: 9999 }, { type: "shape", shape: "rect", x: 0, y: 1200, w: 1080, h: 150, fill: "#111111" }, { type: "video" }] }] });
    expect(status).toBe(200);
    expect(body.name).toBe("Floor time, bold");
    expect(body.pages).toHaveLength(1);
    expect(body.pages[0]).toMatchObject({ id: "p1", background: "#ffe08a" });
    expect(body.pages[0]!.layers).toMatchObject([{ id: "l1", type: "text", text: "My own new words", x: -20, size: 600 }, { type: "shape", fill: "#111111" }]);
    // frames sent of which none can be kept save nothing over what is there
    expect((await call("PUT", `/api/designs/${d.id}`, { pages: ["not a frame", 7] })).body).toEqual({ error: "None of the frames sent could be kept" });
    // and a save that sends no list of frames changes none of them
    expect((await call<Design>("PUT", `/api/designs/${d.id}`, { pages: "none" })).body.pages).toHaveLength(1);
    expect((await call<Design>("GET", `/api/designs/${d.id}`)).body.pages[0]!.background).toBe("#ffe08a");
    // every frame deleted by hand: the piece's design is an empty canvas, and a later save does not bring its slides' frames back
    expect((await call<Design>("PUT", `/api/designs/${d.id}`, { pages: [] })).body.pages).toEqual([]);
    expect((await call<Design>("PUT", `/api/designs/${d.id}`, { name: "Emptied" })).body).toMatchObject({ name: "Emptied", pages: [] });
    expect((await call<Design>("GET", `/api/designs/${d.id}`)).body.pages).toEqual([]);
  });

  it("takes a picture into its own folder and serves it back; a layer may then show it, and only it", async () => {
    const d = await fromPiece();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    expect((await call("POST", `/api/designs/${d.id}/pictures`, { name: "x.txt", type: "image/png", data: Buffer.from("not a picture").toString("base64") })).body).toEqual({ error: "That file is not a picture" });
    const { body } = await call<{ id: string }>("POST", `/api/designs/${d.id}/pictures`, { name: "dot.png", type: "image/png", data: png.toString("base64") });
    expect(body.id).toMatch(/^[a-z0-9]{8}\.png$/);
    as = "jordan";
    const got = await app.request(`/api/designs/${d.id}/pictures/${body.id}`);
    expect([got.status, got.headers.get("content-type")]).toEqual([200, "image/png"]);
    expect(Buffer.from(await got.arrayBuffer()).equals(png)).toBe(true);
    expect((await call("GET", `/api/designs/${d.id}/pictures/${body.id}`, undefined, "robin")).status).toBe(404);
    expect((await call("GET", `/api/designs/${d.id}/pictures/..%2F..%2Fx.png`)).status).toBe(404);
    const saved = (await call<Design>("PUT", `/api/designs/${d.id}`, { pages: [{ layers: [{ type: "image", picture: body.id, x: 0, y: 0, w: 1080, h: 1350, fit: "cover" }, { type: "image", picture: "ffffffff.png", x: 0, y: 0, w: 10, h: 10 }] }] })).body;
    expect(saved.pages[0]!.layers).toMatchObject([{ type: "image", picture: body.id }]);
    // deleted: the file and the folder go
    expect((await call("DELETE", `/api/designs/${d.id}`)).body).toEqual({ ok: true });
    expect(existsSync(path.join(dataDir, "designs", "jordan", d.id))).toBe(false);
    expect((await call("GET", `/api/designs/${d.id}`)).status).toBe(404);
  });
});

describe("designs: a cover or a thumbnail from a video's moment", () => {
  it("copies that frame in as the design's own picture, fills the page with it and puts the title over it", async () => {
    const { status, body: d } = await call<Design>("POST", "/api/designs", { format: "cover", version: "ver_v", t: 1, title: "Floor time" });
    expect(status).toBe(200);
    expect(d).toMatchObject({ kind: "cover", width: 1080, height: 1920, name: "Floor time", from: { version: "ver_v", t: 1 } });
    expect(d.pictures).toHaveLength(1);
    expect(d.pages[0]!.layers).toMatchObject([{ type: "image", picture: d.pictures[0], fit: "cover", w: 1080, h: 1920 }, { type: "text", text: "Floor time" }]);
    as = "jordan";
    const frame = Buffer.from(await (await app.request(`/api/designs/${d.id}/pictures/${d.pictures[0]}`)).arrayBuffer());
    expect([frame[0], frame[1], frame[2]]).toEqual([0xff, 0xd8, 0xff]);
    // no title: named after the video; a thumbnail is 1280 × 720
    const thumb = (await call<Design>("POST", "/api/designs", { format: "thumbnail", version: "ver_v", t: 0.5 })).body;
    expect(thumb).toMatchObject({ kind: "thumbnail", width: 1280, height: 720, name: "Tiny Acrobatics take" });
    expect(thumb.pages[0]!.layers).toHaveLength(1);
  }, 60_000);

  it("refuses a carousel size for a video, a video the account cannot read, and a moment that is not a time", async () => {
    expect((await call("POST", "/api/designs", { format: "portrait", version: "ver_v", t: 1 })).body).toEqual({ error: "A video's frame takes the cover or the thumbnail size" });
    expect((await call("POST", "/api/designs", { format: "cover", version: "ver_v", t: 1 }, "robin")).status).toBe(404);
    expect((await call("POST", "/api/designs", { format: "cover", version: "ver_nope", t: 1 })).status).toBe(404);
    expect((await call("POST", "/api/designs", { format: "cover", version: "ver_v", t: -3 })).status).toBe(400);
  });
});

describe("designs: frames on a canvas", () => {
  const place = (d: Design) => d.pages.map((p) => [p.x, p.y, p.w, p.h]);

  it("gives every frame a place, a size and its slide: a new design's in a row; one saved before frames had them the same, once it is read", async () => {
    const d = await fromPiece();
    expect(place(d)).toEqual([[0, 0, 1080, 1350], [1200, 0, 1080, 1350], [2400, 0, 1080, 1350]]);
    expect(d.pages.map((p) => p.block)).toEqual(["b1", "b2", "b3"]);
    // a design as the launched build saved it: no places, no sizes, no slides
    const old = "eeeeeeee-0000-4000-8000-0000000000f1";
    writeFileSync(path.join(dataDir, "designs", "jordan", `${old}.json`), JSON.stringify({ ...d, id: old, pages: d.pages.map((p) => ({ id: p.id, background: p.background, layers: p.layers })) }));
    const read = (await call<Design>("GET", `/api/designs/${old}`)).body;
    expect(place(read)).toEqual(place(d));
    expect(read.pages.map((p) => p.layers)).toEqual(d.pages.map((p) => p.layers));
    // a save from a window that knows nothing of places (it sends none), with the frames in another order: each frame
    // is where it was read, and its slide is the one it drew, by the order the design was in
    const saved = (await call<Design>("PUT", `/api/designs/${old}`, { pages: [read.pages[1], read.pages[0], read.pages[2]].map((p) => ({ id: p!.id, background: p!.background, layers: p!.layers })) })).body;
    expect(saved.pages.map((p) => [p.id, p.x])).toEqual([["p2", 1200], ["p1", 0], ["p3", 2400]]);
    expect((await call<Design>("GET", `/api/designs/${old}`)).body.pages.map((p) => [p.id, p.block])).toEqual([["p2", "b2"], ["p1", "b1"], ["p3", "b3"]]);
  });

  it("keeps a frame where the person put it and the size they gave it, holds its layers to that size, and puts a new frame beside the rightmost", async () => {
    const d = await fromPiece();
    const shape = { type: "shape", shape: "rect", fill: "#ff0000", x: 9000, y: 10, w: 100, h: 100 };
    const moved = (await call<Design>("PUT", `/api/designs/${d.id}`, { pages: [d.pages[0], { ...d.pages[1], x: 300.4, y: 1500, w: 1280, h: 720, layers: [shape] }, d.pages[2], { id: "thumb", name: "Thumbnail", w: 640, h: 360, background: "#000000", layers: [] }] })).body;
    expect(place(moved)).toEqual([[0, 0, 1080, 1350], [300, 1500, 1280, 720], [2400, 0, 1080, 1350], [3600, 0, 640, 360]]);
    expect(moved.pages[1]!.layers[0]).toMatchObject({ x: 2560 });
    expect(moved.pages[3]).toMatchObject({ id: "thumb", name: "Thumbnail" });
    expect(moved.pages.map((p) => p.block)).toEqual(["b1", "b2", "b3", undefined]);
    // a size out of range is brought inside
    const sized = (await call<Design>("PUT", `/api/designs/${d.id}`, { pages: [{ ...moved.pages[0], w: 5, h: 99999 }] })).body;
    expect([sized.pages[0]!.w, sized.pages[0]!.h]).toEqual([16, 4096]);
  });
});

describe("designs: an AI that designs", () => {
  type Frame = { id: string; n: number; name?: string; w: number; h: number; words?: string; background: string; layers: Array<{ id: string; type: string; text?: string; x: number; size?: number }> };
  type Read = { id: string; fonts: string[]; how: string; looks: Array<{ name: string; brief?: string; pictures: number }>; look?: { name: string; pictures: Array<{ what: string; jpeg: string }> } | string; pictures: Array<{ id: string; what: string }>; frames: Frame[] };
  type Wrote = DesignAnswer & { touched: string[] };
  const text = { type: "text", font: "Anton", size: 90, color: "#ffffff", align: "center", x: 90, y: 400, w: 900, h: 300 };
  const read = async (id: string, more = "") => (await call<Read>("GET", `/api/designs/${id}/pages${more}`)).body;
  const write = (id: string, body: unknown) => call<Wrote>("POST", `/api/designs/${id}/pages`, body);

  it("reads every frame with its id, size, words and layers, and how a design is changed", async () => {
    const d = await fromPiece();
    const got = await read(d.id);
    expect(got.frames.map((f) => [f.id, f.n, f.w, f.h, f.words])).toEqual([
      ["p1", 1, 1080, 1350, "Roll the mat out\n\nOn a soft floor, with you next to it."],
      ["p2", 2, 1080, 1350, "Then the ramp goes down"],
      ["p3", 3, 1080, 1350, "Try it today"],
    ]);
    expect(got.frames[0]!.layers).toEqual(d.pages[0]!.layers);
    expect(got.fonts).toContain("DM Serif Display");
    for (const part of ['{"type":"text"', "never add, drop or change one", '"frames": [{"id"', '"changes"', "Without an \"id\" it is a new frame"]) expect(got.how).toContain(part);
    expect((await call("GET", `/api/designs/${d.id}/pages`, undefined, "robin")).status).toBe(404);
  });

  it("replaces the frames it names, by id: a slide's words stay the slide's, the rest is as it was", async () => {
    const d = await fromPiece();
    const out = await write(d.id, {
      frames: [
        { id: "p2", background: "#102030", layers: [{ type: "shape", shape: "ellipse", fill: "#ff6600", x: 700, y: 80, w: 300, h: 300 }, { ...text, text: "Then the ramp goes down" }, { ...text, y: 800, text: "Buy the course" }] },
        { id: "nope", layers: [{ ...text, text: "Try it today" }] },
        { id: "p3", background: "#333333" },
      ],
    });
    expect(out.status).toBe(200);
    expect(out.body.notes).toEqual(["There is no frame nope: this design's are p1, p2, p3", "Frame 2: “Buy the course” is not in its own words: left out"]);
    expect(out.body.touched).toEqual(["p2", "p3"]);
    const [one, two, three] = out.body.design.pages;
    expect(two).toMatchObject({ id: "p2", background: "#102030", x: 1200, block: "b2" });
    expect(two!.layers.map((l) => l.type)).toEqual(["shape", "text"]);
    // a frame given without layers changes only what was given; one not named is untouched
    expect(three).toEqual({ ...d.pages[2], background: "#333333" });
    expect(one).toEqual(d.pages[0]);
    // nothing that can be drawn: refused in words the AI can act on, and nothing is saved
    const none = await write(d.id, { frames: [{ id: "p1", layers: [{ ...text, text: "Something else" }] }] });
    expect(none.status).toBe(400);
    expect((none.body as unknown as { error: string }).error).toContain("“Something else” is not in its own words");
    expect((await write(d.id, {})).status).toBe(400);
    expect((await call<Design>("GET", `/api/designs/${d.id}`)).body.pages).toEqual(out.body.design.pages);
    expect((await call("POST", `/api/designs/${d.id}/pages`, { frames: [{ id: "p1", layers: [] }] }, "robin")).status).toBe(404);
    // a frame's gradient: given, it is the frame's and the AI reads it back; a later change that says nothing of it keeps it; null takes it off
    await write(d.id, { frames: [{ id: "p3", gradient: { to: "#ff8800", angle: 45 } }] });
    await write(d.id, { frames: [{ id: "p3", background: "#222222" }] });
    const again = (await call<{ frames: Array<{ id: string; background: string; gradient?: object }> }>("GET", `/api/designs/${d.id}/pages`)).body.frames[2]!;
    expect(again).toMatchObject({ id: "p3", background: "#222222", gradient: { to: "#ff8800", angle: 45 } });
    expect((await write(d.id, { frames: [{ id: "p3", gradient: null }] })).body.design.pages[2]).not.toHaveProperty("gradient");
  });

  it("changes one layer at a time: set, remove, reorder and add, each checked like a whole frame", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const circle = { type: "shape", shape: "ellipse", fill: "#ff5500", x: 240, y: 240, w: 600, h: 600 };
    const start = (await write(d.id, { frames: [{ id: "p1", layers: [{ ...circle, id: "sun" }, { ...text, id: "title", text: "Hello" }] }] })).body.design.pages[0]!;
    expect(start.layers.map((l) => l.id)).toEqual(["sun", "title"]);
    const out = (await write(d.id, {
      changes: [
        { frame: "p1", layer: "title", set: { size: 9999, text: "Hello there", x: 10 } },
        { frame: "p1", layer: "sun", order: "front" },
        { frame: "p1", add: { ...circle, id: "moon", fill: "#222222" }, at: "back" },
        { frame: "p1", layer: "ghost", remove: true },
        { frame: "p9", layer: "title", remove: true },
      ],
    })).body;
    expect(out.design.pages[0]!.layers.map((l) => l.id)).toEqual(["moon", "title", "sun"]);
    expect(out.design.pages[0]!.layers[1]).toMatchObject({ type: "text", text: "Hello there", size: 600, x: 10, font: "Anton" });
    expect(out.notes).toEqual(["Frame 1 has no layer ghost", "A change names no frame of this design (p9): its frames are p1"]);
    const gone = (await write(d.id, { changes: [{ frame: "p1", layer: "moon", remove: true }] })).body;
    expect(gone.design.pages[0]!.layers.map((l) => l.id)).toEqual(["title", "sun"]);
    // a field that is a set of fields takes the ones given and keeps the rest; null takes it off whole
    await write(d.id, { changes: [{ frame: "p1", layer: "sun", set: { shadow: { color: "#102030", opacity: 0.5, blur: 10, x: 1, y: 2 }, gradient: { to: "#00ff00", angle: 30 } } }] });
    const part = (await write(d.id, { changes: [{ frame: "p1", layer: "sun", set: { shadow: { blur: 40 }, gradient: null } }] })).body.design.pages[0]!.layers[1]!;
    expect(part.shadow).toEqual({ color: "#102030", opacity: 0.5, blur: 40, x: 1, y: 2 });
    expect(part).not.toHaveProperty("gradient");
    // on a slide's frame a change may not put other words on it
    const piece = await fromPiece();
    const held = (await write(piece.id, { changes: [{ frame: "p3", layer: "l1", set: { text: "Buy now" } }, { frame: "p3", add: { ...text, text: "Try it today" } }] })).body;
    expect(held.design.pages[2]!.layers.map((l) => l.type === "text" && l.text)).toEqual(["Try it today"]);
    expect(held.notes).toEqual(["Frame 3: “Buy now” is not in its own words: left out"]);
  });

  it("an empty canvas: started with no frame, emptied by deleting the last one, and given its first frame by hand or by an AI", async () => {
    const { status, body: d } = await call<Design>("POST", "/api/designs", { format: "portrait", blank: true, pages: 0, name: "Untitled canvas" });
    expect(status).toBe(200);
    expect(d).toMatchObject({ name: "Untitled canvas", width: 1080, height: 1350, pages: [] });
    expect((await call<DesignSummary[]>("GET", "/api/designs")).body.find((x) => x.id === d.id)).toMatchObject({ pages: 0 });
    // read by an AI: no frames, and how a design is changed
    const empty = await read(d.id);
    expect(empty.frames).toEqual([]);
    expect(empty.how).toContain("A design is a canvas of frames");
    // its first frame by hand, where the person put it
    const one = (await call<Design>("PUT", `/api/designs/${d.id}`, { pages: [{ id: "pa", x: 300, y: -200, w: 1080, h: 1080, background: "#ffffff", layers: [] }] })).body;
    expect(one.pages).toEqual([{ id: "pa", x: 300, y: -200, w: 1080, h: 1080, background: "#ffffff", layers: [] }]);
    // the last frame deleted: an empty canvas again
    const none = await call<Design>("PUT", `/api/designs/${d.id}`, { pages: [] });
    expect(none.status).toBe(200);
    expect(none.body.pages).toEqual([]);
    // an AI gives it its first frame
    const out = (await write(d.id, { frames: [{ name: "Cover", w: 1080, h: 1920, background: "#111111", layers: [{ ...text, text: "FLOOR TIME" }] }] })).body;
    expect(out.design.pages).toHaveLength(1);
    expect(out.design.pages[0]).toMatchObject({ name: "Cover", x: 0, y: 0, w: 1080, h: 1920, layers: [{ type: "text", text: "FLOOR TIME" }] });
  });

  it("adds a frame of any size beside the rightmost, free to say what was asked for; never more than a design holds", async () => {
    const d = await fromPiece();
    const out = (await write(d.id, { frames: [{ name: "Thumbnail", w: 1280, h: 720, background: "#111111", layers: [{ ...text, text: "3 MISTAKES", w: 1100 }] }] })).body;
    expect(out.design.pages).toHaveLength(4);
    expect(out.design.pages[3]).toMatchObject({ name: "Thumbnail", x: 3600, y: 0, w: 1280, h: 720, layers: [{ type: "text", text: "3 MISTAKES" }] });
    expect(out.design.pages[3]).not.toHaveProperty("block");
    expect(out.touched).toEqual([out.design.pages[3]!.id]);
    expect((await read(d.id)).frames[3]).not.toHaveProperty("words");
    const blank = (await call<Design>("POST", "/api/designs", { format: "cover", blank: true, pages: 20 })).body;
    const full = await write(blank.id, { frames: [{ w: 100, h: 100, layers: [] }] });
    expect(full.status).toBe(400);
    expect((full.body as unknown as { error: string }).error).toContain("holds at most 20 frames");
  });

  it("a frame is its slide's wherever it is moved: reordered frames keep their words, a slide written since gets a frame, and a frame the person moved stays put", async () => {
    const d = await fromPiece();
    const [a, b, c] = d.pages;
    await call("PUT", `/api/designs/${d.id}`, { pages: [c, { ...a, x: 5000, y: 700 }, b] });
    expect((await read(d.id)).frames.map((f) => [f.id, f.words?.slice(0, 8)])).toEqual([["p3", "Try it t"], ["p1", "Roll the"], ["p2", "Then the"]]);
    const out = (await write(d.id, { frames: [{ id: "p1", layers: [{ ...text, text: "Roll the mat out On a soft floor, with you next to it." }] }] })).body;
    expect(out.notes).toEqual([]);
    expect(out.design.pages.map((p) => [p.id, p.x, p.y])).toEqual([["p3", 2400, 0], ["p1", 5000, 700], ["p2", 1200, 0]]);
    piece(DOC, "carousel", [...slides, "One more thing"]);
    try {
      const more = await read(d.id);
      expect(more.frames).toHaveLength(4);
      expect(more.frames[3]).toMatchObject({ n: 4, words: "One more thing", w: 1080, h: 1350 });
      const designed = (await write(d.id, { frames: [{ id: more.frames[3]!.id, background: "#222222", layers: [{ ...text, text: "One more thing" }] }] })).body.design;
      expect(designed.pages).toHaveLength(4);
      expect(designed.pages[3]).toMatchObject({ block: "b4", x: 6200, y: 0, background: "#222222" });
    } finally {
      piece(DOC, "carousel", slides);
    }
  });

  it("a cover's words are what the chat asks for; the person's looks come as their own words, and a look's pictures when it is asked for by name", async () => {
    const style = createAnimation("jordan", { name: "Paper cut", brief: "Torn paper edges, one loud colour." });
    if (typeof style === "string") throw new Error(style);
    // two pictures of the look, written as its own files are
    for (const [id, kind] of [["11111111-0000-4000-8000-000000000001", "made"], ["22222222-0000-4000-8000-000000000002", "inspiration"]] as const) {
      change("jordan", (f) => void f.animation!.find((s) => s.id === style.id)!.pictures.push({ id, kind, at: kind === "made" ? 2 : 1 }));
      const file = pictureFile("jordan", style.id, id)!;
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    const d = (await call<Design>("POST", "/api/designs", { format: "thumbnail", version: "ver_v", t: 1, title: "Floor time" })).body;
    const got = await read(d.id);
    expect(got.frames[0]).not.toHaveProperty("words");
    expect(got.pictures).toEqual([{ id: d.pictures[0], what: "the video's own frame" }]);
    expect(got.looks).toContainEqual({ name: "Paper cut", brief: "Torn paper edges, one loud colour.", pictures: 2 });
    // the person's one look comes with its pictures unasked: an AI that never asks for a look still designs from it
    expect(typeof got.look === "object" && [got.look.name, got.look.pictures.map((p) => p.what)]).toEqual(["Paper cut", ["a picture the user made and liked in this look", "an inspiration for this look"]]);
    expect(got.how).toContain("Design in one of them");
    const withLook = await read(d.id, "?look=paper%20cut");
    expect(typeof withLook.look === "object" && withLook.look.pictures.map((p) => p.what)).toEqual(["a picture the user made and liked in this look", "an inspiration for this look"]);
    expect((await read(d.id, "?look=Nope")).look).toBe("There is no look called Nope");
    const out = (await write(d.id, { frames: [{ id: "p1", layers: [{ type: "image", picture: d.pictures[0], fit: "cover", x: 0, y: 0, w: 1280, h: 720 }, { ...text, text: "3 MISTAKES" }, { type: "image", picture: "ffffffff.png", x: 0, y: 0, w: 10, h: 10 }] }] })).body;
    expect(out.design.pages[0]!.layers).toMatchObject([{ type: "image" }, { type: "text", text: "3 MISTAKES" }]);
    expect(out.notes).toEqual(["Frame 1: a picture that is not in this design: left out"]);
  });

  it("with several looks the AI is told to pick one and read it first; a plug-in's own looks are listed after the account's, their pictures made small", async () => {
    const { Hono } = await import("hono");
    const { definePlugin, mountPlugins } = await import("./lib/plugin");
    // a big picture a plug-in keeps as a file of its own
    const big = path.join(dataDir, "studio-look.png");
    execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0xE9E2D0:s=1600x2400", "-frames:v", "1", big]);
    let asked = "";
    mountPlugins(new Hono(), [
      definePlugin({
        id: "tiny-studio",
        design: {
          looks: (user) => {
            asked = user.username;
            return [
              { name: "Tiny Mobile", brief: "Everything hangs on threads.", pictures: [{ file: path.join(dataDir, "gone.png"), made: false }, { file: big, made: true }] },
              // named like one of the account's own: the account's stands
              { name: "paper cut", brief: "Not this one.", pictures: [] },
            ];
          },
        },
      }),
      definePlugin({ id: "tiny-broken", design: { looks: () => { throw new Error("its store is down"); } } }),
    ]);
    try {
      const d = (await call<Design>("POST", "/api/designs", { format: "portrait", blank: true })).body;
      const got = await read(d.id);
      expect(asked).toBe("jordan");
      expect(got.looks).toEqual([{ name: "Paper cut", brief: "Torn paper edges, one loud colour.", pictures: 2 }, { name: "Tiny Mobile", brief: "Everything hangs on threads.", pictures: 2 }]);
      // two looks with pictures: none is shown unasked, and the answer says to pick one
      expect(got.look).toBe('Pick the look this design is in ("Paper cut", "Tiny Mobile"; ask the user when it is not clear) and read its pictures before you design: design_get with "look": its name.');
      // the plug-in's look by name: the picture it made first, as a small JPEG; the file that is gone is left out
      const tiny = (await read(d.id, "?look=tiny%20mobile")).look;
      if (typeof tiny !== "object") throw new Error(String(tiny));
      expect(tiny.pictures.map((p) => p.what)).toEqual(["a picture the user made and liked in this look"]);
      const jpeg = Buffer.from(tiny.pictures[0]!.jpeg, "base64");
      expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
      // no longer than 768 px on its longest side (the height here): read from the JPEG's own frame header
      const sof = jpeg.findIndex((b, i) => b === 0xff && (jpeg[i + 1] === 0xc0 || jpeg[i + 1] === 0xc2));
      expect([jpeg.readUInt16BE(sof + 5), jpeg.readUInt16BE(sof + 7)]).toEqual([768, 512]);
    } finally {
      mountPlugins(new Hono(), []);
    }
  });

  it("a look at the frames: with no browser to draw them, no pictures and a line saying why; another account's is not found", async () => {
    const d = await fromPiece();
    const look = await call<{ pictures: unknown[]; why?: string }>("GET", `/api/designs/${d.id}/look?frames=p2,p1,nope`);
    expect(look.status).toBe(200);
    expect(look.body.pictures).toEqual([]);
    expect(look.body.why).toContain("No pictures of the pages");
    expect((await call("GET", `/api/designs/${d.id}/look`, undefined, "robin")).status).toBe(404);
  });
});

describe("designs: a picture's background taken away", () => {
  const png = (w: number, h: number, more: string[] = []) => execFileSync(ffmpegCommand(), ["-v", "error", "-f", "lavfi", "-i", `color=c=red:s=${w}x${h}`, "-frames:v", "1", ...more, "-f", "image2pipe", "-c:v", "png", "-"], { maxBuffer: 1 << 28 });
  const upload = async (id: string, bytes: Buffer, type = "image/png") => (await call<{ id: string }>("POST", `/api/designs/${id}/pictures`, { name: "a picture", type, data: bytes.toString("base64") })).body.id;
  /** Jordan's Mac takes the cut-out that waits, looks at what it was sent, and answers `result` (bytes, or why it cannot). */
  const macAnswers = async (mac: { id: string; owner: string }, result: (sent: { picture: Buffer; mime: string }) => Buffer | string) => {
    let job = null as ReturnType<typeof claimCutout>;
    for (let n = 0; n < 200 && !(job = claimCutout(mac, [CUTOUT_KIND])); n++) await new Promise((r) => setTimeout(r, 10));
    const sent = heldCutout(mac.id, job!.id)!;
    const out = result(sent);
    if (typeof out === "string") cutoutFailed(mac.id, job!.id, out);
    else cutoutSent(mac.id, job!.id, out);
    return sent;
  };

  it("says what is missing without a Mac; with one, keeps the cut-out as a new picture of the design and the first picture too", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const first = await upload(d.id, png(64, 48));
    const none = await call<{ error: string }>("POST", `/api/designs/${d.id}/pictures/${first}/cutout`, {});
    expect([none.status, none.body.error]).toEqual([400, "Needs a Mac with Creator Toolset on"]);

    const mac = pairDevice("jordan", "Jordan's Mac").device;
    setDeviceKinds(mac.id, [CUTOUT_KIND]);
    touchDevice(mac.id);
    const cut = png(64, 48, ["-vf", "format=rgba,colorchannelmixer=aa=0.5"]);
    const asked = call<{ id: string }>("POST", `/api/designs/${d.id}/pictures/${first}/cutout`, {});
    const sent = await macAnswers(mac, () => cut);
    expect(sent.mime).toBe("image/png");
    const made = await asked;
    expect(made.status).toBe(200);
    expect(made.body.id).toMatch(/^[0-9a-f]{8}\.png$/);
    const after = (await call<Design>("GET", `/api/designs/${d.id}`)).body;
    expect(after.pictures).toEqual([first, made.body.id]);
    expect(after.updatedAt).toBeGreaterThan(d.updatedAt);
    as = "jordan";
    expect(Buffer.from(await (await app.request(`/api/designs/${d.id}/pictures/${made.body.id}`)).arrayBuffer()).equals(cut)).toBe(true);
    // the layer shows the cut-out and remembers the picture it was cut from
    const saved = (await call<Design>("PUT", `/api/designs/${d.id}`, { pages: [{ ...after.pages[0], layers: [{ type: "image", picture: made.body.id, uncut: first, fit: "cover", x: 0, y: 0, w: 500, h: 500 }] }] })).body;
    expect(saved.pages[0]!.layers[0]).toMatchObject({ picture: made.body.id, uncut: first });

    // the Mac's own words when it cannot, and someone else's design or a picture that is not the design's: not found
    const failing = call<{ error: string }>("POST", `/api/designs/${d.id}/pictures/${first}/cutout`, {});
    await macAnswers(mac, () => "No subject was found in the picture.");
    expect((await failing).body).toEqual({ error: "No subject was found in the picture." });
    expect((await call("POST", `/api/designs/${d.id}/pictures/${first}/cutout`, {}, "robin")).status).toBe(404);
    expect((await call("POST", `/api/designs/${d.id}/pictures/ffffffff.png/cutout`, {})).status).toBe(404);
    expect((await call<Design>("GET", `/api/designs/${d.id}`)).body.pictures).toHaveLength(2);
  }, 60_000);

  it("sends a WebP to the Mac as a PNG, and keeps a cut-out that comes back too heavy at a smaller size", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const webp = execFileSync(ffmpegCommand(), ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x48", "-frames:v", "1", "-f", "webp", "-"]);
    const first = await upload(d.id, webp, "image/webp");
    expect(first).toMatch(/\.webp$/);
    const mac = pairDevice("jordan", "Jordan's Mac").device;
    setDeviceKinds(mac.id, [CUTOUT_KIND]);
    touchDevice(mac.id);
    // noise does not shrink: a 4000 × 3000 PNG of it is far over a picture's cap
    const heavy = execFileSync(ffmpegCommand(), ["-v", "error", "-f", "lavfi", "-i", "nullsrc=s=4000x3000,geq=random(1)*255:128:128", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "image2pipe", "-c:v", "png", "-"], { maxBuffer: 1 << 28 });
    expect(heavy.length).toBeGreaterThan(8_000_000);
    const asked = call<{ id: string }>("POST", `/api/designs/${d.id}/pictures/${first}/cutout`, {});
    const sent = await macAnswers(mac, () => heavy);
    expect(sent.mime).toBe("image/png");
    const made = await asked;
    expect(made.status).toBe(200);
    as = "jordan";
    const kept = Buffer.from(await (await app.request(`/api/designs/${d.id}/pictures/${made.body.id}`)).arrayBuffer());
    // a PNG says its size at bytes 16 to 24
    expect([kept.readUInt32BE(16), kept.readUInt32BE(20)]).toEqual([2560, 1920]);
    expect(kept.length).toBeLessThan(heavy.length);
  }, 120_000);
});

describe("designs: blank frames, limits, and what does not get lost", () => {
  it("starts blank frames in any size, in a row", async () => {
    const { status, body: d } = await call<Design>("POST", "/api/designs", { format: "square", blank: true, name: "Launch post", pages: 2 });
    expect(status).toBe(200);
    expect(d).toMatchObject({ name: "Launch post", kind: "carousel", width: 1080, height: 1080 });
    expect(d.pages).toEqual([{ id: "p1", background: "#ffffff", layers: [], x: 0, y: 0, w: 1080, h: 1080 }, { id: "p2", background: "#ffffff", layers: [], x: 1200, y: 0, w: 1080, h: 1080 }]);
    expect(d).not.toHaveProperty("from");
    expect((await call<Design>("POST", "/api/designs", { format: "thumbnail", blank: true })).body).toMatchObject({ name: "Untitled design", kind: "thumbnail", pages: [{ layers: [], w: 1280, h: 720 }] });
    expect((await call<Design>("POST", "/api/designs", { format: "cover", blank: true, pages: 500 })).body.pages).toHaveLength(20);
  });

  it("refuses frames from a window that had not seen the design's last change, and says how the design is now", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    // an AI adds a layer while a window still holds the design as it was
    const ai = (await call<{ design: Design }>("POST", `/api/designs/${d.id}/pages`, { changes: [{ frame: "p1", add: { type: "shape", shape: "rect", fill: "#ff0000", x: 10, y: 10, w: 100, h: 100 } }] })).body.design;
    expect(ai.updatedAt).toBeGreaterThan(d.updatedAt);
    const stale = await call<{ error: string; design: Design }>("PUT", `/api/designs/${d.id}`, { pages: d.pages, since: d.updatedAt });
    expect(stale.status).toBe(409);
    expect(stale.body.design.pages[0]!.layers).toHaveLength(1);
    expect((await call<Design>("GET", `/api/designs/${d.id}`)).body).toEqual(ai);
    // a window that has seen it saves; so does one that says nothing of what it has seen (an older window)
    const seen = await call<Design>("PUT", `/api/designs/${d.id}`, { pages: ai.pages, since: ai.updatedAt });
    expect([seen.status, seen.body.updatedAt > ai.updatedAt]).toEqual([200, true]);
    expect((await call("PUT", `/api/designs/${d.id}`, { pages: d.pages })).status).toBe(200);
  });

  it("two saves of one design at once leave a design that reads; a deleted account's designs go with it", async () => {
    as = "robin";
    const d = (await call<Design>("POST", "/api/designs", { format: "portrait", blank: true }, "robin")).body;
    const page = (fill: string) => ({ pages: [{ id: "p1", background: "#ffffff", layers: Array.from({ length: 40 }, (_, n) => ({ id: `l${n + 1}`, type: "shape", shape: "rect", fill, x: n, y: n, w: 100, h: 100 })) }] });
    await Promise.all(Array.from({ length: 12 }, (_, n) => call("PUT", `/api/designs/${d.id}`, n % 2 ? page("#ff0000") : { pages: [{ id: "p1", background: "#000000", layers: [] }] }, "robin")));
    const kept = await call<Design>("GET", `/api/designs/${d.id}`, undefined, "robin");
    expect(kept.status).toBe(200);
    expect([0, 40]).toContain(kept.body.pages[0]!.layers.length);
    const { deleteUserContent } = await import("./retention");
    await deleteUserContent("robin");
    expect((await call<DesignSummary[]>("GET", "/api/designs", undefined, "robin")).body).toEqual([]);
    expect((await call<DesignSummary[]>("GET", "/api/designs")).body.length).toBeGreaterThan(0);
  });
});

// Last in the file: it gives the script a project and then deletes the script's session.
describe("designs: what each is connected to", () => {
  const BRAND = "eeeeeeee-0000-4000-8000-0000000000b1";
  const OTHER = "eeeeeeee-0000-4000-8000-0000000000b2";
  const THEIRS = "eeeeeeee-0000-4000-8000-0000000000b3";
  const project = (id: string, owner: string, name: string, updatedAt: number) => {
    mkdirSync(ws("projects"), { recursive: true });
    writeFileSync(ws("projects", `${id}.json`), JSON.stringify({ id, owner, name, audience: "", voice: "", cta: "", notes: "", createdAt: 1, updatedAt }));
  };
  const list = async () => (await call<DesignListed[]>("GET", "/api/designs")).body;

  it("the list says the script or the video a design was made from, by its name, and the brand project it is in", async () => {
    project(BRAND, "jordan", "Tiny Acrobatics", 2);
    project(OTHER, "jordan", "Healthy Homes", 1);
    project(THEIRS, "robin", "Not Jordan's", 3);
    // the script is in the second project: its design is too, whatever the window says
    writeFileSync(ws("sessions", SESSION, "meta.json"), JSON.stringify({ id: SESSION, owner: "jordan", title: "Floor time", projectId: OTHER, query: "", sources: [], drafts: [], createdAt: 1, updatedAt: 1 }));
    const ofPiece = (await call<Design>("POST", "/api/designs", { format: "portrait", session: SESSION, doc: DOC, project: BRAND })).body;
    expect(ofPiece.project).toBe(OTHER);
    const ofVideo = (await call<Design>("POST", "/api/designs", { format: "cover", version: "ver_v", t: 1, title: "Cover", project: BRAND })).body;
    // made in the project the window is in; one that is not the person's, or none: the account's current project (its newest)
    const own = (await call<Design>("POST", "/api/designs", { format: "square", blank: true, pages: 0, name: "In the second", project: OTHER })).body;
    const notMine = (await call<Design>("POST", "/api/designs", { format: "square", blank: true, name: "Asked for another's", project: THEIRS })).body;
    const unsaid = (await call<Design>("POST", "/api/designs", { format: "square", blank: true, name: "Said nothing" })).body;
    expect([ofVideo.project, own.project, notMine.project, unsaid.project]).toEqual([BRAND, OTHER, BRAND, BRAND]);

    const all = await list();
    const of = (id: string) => all.find((d) => d.id === id)!;
    expect(of(ofPiece.id)).toMatchObject({ madeFrom: "Tiny Acrobatics floor time", project: OTHER, projectName: "Healthy Homes", from: { session: SESSION, doc: DOC } });
    expect(of(ofVideo.id)).toMatchObject({ madeFrom: "Tiny Acrobatics take", projectName: "Tiny Acrobatics" });
    expect(of(own.id)).toMatchObject({ projectName: "Healthy Homes" });
    expect(of(own.id)).not.toHaveProperty("madeFrom");
    expect(of(notMine.id).projectName).toBe("Tiny Acrobatics");
    // the script moved to the other project: its design follows it at the next list
    writeFileSync(ws("sessions", SESSION, "meta.json"), JSON.stringify({ id: SESSION, owner: "jordan", title: "Floor time", projectId: BRAND, query: "", sources: [], drafts: [], createdAt: 1, updatedAt: 1 }));
    expect((await list()).find((d) => d.id === ofPiece.id)).toMatchObject({ project: BRAND, projectName: "Tiny Acrobatics" });
    // another account's list has none of it
    expect((await call<DesignListed[]>("GET", "/api/designs", undefined, "robin")).body).toEqual([]);
  });

  it("a design whose script, video or project is gone is still listed, without what is gone", async () => {
    const before = await list();
    const ofPiece = before.find((d) => d.madeFrom === "Tiny Acrobatics floor time")!;
    const ofVideo = before.find((d) => d.madeFrom === "Tiny Acrobatics take")!;
    rmSync(ws("sessions", SESSION), { recursive: true, force: true });
    libraryDb().exec("DELETE FROM asset_versions WHERE id = 'ver_v'");
    rmSync(ws("projects", `${OTHER}.json`));
    const res = await call<DesignListed[]>("GET", "/api/designs");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(before.length);
    const piece = res.body.find((d) => d.id === ofPiece.id)!;
    expect(piece).toMatchObject({ from: { session: SESSION, doc: DOC } });
    expect(piece).not.toHaveProperty("madeFrom");
    expect(res.body.find((d) => d.id === ofVideo.id)).not.toHaveProperty("madeFrom");
    // the design made in the project that is gone has no project's name any more
    expect(res.body.find((d) => d.name === "In the second")).not.toHaveProperty("projectName");
  });
});
