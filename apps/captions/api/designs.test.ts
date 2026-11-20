import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Design, DesignAnswer, DesignListed, DesignSummary, GroupLayer, Layer, SplitAnswer } from "../contracts/design";
import { everyLayer } from "../src/lib/design/tree";

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "designs-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = "designs-test-secret";

const { Hono } = await import("hono");
const { designsApp, designTurnsWaiting } = await import("./designs");
await import("./work/task-kinds");
// a video's frame is cut here: the server's video work is on
(await import("./work/server-work")).writeServerWork({ on: true });
const { createAnimation, pictureFile } = await import("./editor/animation-styles");
const { change } = await import("./editor/styles");
const { ffmpegCommand } = await import("./ffmpeg-runtime");
const { blobs, libraryDb } = await import("./library/db");
const { CUTOUT_KIND, SPLIT_KIND } = await import("../contracts/devices");
const { claimCutout, cutoutFailed, cutoutSent, heldCutout } = await import("./lib/cutouts");
const { pairDevice, setDeviceKinds, touchDevice } = await import("./lib/devices");
const { createUser } = await import("./users");
const { workspaceScope } = await import("./lib/workshop/workspace");

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
    // the id the window gave it (so it shows before it is here), and the stamps it saved under; a taken or odd one is refused
    const given = await call<{ id: string; updatedAt: number; was: number }>("POST", `/api/designs/${d.id}/pictures`, { name: "dot.png", type: "image/png", data: png.toString("base64"), id: "0a1b2c3d.png" });
    expect(given.body.id).toBe("0a1b2c3d.png");
    expect(given.body.updatedAt).toBeGreaterThan(given.body.was);
    for (const id of ["0a1b2c3d.png", "0a1b2c3e.jpg", "../x.png"]) expect((await call("POST", `/api/designs/${d.id}/pictures`, { name: "dot.png", type: "image/png", data: png.toString("base64"), id })).status).toBe(400);
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
  type Read = { id: string; fonts: string[]; how: string; looks: Array<{ name: string; kind: string; brief?: string; pictures: number }>; look?: { name: string; brief?: string; pictures: Array<{ what: string; jpeg: string }> } | string; pictures: Array<{ id: string; what: string }>; frames: Frame[]; canvas?: Array<Record<string, unknown>> };
  type Wrote = DesignAnswer & { touched: string[]; wrote: { frame: string; isNew: boolean; layers: string[] }[] };
  const text = { type: "text", font: "Anton", size: 90, color: "#ffffff", align: "center", x: 90, y: 400, w: 900, h: 300 };
  const read = async (id: string, more = "") => (await call<Read>("GET", `/api/designs/${id}/pages${more}`)).body;
  const write = (id: string, body: unknown) => call<Wrote>("POST", `/api/designs/${id}/pages`, body);

  it("lays out an AI's auto layout: a badge's longer word grows its pill, a list keeps even gaps, what cannot apply is said", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const word = { type: "text", font: "Inter", size: 40, color: "#ffffff", align: "left", x: 0, y: 0, w: 10, h: 10, sizing: { w: "hug", h: "hug" } };
    const badge = { type: "group", box: true, id: "badge", x: 80, y: 80, w: 10, h: 10, radius: 999, layout: { dir: "row", pad: [14, 32, 14, 32] }, sizing: { w: "hug", h: "hug" }, layers: [{ ...word, id: "word", text: "NEW" }] };
    const point = (id: string, t: string) => ({ ...word, id, text: t, sizing: { w: "fill", h: "hug" } });
    const list = { type: "group", box: true, id: "list", x: 80, y: 300, w: 900, h: 10, layout: { dir: "column", gap: 32 }, sizing: { h: "hug" }, layers: [{ ...point("a", "One"), max: { w: 0 } }, point("b", "Two"), point("c", "Three")] };
    const odd = [{ type: "shape", shape: "rect", id: "bar", x: 0, y: 0, w: 50, h: 50, fill: "#000000", sizing: { w: "fill", h: "hug" } }, { type: "group", box: true, id: "bad", x: 0, y: 900, w: 50, h: 50, layout: { dir: "diagonal" }, layers: [] }];
    const first = (await write(d.id, { frames: [{ id: d.pages[0]!.id, layers: [badge, list, ...odd] }] })).body;
    const at = (b: typeof first, id: string) => everyLayer(b.design.pages[0]!.layers).find((l) => l.id === id)! as GroupLayer;
    const pill = at(first, "badge");
    expect(pill.layout).toEqual({ dir: "row", pad: [14, 32, 14, 32] });
    expect(pill.w).toBe(at(first, "word").w + 64);
    expect(pill.h).toBe(at(first, "word").h + 28);
    const ys = at(first, "list").layers.map((l) => l.y);
    expect(ys[1]! - ys[0]!).toBe(ys[2]! - ys[1]!);
    expect(at(first, "list").layers.every((l) => l.w === 900)).toBe(true);
    expect(at(first, "bar").sizing).toBeUndefined();
    // a most of 0 is none: the point still fills its line
    expect(at(first, "a").max).toBeUndefined();
    expect(at(first, "bad").layout).toBeUndefined();
    expect(first.notes.join(" ")).toMatch(/"fill" is for a layer of a box with an auto layout/);
    expect(first.notes.join(" ")).toMatch(/"hug" is for a text or a box with an auto layout/);
    expect(first.notes.join(" ")).toMatch(/an auto layout needs "dir"/);
    // only the word changes: the pill grows round it, where it was
    const second = (await write(d.id, { changes: [{ frame: d.pages[0]!.id, layer: "word", set: { text: "LIMITED OFFER" } }] })).body;
    expect(at(second, "badge").w).toBeGreaterThan(pill.w + 100);
    expect([at(second, "badge").x, at(second, "badge").y]).toEqual([80, 80]);
    expect(at(second, "badge").w).toBe(at(second, "word").w + 64);
    // a save by hand keeps the sizes the browser measured its words at, and lays out its boxes round them
    const saved = second.design.pages[0]!;
    const mine = { ...saved, layers: saved.layers.map((l) => (l.id === "badge" ? { ...l, layers: (l as GroupLayer).layers.map((k) => ({ ...k, w: 500 })) } : l)) };
    const put = (await call<Design>("PUT", `/api/designs/${d.id}`, { pages: [mine] })).body;
    expect([everyLayer(put.pages[0]!.layers).find((l) => l.id === "word")!.w, put.pages[0]!.layers.find((l) => l.id === "badge")!.w]).toEqual([500, 564]);
  });

  it("an AI's new auto layout box keeps its layer out of the flow where it was given; a longer word later moves it by its pin", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const word = { type: "text", id: "w", font: "Inter", size: 40, color: "#ffffff", align: "left", x: 0, y: 0, w: 10, h: 10, sizing: { w: "hug", h: "hug" }, text: "NEW" };
    // a dot at the badge's top right, placed in the box as it will be laid out; the box's own size is only a start
    const dot = { type: "shape", shape: "ellipse", id: "dot", fill: "#ff0000", x: 100, y: -6, w: 12, h: 12, absolute: true, pin: { x: "right" } };
    const badge = { type: "group", box: true, id: "badge", x: 80, y: 80, w: 10, h: 10, layout: { dir: "row", pad: [14, 32, 14, 32] }, sizing: { w: "hug", h: "hug" }, layers: [word, dot] };
    const first = (await write(d.id, { frames: [{ id: d.pages[0]!.id, layers: [badge] }] })).body;
    const at = (b: typeof first, id: string) => everyLayer(b.design.pages[0]!.layers).find((l) => l.id === id)! as GroupLayer;
    expect([at(first, "dot").x, at(first, "dot").y]).toEqual([100, -6]);
    // the box laid out now: a longer word grows it, and the dot keeps its distance to the right edge
    const second = (await write(d.id, { changes: [{ frame: d.pages[0]!.id, layer: "w", set: { text: "LIMITED OFFER" } }] })).body;
    const grew = at(second, "badge").w - at(first, "badge").w;
    expect(grew).toBeGreaterThan(100);
    expect(at(second, "dot").x).toBeCloseTo(100 + grew, 1);
    // the whole frame given again, the badge at the size it was saved at: a longer word moves the dot by its pin
    const savedBadge = at(second, "badge");
    const longer = { ...savedBadge, layers: savedBadge.layers.map((l) => (l.id === "w" ? { ...l, text: "LIMITED OFFER TODAY" } : l)) };
    const third = (await write(d.id, { frames: [{ id: d.pages[0]!.id, layers: [longer] }] })).body;
    expect(at(third, "dot").x).toBeCloseTo(at(second, "dot").x + at(third, "badge").w - savedBadge.w, 1);
    // given at another size (a start again): the dot stays where it is given
    const fourth = (await write(d.id, { frames: [{ id: d.pages[0]!.id, layers: [{ ...badge, layers: [{ ...word, text: "SALE" }, { ...dot, x: 50 }] }] }] })).body;
    expect(at(fourth, "dot").x).toBe(50);
  });

  it("a hugging box an AI gives a height to takes its own back, its layer pinned to its bottom with it", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const word = { type: "text", id: "w", font: "Inter", size: 40, color: "#ffffff", align: "left", x: 0, y: 0, w: 10, h: 10, sizing: { w: "hug", h: "hug" }, text: "NEW" };
    const tag = { type: "shape", shape: "rect", id: "tag", fill: "#ff0000", x: 0, y: 40, w: 20, h: 6, absolute: true, pin: { y: "bottom" } };
    const badge = { type: "group", box: true, id: "badge", x: 80, y: 80, w: 10, h: 10, layout: { dir: "row", pad: 10 }, sizing: { w: "hug", h: "hug" }, layers: [word, tag] };
    const at = (b: Design, id: string) => everyLayer(b.pages[0]!.layers).find((l) => l.id === id)! as GroupLayer;
    const first = (await write(d.id, { frames: [{ id: d.pages[0]!.id, layers: [badge] }] })).body.design;
    const second = (await write(d.id, { changes: [{ frame: d.pages[0]!.id, layer: "badge", set: { h: 200 } }] })).body.design;
    expect([at(second, "badge").h, at(second, "tag").y]).toEqual([at(first, "badge").h, at(first, "tag").y]);
  });

  it("a hugging box on the canvas, named apart from another's, takes its own size back when an AI gives it a height", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const word = { type: "text", id: "w", font: "Inter", size: 40, color: "#ffffff", align: "left", x: 0, y: 0, w: 10, h: 10, sizing: { w: "hug", h: "hug" }, text: "NEW" };
    const tag = { type: "shape", shape: "rect", id: "tag", fill: "#ff0000", x: 0, y: 40, w: 20, h: 6, absolute: true, pin: { y: "bottom" } };
    const badge = { type: "group", box: true, id: "badge", x: 0, y: 0, w: 10, h: 10, layout: { dir: "row", pad: 10 }, sizing: { w: "hug", h: "hug" }, layers: [word, tag] };
    // two pieces on the canvas, each with a layer "badge": the second is "c1" to an AI
    const piece = (id: string, y: number) => ({ id, loose: true, x: 2000, y, background: "#ffffff", layers: [badge] });
    await call("PUT", `/api/designs/${d.id}`, { pages: [d.pages[0], piece("k1", 0), piece("k2", 600)] });
    const read = (await call<{ canvas?: { id: string; y: number }[] }>("GET", `/api/designs/${d.id}/pages`)).body;
    expect(read.canvas!.map((l) => l.id)).toEqual(["badge", "c1"]);
    const box = (ps: Design["pages"]) => ps.find((p) => p.id === "k2")!.layers[0] as GroupLayer;
    // how far the tag's bottom lies from the box's bottom (it is pinned to it)
    const gap = (g: GroupLayer) => g.h - (g.layers.find((l) => l.id === "tag") as Layer).y - 6;
    const first = box((await call<Design>("GET", `/api/designs/${d.id}`)).body.pages);
    const after = box((await write(d.id, { changes: [{ frame: "canvas", layer: "c1", set: { h: 200 } }] })).body.design.pages);
    // laid out at its size before: it hugs its words again and its tag goes back with its bottom
    expect(after.h).toBeLessThan(200);
    expect(gap(after)).toBeCloseTo(gap(first), 1);
  });

  it("a saved box the server stretches with its frame keeps its layer pinned to its bottom on it", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const words = { type: "text", id: "w", font: "Inter", size: 40, color: "#111111", align: "left", x: 0, y: 0, w: 280, h: 10, sizing: { w: "fill", h: "hug" }, text: "words that wrap over a few lines here" };
    const tag = { type: "shape", shape: "rect", id: "tag", fill: "#ff0000", x: 0, y: 40, w: 20, h: 6, absolute: true, pin: { y: "bottom" } };
    const card = { type: "group", box: true, id: "card", x: 100, y: 100, w: 300, h: 10, pin: { x: "both" }, layout: { dir: "column", pad: 10 }, sizing: { h: "hug" }, layers: [words, tag] };
    const at = (b: Design, id: string) => everyLayer(b.pages[0]!.layers).find((l) => l.id === id)! as GroupLayer;
    const first = (await write(d.id, { frames: [{ id: d.pages[0]!.id, layers: [card] }] })).body.design;
    // the tag sits 4 above the card's bottom
    const gap = at(first, "card").h - at(first, "tag").y - at(first, "tag").h;
    // the frame 600 wider: the card with it, its words on fewer lines, so it hugs shorter: the tag goes up with its bottom
    const wide = (await write(d.id, { frames: [{ id: d.pages[0]!.id, w: 1680 }] })).body.design;
    expect(at(wide, "card").w).toBe(900);
    expect(at(wide, "card").h).toBeLessThan(at(first, "card").h);
    expect(at(wide, "card").h - at(wide, "tag").y - at(wide, "tag").h).toBeCloseTo(gap, 1);
  });

  it("an AI writes a ring as a subtract group and a picture inside the headline's letters, and reads how", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const how = (await call<{ how: string }>("GET", `/api/designs/${d.id}/pages`)).body.how;
    for (const part of ['"boolean":"subtract"', '"mask":"alpha"', "luminance"]) expect(how).toContain(part);
    const disc = (x: number, w: number) => ({ type: "shape", shape: "ellipse", x, y: x, w, h: w, fill: "#000000" });
    const ring = { type: "group", id: "ring", boolean: "subtract", x: 600, y: 600, w: 10, h: 10, fills: [{ type: "solid", color: "#ff5a36" }], layers: [disc(0, 300), disc(75, 150)] };
    const words = { type: "text", id: "head", text: "SUMMER", mask: "alpha", font: "Inter", size: 200, color: "#000000", align: "center", x: 0, y: 0, w: 1000, h: 240 };
    const photo = { type: "shape", id: "photo", shape: "rect", x: 0, y: 0, w: 1000, h: 240, fills: [{ type: "gradient", angle: 0, stops: [{ at: 0, color: "#ff0000" }, { at: 1, color: "#0000ff" }] }] };
    const r = (await write(d.id, { frames: [{ id: d.pages[0]!.id, layers: [ring, { type: "group", id: "inwords", x: 40, y: 80, w: 10, h: 10, layers: [words, photo] }] }] })).body;
    const [g, m] = r.design.pages[0]!.layers as GroupLayer[];
    expect([g!.boolean, g!.x, g!.y, g!.w, g!.h, g!.layers.length]).toEqual(["subtract", 600, 600, 300, 300, 2]);
    expect(m!.layers.map((l) => [l.id, l.mask])).toEqual([["head", "alpha"], ["photo", undefined]]);
    expect(r.notes).toEqual([]);
  });

  it("an AI makes a handle pill once and places it on every slide; a change to the main reaches all of them, an override stays", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "portrait", blank: true, pages: 3 })).body;
    const [p1, p2, p3] = d.pages.map((p) => p.id);
    const how = (await read(d.id)).how;
    for (const part of ['"component":"<key>"', '"instance":{"of":"<key>"', '"bind":{"text":"Number"}', "never as copies of its layers"]) expect(how).toContain(part);
    const label = { type: "text", id: "label", text: "@tinyacrobatics", bind: { text: "Handle" }, font: "Inter", size: 36, color: "#ffffff", align: "center", x: 0, y: 0, w: 360, h: 80 };
    const pill = { type: "group", id: "pill", box: true, component: "handle", name: "Handle pill", x: 80, y: 1200, w: 360, h: 80, radius: 40, fills: [{ type: "solid", color: "#111111" }], layers: [label] };
    const place = (id: string, more: object = {}) => ({ type: "group", id, instance: { of: "handle", ...more }, x: 80, y: 1200 });
    let r = (await write(d.id, { frames: [{ id: p1, layers: [pill] }, { id: p2, layers: [place("h2")] }, { id: p3, layers: [place("h3", { props: { Handle: "@tiny" } })] }] })).body;
    const at = (frame: string, id: string) => everyLayer(r.design.pages.find((p) => p.id === frame)!.layers).find((l) => l.id === id) as GroupLayer & Record<string, unknown>;
    expect(r.notes).toEqual([]);
    expect(at(p2!, "h2")).toMatchObject({ w: 360, h: 80, box: true, name: "Handle pill" });
    expect(at(p2!, "h2.label")).toMatchObject({ text: "@tinyacrobatics" });
    expect(at(p3!, "h3.label")).toMatchObject({ text: "@tiny" });
    // one instance's words coloured, then the main's colour changed once
    r = (await write(d.id, { changes: [{ frame: p2, layer: "h2.label", set: { color: "#ffcc00" } }] })).body;
    expect(at(p2!, "h2").instance).toEqual({ of: "handle", overrides: { label: { color: "#ffcc00" } } });
    r = (await write(d.id, { changes: [{ frame: p1, layer: "pill", set: { fills: [{ type: "solid", color: "#ff3366" }] } }, { frame: p1, layer: "label", set: { size: 40 } }] })).body;
    for (const [f, i] of [[p2, "h2"], [p3, "h3"]] as const) expect((at(f!, i).fills as { color: string }[])[0]!.color).toBe("#ff3366");
    expect(at(p2!, "h2.label")).toMatchObject({ color: "#ffcc00", size: 40 });
    expect(at(p3!, "h3.label")).toMatchObject({ color: "#ffffff", size: 40, text: "@tiny" });
    // its overrides taken back
    r = (await write(d.id, { changes: [{ frame: p2, layer: "h2", set: { instance: { overrides: null, props: null } } }] })).body;
    expect(at(p2!, "h2.label")).toMatchObject({ color: "#ffffff" });
  });

  it("holds an AI's components to what a layer may be: overrides checked, a loop refused, an instance of no main kept and said", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true, pages: 2 })).body;
    const [p1, p2] = d.pages.map((p) => p.id);
    const chip = { type: "group", id: "chip", box: true, component: "chip", x: 900, y: 40, w: 120, h: 60, layers: [{ type: "text", id: "n", text: "1/2", font: "Inter", size: 30, color: "#000000", align: "center", x: 0, y: 0, w: 120, h: 60 }, { type: "group", id: "self", instance: { of: "chip" }, x: 0, y: 0 }] };
    const odd = { type: "group", id: "c2", instance: { of: "chip", overrides: { n: { text: "x".repeat(5000), x: 999, component: "evil", color: "red" }, "../bad": { color: "#000000" } } }, x: 40, y: 40 };
    const r = (await write(d.id, { frames: [{ id: p1, layers: [chip] }, { id: p2, layers: [odd, { type: "group", id: "lost", instance: { of: "nowhere" }, x: 0, y: 0, w: 100, h: 100 }] }] })).body;
    const all = everyLayer(r.design.pages.flatMap((p) => p.layers));
    expect(all.some((l) => l.id === "self")).toBe(false);
    expect(r.notes.join("\n")).toMatch(/inside main "chip", which it would hold: left out/);
    expect(r.notes.join("\n")).toMatch(/an instance of "nowhere", which this design has no main component of/);
    const c2 = all.find((l) => l.id === "c2") as GroupLayer;
    const n = all.find((l) => l.id === "c2.n") as unknown as Record<string, unknown>;
    // the words held to the text limit, a colour it cannot be made one it can, the place and the key never taken from an override
    expect((n.text as string).length).toBe(2000);
    expect([n.x, n.color]).toEqual([0, "#111111"]);
    expect(c2.instance!.overrides).toEqual({ n: { text: "x".repeat(2000), color: "#111111" } });
    expect(all.find((l) => l.id === "lost")).toMatchObject({ instance: { of: "nowhere" }, layers: [] });
    // an override nested without end is left out, never kept or thrown on
    let nest: Record<string, unknown> = { color: "#000000" };
    for (let i = 0; i < 2000; i++) nest = { a: nest };
    const deep = (await write(d.id, { changes: [{ frame: p2, layer: "c2", set: { instance: { of: "chip", overrides: { n: { effects: nest } } } } }] }));
    expect(deep.status).toBe(200);
    const c2now = everyLayer(deep.body.design.pages.flatMap((p) => p.layers)).find((l) => l.id === "c2") as GroupLayer;
    expect(JSON.stringify(c2now.instance)).not.toContain('"a":');
  });

  it("keeps an override inside an instance in an instance through a save and a read, and names a second main of one key", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true, pages: 2 })).body;
    const [p1, p2] = d.pages.map((p) => p.id);
    const shape = (id: string, fill: string) => ({ type: "shape", id, shape: "ellipse", fill, x: 0, y: 0, w: 40, h: 40 });
    const dot = { type: "group", id: "d", box: true, component: "dot", x: 600, y: 40, w: 40, h: 40, layers: [shape("o1", "#ff0000")] };
    const chip = { type: "group", id: "c", box: true, component: "chip", x: 40, y: 40, w: 200, h: 60, layers: [{ type: "group", id: "n", instance: { of: "dot" }, x: 10, y: 10 }] };
    await write(d.id, { frames: [{ id: p1, layers: [dot, chip] }, { id: p2, layers: [{ type: "group", id: "i", instance: { of: "chip" }, x: 40, y: 400 }] }] });
    const r = (await write(d.id, { changes: [{ frame: p2, layer: "i.n.o1", set: { fill: "#0000ff" } }] })).body;
    const inst = () => r.design.pages.find((p) => p.id === p2)!.layers[0] as GroupLayer;
    expect(inst().instance).toEqual({ of: "chip", overrides: { "n.o1": { fill: "#0000ff" } } });
    const again = (await call<Design>("GET", `/api/designs/${d.id}`)).body;
    expect(everyLayer(again.pages.find((p) => p.id === p2)!.layers).find((l) => l.id === "i.n.o1")).toMatchObject({ fill: "#0000ff" });
    // an AI's main with a key the design has, and other layers: a main of its own, said
    const clash = (await write(d.id, { changes: [{ frame: p2, add: { type: "group", box: true, component: "dot", x: 500, y: 500, w: 50, h: 50, layers: [shape("q", "#00ff00")] } }] })).body;
    expect(clash.notes.join("\n")).toMatch(/a second "dot" main is now "c1"/);
    const mains = everyLayer(clash.design.pages.flatMap((p) => p.layers)).filter((l) => (l as GroupLayer).component);
    expect(mains.map((l) => (l as GroupLayer).component).sort()).toEqual(["c1", "chip", "dot"]);
  });

  it("never gives an AI's new layer an id a layer had, so the person's edit of the old one never lands on it", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const p1 = d.pages[0]!.id;
    const t = (id: string, text: string) => ({ type: "text", id, text, font: "Inter", size: 40, color: "#000000", align: "left", x: 0, y: 0, w: 400, h: 60 });
    await write(d.id, { frames: [{ id: p1, layers: [t("l1", "One"), t("l9", "Old nine")] }] });
    const r = (await write(d.id, { changes: [{ frame: p1, layer: "l9", remove: true }, { frame: p1, add: t("l9", "New text") }, { frame: p1, add: t("", "Another") }] })).body;
    const texts = Object.fromEntries(r.design.pages[0]!.layers.map((l) => [l.id, (l as { text: string }).text]));
    expect(texts.l9).toBeUndefined();
    expect(Object.values(texts).sort()).toEqual(["Another", "New text", "One"]);
    expect(Object.keys(texts).every((id) => id === "l1" || Number(id.slice(1)) >= 10)).toBe(true);
    // the highest one taken out: the frame remembers it, and the next new layer goes past it
    const top = Math.max(...Object.keys(texts).map((id) => Number(id.slice(1))));
    const gone = (await write(d.id, { changes: [{ frame: p1, layer: `l${top}`, remove: true }] })).body.design.pages[0]!;
    expect(gone.next).toBe(top + 1);
    const again = (await write(d.id, { changes: [{ frame: p1, add: t(`l${top}`, "Later") }] })).body.design.pages[0]!;
    expect(again.layers.find((l) => (l as { text: string }).text === "Later")!.id).toBe(`l${top + 1}`);
  });

  it("tells the person's window of a second main given a key of its own apart from what was left out", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true, pages: 2 })).body;
    const [p1, p2] = d.pages.map((p) => p.id);
    const card = (id: string, fill: string, x: number) => ({ type: "group", id, box: true, component: "card", x, y: 0, w: 100, h: 100, layers: [{ type: "shape", id: `${id}s`, shape: "rect", fill, x: 0, y: 0, w: 100, h: 100 }, { type: "shape", id: `${id}t`, shape: "ellipse", fill, x: 10, y: 10, w: 20, h: 20 }] });
    const first = (await write(d.id, { frames: [{ id: p1, layers: [card("a", "#ff0000", 0)] }] })).body.design;
    const mine = first.pages.map((p) => (p.id === p2 ? { ...p, layers: [{ ...card("b", "#00ff00", 300), layers: [card("b", "#00ff00", 300).layers[0]] }] } : p));
    const saved = (await call<Design & { notes?: string[]; changes?: string[] }>("PUT", `/api/designs/${d.id}`, { pages: mine, since: first.updatedAt })).body;
    expect(saved.notes).toBeUndefined();
    expect(saved.changes?.join()).toMatch(/a second "card" main is now "c1"/);
  });

  it("keeps the id of the person's own layer back (undone after a saved delete), and takes a window's save on top of its own", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const t = (id: string, text: string) => ({ type: "text", id, text, font: "Inter", size: 40, color: "#000000", align: "left", x: 0, y: 0, w: 400, h: 60 });
    const page0 = d.pages[0]!;
    const one = (await call<Design>("PUT", `/api/designs/${d.id}`, { pages: [{ ...page0, layers: [t("l1", "One"), t("l2", "Two")] }], since: d.updatedAt, by: "window-one", n: 1 })).body;
    const two = (await call<Design>("PUT", `/api/designs/${d.id}`, { pages: [{ ...one.pages[0]!, layers: [t("l1", "One")] }], since: one.updatedAt, by: "window-one", n: 2 })).body;
    expect(two.pages[0]!.next).toBe(3);
    // ⌘Z: l2 comes back under its own id
    const back = (await call<Design>("PUT", `/api/designs/${d.id}`, { pages: [{ ...two.pages[0]!, layers: [t("l1", "One"), t("l2", "Two")] }], since: two.updatedAt, by: "window-one", n: 3 })).body;
    expect(back.pages[0]!.layers.map((l) => l.id)).toEqual(["l1", "l2"]);
    // sent as the window closed, after a save of its own it had not heard back from: taken, not refused
    const late = await call<Design>("PUT", `/api/designs/${d.id}`, { pages: [{ ...back.pages[0]!, layers: [t("l1", "One, closing")] }], since: two.updatedAt, by: "window-one", n: 4 });
    expect(late.status).toBe(200);
    // an earlier save of its own arriving after a later one (a page brought back) is not taken over it
    const older = await call<Design>("PUT", `/api/designs/${d.id}`, { pages: two.pages, since: two.updatedAt, by: "window-one", n: 1 });
    expect(older.status).toBe(409);
    // after another's write it is refused
    await write(d.id, { changes: [{ frame: page0.id, layer: "l1", set: { color: "#ff0000" } }] });
    const after = await call<Design>("PUT", `/api/designs/${d.id}`, { pages: back.pages, since: late.body.updatedAt, by: "window-one", n: 5 });
    expect(after.status).toBe(409);
  });

  it("keeps an AI's write made while a picture was being added, and never holds every write for a slow save's body", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const p1 = d.pages[0]!.id;
    const png = execFileSync(ffmpegCommand(), ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=1200x1200", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]);
    const upload = call("POST", `/api/designs/${d.id}/pictures`, { name: "red.png", type: "image/png", data: png.toString("base64") });
    const ai = write(d.id, { frames: [{ id: p1, layers: [{ type: "text", id: "t", text: "Written meanwhile", font: "Inter", size: 40, color: "#000000", align: "left", x: 0, y: 0, w: 400, h: 60 }] }] });
    await Promise.all([upload, ai]);
    const now = (await call<Design>("GET", `/api/designs/${d.id}`)).body;
    expect(now.pages[0]!.layers.map((l) => (l as { text?: string }).text)).toEqual(["Written meanwhile"]);
    expect(now.pictures).toHaveLength(1);
    // a save whose body is still coming holds no other write to the design
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const stream = new ReadableStream({ async start(ctl) { ctl.enqueue(new TextEncoder().encode('{"pages":')); await held; ctl.enqueue(new TextEncoder().encode(`${JSON.stringify(now.pages)},"since":${now.updatedAt}}`)); ctl.close(); } });
    as = "jordan";
    const slow = app.request(`/api/designs/${d.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    const quick = await Promise.race([write(d.id, { changes: [{ frame: p1, layer: "t", set: { color: "#ff0000" } }] }).then(() => "written"), new Promise((r) => setTimeout(() => r("held"), 3000))]);
    release();
    await slow;
    expect(quick).toBe("written");
    // and the turns kept for a design go once nothing waits on them
    expect(designTurnsWaiting()).toBe(0);
  });

  it("an AI fills a slide whose number chip is a main: each copy gets an instance with its own number, the main stays one", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const p1 = d.pages[0]!.id;
    const chip = { type: "group", id: "chip", box: true, component: "chip", x: 900, y: 40, w: 120, h: 60, layers: [{ type: "text", id: "n", text: "1/3", bind: { text: "Number" }, font: "Inter", size: 30, color: "#000000", align: "center", x: 0, y: 0, w: 120, h: 60 }] };
    await write(d.id, { frames: [{ id: p1, layers: [chip] }] });
    const r = (await write(d.id, { fill: { frame: p1, rows: [{ Number: "2/3" }, { Number: "3/3" }] } })).body;
    const copies = r.design.pages.filter((p) => p.id !== p1);
    expect(copies.map((p) => (p.layers[0] as GroupLayer).instance)).toEqual([{ of: "chip", props: { Number: "2/3" } }, { of: "chip", props: { Number: "3/3" } }]);
    expect(copies.map((p) => ((p.layers[0] as GroupLayer).layers[0] as { text: string }).text)).toEqual(["2/3", "3/3"]);
    expect(everyLayer(r.design.pages.flatMap((p) => p.layers)).filter((l) => (l as GroupLayer).component).length).toBe(1);
  });

  it("keeps what the person changed on an instance as its override, and makes a stale one from its main", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true, pages: 2 })).body;
    const [p1, p2] = d.pages.map((p) => p.id);
    const badge = { type: "group", id: "b", box: true, component: "badge", x: 40, y: 40, w: 200, h: 80, fills: [{ type: "solid", color: "#111111" }], layers: [{ type: "shape", id: "dot", shape: "ellipse", fill: "#00ff00", x: 10, y: 10, w: 20, h: 20 }] };
    const first = (await write(d.id, { frames: [{ id: p1, layers: [badge] }, { id: p2, layers: [{ type: "group", id: "i", instance: { of: "badge" }, x: 300, y: 300 }] }] })).body.design;
    // the window: the instance's dot coloured by hand, saved
    const mine = first.pages.map((p) => (p.id !== p2 ? p : { ...p, layers: p.layers.map((l) => ({ ...l, layers: (l as GroupLayer).layers.map((k) => ({ ...k, fill: "#0000ff" })) })) }));
    const saved = (await call<Design>("PUT", `/api/designs/${d.id}`, { pages: mine, since: first.updatedAt })).body;
    const inst = saved.pages.find((p) => p.id === p2)!.layers[0] as GroupLayer;
    expect(inst.instance).toEqual({ of: "badge", overrides: { dot: { fill: "#0000ff" } } });
    // a window that did not see the main's change sends the old instance with it: it is made from the main as it is now
    const main = saved.pages.find((p) => p.id === p1)!;
    const now = (await call<Design>("PUT", `/api/designs/${d.id}`, { pages: [{ ...main, layers: [{ ...main.layers[0]!, fills: [{ type: "solid", color: "#ff0000" }] }] }, saved.pages.find((p) => p.id === p2)], since: saved.updatedAt })).body;
    const after = now.pages.find((p) => p.id === p2)!.layers[0] as GroupLayer;
    expect(after.fills).toEqual([{ type: "solid", color: "#ff0000" }]);
    expect(after.instance).toEqual({ of: "badge", overrides: { dot: { fill: "#0000ff" } } });
  });

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

  it("never drops a reference layer when it writes a frame's layers whole", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "thumbnail", blank: true, name: "Title" })).body;
    const grab = { id: "g", type: "shape", shape: "rect", fill: "#00ff00", x: 0, y: 0, w: 1280, h: 720, name: "Frame grab", reference: true };
    // the person's own write keeps it (PUT)
    await call("PUT", `/api/designs/${d.id}`, { pages: [{ ...d.pages[0]!, layers: [grab] }] });
    // sent again without the flag: still a reference
    const again = (await write(d.id, { frames: [{ id: "p1", layers: [{ ...grab, reference: undefined }, { ...text, id: "t", text: "Big news" }] }] })).body.design.pages[0]!;
    expect(again.layers.map((l) => [l.id, !!l.reference])).toEqual([["g", true], ["t", false]]);
    // left out: kept under the rest
    const left = (await write(d.id, { frames: [{ id: "p1", layers: [{ ...text, id: "t", text: "Bigger news" }] }] })).body.design.pages[0]!;
    expect(left.layers.map((l) => [l.id, !!l.reference])).toEqual([["g", true], ["t", false]]);
  });

  it("resizes a frame with its pinned layers, copies frames into other sizes and fills a frame with rows of words", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "portrait", blank: true, pages: 2, name: "Sizes" })).body;
    const layers = [
      { type: "shape", shape: "rect", fill: "#222222", x: 0, y: 0, w: 1080, h: 1350, name: "Ground" },
      { ...text, text: "First", name: "Headline", fit: "shrink" },
      { type: "shape", shape: "ellipse", fill: "#ff6600", x: 900, y: 1170, w: 120, h: 120, name: "Badge", pin: { x: "right", y: "bottom", z: "no" } },
    ];
    expect((await write(d.id, { frames: [{ id: "p1", layers }] })).status).toBe(200);
    // wider by 200 and taller by 100: the pinned badge goes with the bottom right corner, the rest stays
    const wide = (await write(d.id, { frames: [{ id: "p1", w: 1280, h: 1450 }] })).body.design.pages[0]!;
    expect(wide.layers.map((l) => [l.x, l.y, l.w])).toEqual([[0, 0, 1080], [90, 400, 900], [1100, 1270, 120]]);
    expect(wide.layers[2]!.pin).toEqual({ x: "right", y: "bottom" });
    await write(d.id, { frames: [{ id: "p1", w: 1080, h: 1350 }] });

    // every frame in two sizes: a row a size under the frames, each copy under its frame, named for its size
    const sized = await write(d.id, { sizes: { to: ["cover", { name: "Wide", w: 1600, h: 900 }, "huge"] } });
    expect(sized.status).toBe(200);
    expect(sized.body.notes[0]).toContain('sizes.to[2]: a size that is neither a format');
    const copies = sized.body.design.pages.filter((p) => sized.body.touched.includes(p.id));
    expect(copies.map((p) => [p.name, p.x, p.y, p.w, p.h])).toEqual([
      ["Frame 1 Vertical cover 9:16", 0, 1590, 1080, 1920],
      ["Frame 2 Vertical cover 9:16", 1200, 1590, 1080, 1920],
      ["Frame 1 Wide", 0, 3750, 1600, 900],
      ["Frame 2 Wide", 1200, 3750, 1600, 900],
    ]);
    // the ground stretches over the cover, the badge keeps its corner, the words their size
    expect(copies[0]!.layers.map((l) => [l.x, l.y, l.w, l.h])).toEqual([[0, 0, 1080, 1920], [90, (550 * 1920) / 1350 - 150, 900, 300], [900, 1740, 120, 120]].map((r) => r.map((n) => Math.round(n * 100) / 100)));

    // one frame a row of words, in its own size, to the right of every frame
    const filled = await write(d.id, { fill: { frame: "p1", rows: [{ name: "02 Proof", Headline: "Second" }, { headline: "Third", Badge: { visible: false }, Price: "9" }] } });
    const rows = filled.body.design.pages.filter((p) => filled.body.touched.includes(p.id));
    expect(rows.map((p) => [p.name, p.x, p.y, p.w, (p.layers[1] as { text: string }).text, !!p.layers[2]!.hidden])).toEqual([
      ["02 Proof", 2920, 0, 1080, "Second", false],
      ["Frame 1 2", 4120, 0, 1080, "Third", true],
    ]);
    expect(filled.body.notes).toEqual(['fill.rows: Frame 1 has no layer named "Price": give the layers to fill a "name"']);
    // the design is full: the copies that fit are made, the rest named
    const full = await write(d.id, { sizes: { frames: ["p1"], to: ["square", "cover", "tall", "thumbnail", "square", "cover", "tall", "thumbnail", "square", "cover", "tall", "thumbnail", "square", "cover"] } });
    expect(full.body.touched).toHaveLength(12);
    expect(full.body.notes.at(-1)).toContain("at most 20 frames");
    expect((await write(d.id, { fill: { frame: "nope", rows: [{}] } })).status).toBe(400);
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
    expect(out.body.notes).toEqual(['frames[1]: there is no frame nope: this design\'s are p1, p2, p3 (a new frame has no "id": name it with "as")', "frames[0].layers[2], frame p2 (Frame 2): “Buy the course” is not in its own words: left out"]);
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
    expect(out.notes).toEqual(["changes[3], frame p1 (Frame 1): there is no layer ghost: its layers are moon, title, sun", 'changes[4]: names no frame of this design (p9): its frames are p1, and "canvas" holds what lies outside them']);
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
    expect(held.notes).toEqual(["changes[0], frame p3 (Frame 3), layer l1: “Buy now” is not in its own words: left out"]);
  });

  it("changes layers inside groups by their ids: adds one into a group, moves one out where it is on the frame, takes a group apart", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const pill = { type: "group", box: true, name: "Badge", x: 100, y: 200, w: 300, h: 80, radius: 40, fills: [{ type: "solid", color: "#111111" }], layers: [{ id: "word", type: "text", text: "NEW", font: "Anton", size: 40, color: "#ffffff", align: "center", x: 0, y: 0, w: 300, h: 80 }] };
    const made = (await write(d.id, { changes: [{ frame: "p1", add: pill, as: "badge" }, { frame: "p1", add: { type: "shape", shape: "star", fill: "#ffcc00", x: 10, y: 10, w: 40, h: 40 }, in: "badge", as: "star" }] })).body;
    expect(made.notes).toEqual([]);
    const g = made.design.pages[0]!.layers[0]!;
    expect(g).toMatchObject({ type: "group", box: true, x: 100, y: 200, radius: 40 });
    expect(g.type === "group" && g.layers.map((l) => [l.id, l.type, l.x, l.y])).toEqual([["word", "text", 0, 0], ["star", "shape", 10, 10]]);
    // a group added with layers of its own: they get ids the frame does not use, so the layers there keep theirs
    const more = (await write(d.id, { changes: [{ frame: "p1", at: "back", add: { type: "group", layers: [{ id: "word", type: "shape", shape: "rect", fill: "#00ff00", x: 0, y: 0, w: 10, h: 10 }, { type: "shape", shape: "rect", fill: "#00ff00", x: 20, y: 0, w: 10, h: 10 }] }, as: "spare" }] })).body;
    const spare = more.design.pages[0]!.layers[0]!;
    const ids = more.design.pages[0]!.layers.flatMap((l) => [l.id, ...(l.type === "group" ? l.layers.map((x) => x.id) : [])]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(more.design.pages[0]!.layers[1]).toMatchObject({ id: "badge" });
    expect(spare.type === "group" && spare.layers.every((x) => x.id !== "word")).toBe(true);
    await write(d.id, { changes: [{ frame: "p1", layer: "spare", remove: true }] });
    // a layer inside is named by its id as any other, and moved out it stays where it is on the frame
    const out = (await write(d.id, { changes: [{ frame: "p1", layer: "word", set: { color: "#ff0000" } }, { frame: "p1", layer: "star", in: "frame" }] })).body;
    expect(out.notes).toEqual([]);
    const [box, star] = out.design.pages[0]!.layers;
    expect(star).toMatchObject({ id: "star", x: 110, y: 210 });
    expect(box!.type === "group" && box!.layers.map((l) => [l.id, l.type === "text" && l.color])).toEqual([["word", "#ff0000"]]);
    // a group of two plain layers taken apart: they stay where they were
    const grouped = (await write(d.id, { changes: [{ frame: "p1", add: { type: "group", x: 0, y: 0, w: 1, h: 1, layers: [] }, as: "pair" }, { frame: "p1", layer: "star", in: "pair" }, { frame: "p1", layer: g.id, in: "pair" }] })).body;
    expect(grouped.notes).toEqual([]);
    const pair = grouped.design.pages[0]!.layers[0]!;
    expect(pair).toMatchObject({ type: "group", x: 100, y: 200, w: 300, h: 80 });
    const apart = (await write(d.id, { changes: [{ frame: "p1", layer: pair.id, ungroup: true }, { frame: "p1", layer: "nope", in: "frame" }, { frame: "p1", layer: "star", in: "star" }] })).body;
    expect(apart.design.pages[0]!.layers.map((l) => [l.id, l.x, l.y])).toEqual([["star", 110, 210], [g.id, 100, 200]]);
    expect(apart.notes).toEqual(["changes[1], frame p1 (Frame 1): there is no layer nope: its layers are star, " + g.id + ", word", 'changes[2], frame p1 (Frame 1): "in" names no group of this frame (star): give a group layer\'s id, or "frame" for the frame\'s own layers']);
  });

  it("never lets layers added into groups push a frame past its limit, rename a layer there, or a deep answer break the call", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const sq = (id: string | undefined, x = 0) => ({ ...(id ? { id } : {}), type: "shape", shape: "rect", fill: "#ff0000", x, y: 0, w: 10, h: 10 });
    const ids = Array.from({ length: 35 }, (_, n) => `r${n + 1}`);
    await write(d.id, { frames: [{ id: "p1", layers: [{ id: "g", type: "group", layers: [sq("x")] }, ...ids.slice(1).map((id, n) => sq(id, n))] }] });
    // a group of ten at the back of a frame of 35: refused whole, the frontmost layers kept
    const back = (await write(d.id, { changes: [{ frame: "p1", at: "back", add: { type: "group", layers: Array.from({ length: 10 }, () => sq(undefined)) } }] })).body;
    expect(back.notes).toEqual(["changes[0], frame p1 (Frame 1): a frame holds at most 40 layers, counting those inside groups: a layer was not added"]);
    expect(back.design.pages[0]!.layers.at(-1)!.id).toBe("r35");
    // a group's layers given whole: an id the frame uses already is not taken (that layer keeps its own), and no more than there is room for
    const set = (await write(d.id, { changes: [{ frame: "p1", layer: "g", set: { layers: [sq("r35"), sq("x", 20)] } }] })).body;
    expect(set.notes).toEqual([]);
    const g = set.design.pages[0]!.layers[0]!;
    expect(g.type === "group" && g.layers.map((l) => l.id)).toEqual([expect.not.stringMatching(/^r35$/), "x"]);
    expect(set.design.pages[0]!.layers.at(-1)!.id).toBe("r35");
    const full = (await write(d.id, { changes: [{ frame: "p1", layer: "g", set: { layers: Array.from({ length: 8 }, () => sq(undefined)) } }] })).body;
    expect(full.notes).toEqual(["changes[0], frame p1 (Frame 1), layer g: a frame holds at most 40 layers, counting those inside groups: its layers were not changed"]);
    expect(full.design.pages[0]!.layers[0]!.type === "group" && (full.design.pages[0]!.layers[0] as { layers: unknown[] }).layers).toHaveLength(2);
    // a group nested far deeper than groups go: a note, never a broken call
    let deep: object = sq("bottom");
    for (let n = 0; n < 2000; n++) deep = { type: "group", layers: [deep] };
    const blank = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const res = await write(blank.id, { changes: [{ frame: "p1", add: deep }] });
    expect(res.status).toBe(200);
    expect(res.body.notes.some((n) => n.endsWith("groups go at most 4 deep: one deeper left out"))).toBe(true);
  });

  it("takes a hidden or locked group apart with its layers kept hidden or locked", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const sq = (id: string, x: number) => ({ id, type: "shape", shape: "rect", fill: "#ff0000", x, y: 0, w: 10, h: 10 });
    await write(d.id, { changes: [{ frame: "p1", add: { id: "g", type: "group", hidden: true, locked: true, opacity: 0.5, layers: [sq("a", 0), sq("b", 20)] } }] });
    const out = (await write(d.id, { changes: [{ frame: "p1", layer: "g", ungroup: true }] })).body;
    expect(out.design.pages[0]!.layers.map((l) => [l.id, l.hidden, l.locked, l.opacity])).toEqual([["a", true, true, 0.5], ["b", true, true, 0.5]]);
  });

  it("says what a save by hand could not keep, past a frame's limit, beside the design it saved", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const many = Array.from({ length: 41 }, (_, n) => ({ type: "shape", shape: "rect", fill: "#ff0000", x: n, y: 0, w: 10, h: 10 }));
    const res = await call<Design & { notes?: string[] }>("PUT", `/api/designs/${d.id}`, { pages: [{ ...d.pages[0], layers: many }] });
    expect(res.body.pages[0]!.layers).toHaveLength(40);
    expect(res.body.notes).toEqual(["Page 1: a frame holds at most 40 layers, counting those inside groups: the rest left out"]);
    const fine = await call<Design & { notes?: string[] }>("PUT", `/api/designs/${d.id}`, { pages: res.body.pages });
    expect(fine.body).not.toHaveProperty("notes");
  });

  it("names a new frame or layer with as for the changes after it in the same call, and leads each note with the change it is about", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const rect = { type: "shape", shape: "rect", fill: "#ff0000", x: 0, y: 0, w: 100, h: 100 };
    const out = (await write(d.id, {
      frames: [{ as: "two", w: 1080, h: 1920, name: "Story", layers: [] }],
      changes: [
        { frame: "p1", add: { ...rect, id: "badge" } },
        { frame: "two", add: rect, as: "Badge" },
        { frame: "two", layer: "Badge", set: { fill: "#00ff00" } },
        { frame: "two", add: { type: "rect", x: 0 } },
        { frame: "p1", add: { ...rect, id: "badge" }, as: "badge" },
        { frame: "p1", layer: "badge", set: { fill: "#0000ff" } },
      ],
    })).body as Wrote & { named: Record<string, string> };
    const two = out.named.two!;
    const [one, story] = out.design.pages;
    expect(story).toMatchObject({ id: two, name: "Story", w: 1080, h: 1920 });
    // "Badge" cannot be an id: it became l1, and the change after it found it by its name
    expect(story!.layers).toMatchObject([{ id: "l1", fill: "#00ff00" }]);
    expect(out.named).toEqual({ two, Badge: "l1", badge: "l2" });
    // the second "badge" of p1 took another id; a change naming "badge" changes the layer whose id it is, never the new one
    expect(one!.layers).toMatchObject([{ id: "badge", fill: "#0000ff" }, { id: "l2", fill: "#ff0000" }]);
    expect(out.notes).toEqual([`changes[3], frame ${two} (Frame 2): a layer of no type that can be drawn ("rect"): left out; the types are text, shape, path, image, drawing and group`]);
    // the same in one call with a move onto the canvas and copies: a moved layer is found where it went by its name,
    // and "fill" copies a frame the call made, by its "as"
    const more = (await write(d.id, {
      frames: [{ as: "card", w: 1080, h: 1080, name: "Card", layers: [{ ...rect, name: "Ground" }] }],
      changes: [{ frame: "p1", layer: "badge", to: "canvas" }, { frame: "canvas", layer: "badge", set: { fill: "#123456" } }, { frame: "card", add: { type: "video" } }],
      fill: { frame: "card", rows: [{ name: "Card copy" }] },
    })).body as Wrote & { named: Record<string, string> };
    expect(more.design.pages.filter((p) => !p.loose).map((p) => p.name)).toEqual([undefined, "Story", "Card", "Card copy"]);
    expect((await read(d.id)).canvas).toEqual([expect.objectContaining({ id: "badge", fill: "#123456" })]);
    expect(more.notes).toEqual([`changes[2], frame ${more.named.card} (Frame 3): a layer of no type that can be drawn ("video"): left out; the types are text, shape, path, image, drawing and group`]);
  });

  it("a layer moved into a frame that has its id takes another: a later change naming that id changes the frame's own layer", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const box = { type: "shape", shape: "rect", w: 100, h: 50, x: 0, y: 0 };
    await call("PUT", `/api/designs/${d.id}`, { pages: [{ id: "p1", x: 0, y: 0, w: 1080, h: 1080, background: "#ffffff", layers: [{ ...box, id: "l1", fill: "#ff0000" }] }, { id: "pa", loose: true, x: -500, y: 100, w: 100, h: 50, background: "#ffffff", layers: [{ ...box, id: "l1", fill: "#0000ff" }] }] });
    const out = (await write(d.id, { changes: [{ frame: "canvas", layer: "l1", to: "p1" }, { frame: "p1", layer: "l1", set: { fill: "#00ff00" } }] })).body;
    expect(out.design.pages.find((p) => p.id === "p1")!.layers).toMatchObject([{ id: "l1", fill: "#00ff00" }, { id: "l2", fill: "#0000ff" }]);
  });

  it("a new frame named with an existing frame's id leaves that id naming the existing frame", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const out = (await write(d.id, { frames: [{ as: "p1", background: "#000000", layers: [] }], changes: [{ frame: "p1", add: { type: "shape", shape: "rect", fill: "#ff0000", x: 0, y: 0, w: 100, h: 100, id: "box" } }] })).body;
    expect(out.notes).toEqual([expect.stringContaining('"as" p1 is already a frame\'s id')]);
    const pages = (await call<Design>("GET", `/api/designs/${d.id}`)).body.pages;
    expect(pages.find((p) => p.id === "p1")!.layers.map((l) => l.id)).toEqual(["box"]);
    expect(pages.find((p) => p.id !== "p1")!.layers).toEqual([]);
  });

  it("a text moved onto a slide's frame that is not in its words stays where it was, and the AI is told", async () => {
    const d = await fromPiece();
    const put = (await write(d.id, { changes: [{ frame: "canvas", add: { ...text, x: 4000, text: "Save 20%" }, as: "sale" }] })).body as Wrote & { named: Record<string, string> };
    const id = put.named.sale ?? "sale";
    const out = await write(d.id, { changes: [{ frame: "canvas", layer: id, to: "p3" }, { frame: "p1", layer: "l1", to: "p3" }] });
    expect(out.status).toBe(200);
    expect(out.body.notes).toEqual([`changes[0], the canvas, layer ${id}: “Save 20%” is not in frame p3's own words: it stays where it is`, "changes[1], frame p1 (Frame 1), layer l1: “Roll the mat out” is not in frame p3's own words: it stays where it is"]);
    expect((await read(d.id)).canvas).toEqual([expect.objectContaining({ id, text: "Save 20%" })]);
    const pages = (await call<Design>("GET", `/api/designs/${d.id}`)).body.pages;
    expect(pages[0]!.layers).toEqual(d.pages[0]!.layers);
    expect(pages[2]!.layers).toEqual(d.pages[2]!.layers);
  });

  it("frames and changes saved before copies that cannot be made stay saved, and the answer says why there are no copies", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const out = await write(d.id, { changes: [{ frame: "p1", add: { type: "shape", shape: "rect", fill: "#ff0000", x: 0, y: 0, w: 100, h: 100, id: "box" } }], fill: { frame: "nope", rows: [{}] } });
    expect(out.status).toBe(200);
    expect(out.body.touched).toEqual(["p1"]);
    expect(out.body.notes).toEqual([expect.stringContaining("No copy was made: fill.frame:")]);
    expect((await call<Design>("GET", `/api/designs/${d.id}`)).body.pages[0]!.layers.map((l) => l.id)).toEqual(["box"]);
  });

  it("a call with thousands of sizes or rows is read only as far as a design can hold", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const out = await write(d.id, { sizes: { to: Array.from({ length: 5000 }, () => "huge") }, fill: { frame: "p1", rows: Array.from({ length: 5000 }, (_, n) => ({ Nope: String(n) })) } });
    expect(out.status).toBe(200);
    expect(out.body.notes.filter((n) => n.startsWith("sizes.to["))).toHaveLength(20);
    expect(out.body.touched).toHaveLength(19);
  });

  it("layers lying on the canvas outside every frame: seen, added, changed, moved into a frame and out, removed, each checked", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const box = { type: "shape", shape: "rect", fill: "#ff5500", w: 100, h: 50 };
    // a person's loose piece (one dragged out of a frame), and a frame that shows what lies past its edges
    await call("PUT", `/api/designs/${d.id}`, { pages: [{ id: "p1", x: 0, y: 0, w: 1080, h: 1080, clip: false, background: "#ffffff", layers: [] }, { id: "pa", loose: true, x: -500, y: 100, w: 100, h: 50, background: "#ffffff", layers: [{ ...box, id: "l1", x: 0, y: 0 }] }] });
    const seen = await read(d.id);
    expect(seen.frames).toEqual([expect.objectContaining({ id: "p1", x: 0, y: 0, clip: false })]);
    expect(seen.canvas).toEqual([expect.objectContaining({ id: "l1", type: "shape", x: -500, y: 100 })]);
    expect(seen.how).toContain('"frame":"canvas"');
    // added on the canvas, in its pixels; a value out of range is held like a frame's; a bad "to" and a missing layer are named
    const added = (await write(d.id, { changes: [{ frame: "canvas", add: { ...box, id: "note", x: 2000, y: -300, fill: "nope", opacity: 7 } }, { frame: "canvas", layer: "l1", to: "p9" }, { frame: "canvas", layer: "ghost", remove: true }] })).body;
    expect(added.notes).toEqual(['changes[1], the canvas: "to" names no frame of this design (p9): give a frame\'s id or "canvas"', "changes[2], the canvas: there is no layer ghost: its layers are l1, note"]);
    const note = added.design.pages.find((p) => p.loose && p.layers.some((l) => l.id === "note"))!;
    expect(note).toMatchObject({ loose: true, x: 2000, y: -300, w: 100, h: 50, layers: [{ id: "note", x: 0, y: 0, fill: "#dddddd" }] });
    expect(note.layers[0]).not.toHaveProperty("opacity");
    expect(added.wrote).toEqual([{ frame: "canvas", isNew: false, layers: ["note"] }]);
    // moved into the frame: where it was on the canvas, now in the frame's pixels, then placed by the same change's set
    const moved = (await write(d.id, { changes: [{ frame: "canvas", layer: "l1", to: "p1", set: { y: 40 } }] })).body;
    expect(moved.design.pages.find((p) => p.id === "p1")!.layers).toEqual([expect.objectContaining({ id: "l1", x: -500, y: 40 })]);
    // the piece it lay in is gone with it; the other one stays as it was
    expect(moved.design.pages.filter((p) => p.loose).map((p) => p.id)).toEqual([note.id]);
    // and out again onto the canvas, from the frame's pixels to the canvas's
    const out = (await write(d.id, { changes: [{ frame: "p1", layer: "l1", to: "canvas" }, { frame: "canvas", layer: "note", set: { fill: "#00ff00" } }] })).body;
    const back = (await read(d.id)).canvas as { id: string; x: number; y: number; fill: string }[];
    expect(back.map((l) => [l.id, l.x, l.y, l.fill])).toEqual([["note", 2000, -300, "#00ff00"], ["l1", -500, 40, "#ff5500"]]);
    expect(out.design.pages.find((p) => p.id === "p1")!.layers).toEqual([]);
    // removed: its piece is gone; the frame's clip is the AI's to set too
    const gone = (await write(d.id, { changes: [{ frame: "canvas", layer: "note", remove: true }, { frame: "canvas", layer: "l1", remove: true }], frames: [{ id: "p1", clip: true }] })).body;
    expect(gone.design.pages).toEqual([expect.not.objectContaining({ clip: false })]);
    expect((await read(d.id)).canvas).toBeUndefined();
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

  it("an AI gives a frame its finish without sending its layers again, reads it back, and blurs a layer with a change", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    await write(d.id, { frames: [{ id: "p1", background: "#1a0b2e", layers: [{ id: "sun", type: "shape", shape: "ellipse", fill: "#ffcc66", x: 300, y: 300, w: 400, h: 400 }] }] });
    const out = (await write(d.id, { frames: [{ id: "p1", grain: 35, vignette: 40 }], changes: [{ frame: "p1", layer: "sun", set: { blur: 60 } }] })).body;
    expect(out.design.pages[0]).toMatchObject({ background: "#1a0b2e", grain: 35, vignette: 40, layers: [{ id: "sun", blur: 60, fill: "#ffcc66" }] });
    const got = await read(d.id);
    expect(got.frames[0]).toMatchObject({ grain: 35, vignette: 40 });
    expect(got.how).toContain('"grain" (0 to 100) lays a film grain over the whole frame');
    expect(got.how).toContain('"blur" (pixels, up to 200');
    // taken off again with 0, and the layers stay
    const off = (await write(d.id, { frames: [{ id: "p1", grain: 0 }] })).body.design.pages[0]!;
    expect(off).not.toHaveProperty("grain");
    expect([off.vignette, off.layers.length]).toEqual([40, 1]);
  });

  it("an AI gives a layer a list of effects with a change, is told how, and the old shadow stands for one until then", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    await write(d.id, { frames: [{ id: "p1", background: "#1a0b2e", layers: [{ id: "card", type: "shape", shape: "rect", fill: "#ffffff", opacity: 0.3, x: 100, y: 600, w: 880, h: 300, shadow: { color: "#000000", opacity: 0.4, blur: 20, x: 0, y: 10 } }] }] });
    const fx = [{ type: "background-blur", blur: 30 }, { type: "shadow", color: "#000000", opacity: 0.2, blur: 6, x: 0, y: 3, spread: -2 }, { type: "noise", amount: 8, size: 2, hidden: true }];
    const out = (await write(d.id, { changes: [{ frame: "p1", layer: "card", set: { effects: fx } }] })).body;
    const card = out.design.pages[0]!.layers[0]!;
    expect(card.effects).toEqual(fx);
    expect(card).not.toHaveProperty("shadow");
    // a list is replaced whole by the next change
    const one = (await write(d.id, { changes: [{ frame: "p1", layer: "card", set: { effects: [{ type: "blur", blur: 12 }] } }] })).body.design.pages[0]!.layers[0]!;
    expect(one.effects).toEqual([{ type: "blur", blur: 12 }]);
    const got = await read(d.id);
    expect(got.how).toContain('{"type":"background-blur","blur":30} blurs what lies under it');
  });

  it("an AI lays a highlighter stroke behind words of a text, is told how, and takes it off again", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const line = { id: "line", type: "text", text: "They need the floor.", font: "Inter", size: 80, color: "#14181c", align: "left", x: 80, y: 80, w: 900, h: 300 };
    const out = (await write(d.id, { frames: [{ id: "p1", background: "#f6f1e7", layers: [{ ...line, marks: [{ words: "the floor", color: "#F2B63C" }] }] }] })).body;
    expect(out.design.pages[0]!.layers[0]).toMatchObject({ id: "line", marks: [{ words: "the floor", color: "#f2b63c" }] });
    const got = await read(d.id);
    expect(got.frames[0]!.layers[0]).toMatchObject({ marks: [{ words: "the floor", color: "#f2b63c" }] });
    expect(got.how).toContain('"marks":[{"words":"the floor","color":"#f2b63c"}] lays a highlighter stroke behind those words');
    const off = (await write(d.id, { changes: [{ frame: "p1", layer: "line", set: { marks: [] } }] })).body.design.pages[0]!.layers[0]!;
    expect(off).not.toHaveProperty("marks");
    expect(off).toMatchObject({ text: "They need the floor." });
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

  /** A style of the person's with pictures, written as its own files are: one made and liked, then inspirations. */
  const styleWith = (who: string, name: string, brief: string, ids: string[], kind: "carousel" | "animation" = "carousel") => {
    const style = createAnimation(who, { name, brief }, kind);
    if (typeof style === "string") throw new Error(style);
    for (const [n, id] of ids.entries()) {
      change(who, (f) => void f[kind]!.find((s) => s.id === style.id)!.pictures.push({ id, kind: n ? "inspiration" : "made", at: n ? 1 : 2 }));
      const file = pictureFile(who, style.id, id)!;
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    return style;
  };

  it("a cover's words are what the chat asks for; the person's looks come as their own words, and a look's pictures when it is asked for by name", async () => {
    styleWith("jordan", "Paper cut", "Torn paper edges, one loud colour.", ["11111111-0000-4000-8000-000000000001", "22222222-0000-4000-8000-000000000002"]);
    const d = (await call<Design>("POST", "/api/designs", { format: "thumbnail", version: "ver_v", t: 1, title: "Floor time" })).body;
    const got = await read(d.id);
    expect(got.frames[0]).not.toHaveProperty("words");
    expect(got.pictures).toEqual([{ id: d.pictures[0], what: "the video's own frame" }]);
    expect(got.looks).toContainEqual({ name: "Paper cut", kind: "carousel style", brief: "Torn paper edges, one loud colour.", pictures: 2 });
    // the person's one carousel style comes with its pictures unasked: an AI that never asks for a look still designs from it
    expect(typeof got.look === "object" && [got.look.name, got.look.pictures.map((p) => p.what)]).toEqual(["Paper cut", ["a picture the user made and liked in this look", "an inspiration for this look"]]);
    expect(got.how).toContain('A "carousel style" is made for these frames: design in one of them.');
    expect(typeof got.look === "object" && got.look.brief).toBe("Torn paper edges, one loud colour.");
    expect(got.how).toContain("design in rounds, never in one pass");
    expect(got.how).toContain("make that change alone");
    const withLook = await read(d.id, "?look=paper%20cut");
    expect(typeof withLook.look === "object" && withLook.look.pictures.map((p) => p.what)).toEqual(["a picture the user made and liked in this look", "an inspiration for this look"]);
    expect((await read(d.id, "?look=Nope")).look).toBe("There is no look called Nope");
    const out = (await write(d.id, { frames: [{ id: "p1", layers: [{ type: "image", picture: d.pictures[0], fit: "cover", x: 0, y: 0, w: 1280, h: 720 }, { ...text, text: "3 MISTAKES" }, { type: "image", picture: "ffffffff.png", x: 0, y: 0, w: 10, h: 10 }] }] })).body;
    expect(out.design.pages[0]!.layers).toMatchObject([{ type: "image" }, { type: "text", text: "3 MISTAKES" }]);
    expect(out.notes).toEqual(["frames[0].layers[2], frame p1 (Frame 1): a picture that is not in this design: left out"]);
  });

  it("with several carousel styles the AI is told to pick one and read it first; animation styles and a plug-in's own looks are listed after, read when named, their pictures made small", async () => {
    styleWith("jordan", "Soft clay", "Rounded shapes, pastel.", ["33333333-0000-4000-8000-000000000003"]);
    // an animation style with pictures is never the one picked unasked here
    styleWith("jordan", "Big reveal", "Numbers count up.", ["44444444-0000-4000-8000-000000000004"], "animation");
    const { Hono } = await import("hono");
    const { definePlugin, mountPlugins } = await import("./lib/plugin");
    // a studio's guide runs long, and what the person likes and hates comes after its first lines
    const TINY = `Everything hangs on threads. ${"Pieces come down slowly and settle. ".repeat(20)}What they hate: a grey wall.`;
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
              { name: "Tiny Mobile", brief: TINY, pictures: [{ file: path.join(dataDir, "gone.png"), made: false }, { file: big, made: true }] },
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
      expect(got.looks).toEqual([
        { name: "Paper cut", kind: "carousel style", brief: "Torn paper edges, one loud colour.", pictures: 2 },
        { name: "Soft clay", kind: "carousel style", brief: "Rounded shapes, pastel.", pictures: 1 },
        { name: "Big reveal", kind: "animation style", brief: "Numbers count up.", pictures: 1 },
        { name: "Tiny Mobile", kind: "animation style", brief: TINY.slice(0, 600), pictures: 2 },
      ]);
      // two carousel styles with pictures: none is shown unasked, and the answer says to pick one of those
      expect(got.look).toBe('Pick the carousel style this design is in ("Paper cut", "Soft clay"; ask the user when it is not clear) and read its pictures before you design: design_get with "look": its name.');
      // the plug-in's look by name: the picture it made first, as a small JPEG; the file that is gone is left out
      const tiny = (await read(d.id, "?look=tiny%20mobile")).look;
      if (typeof tiny !== "object") throw new Error(String(tiny));
      // the look it designs in comes with all its words: the list of looks has only their start
      expect(tiny.brief).toBe(TINY);
      expect(TINY.slice(0, 600)).not.toContain("a grey wall");
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

  it("with no carousel style the AI is sent to the carousels saved in the Content Analyzer, then to an animation style; the two lists are kept apart", async () => {
    const lookOf = async () => {
      const d = (await call<Design>("POST", "/api/designs", { format: "portrait", blank: true }, "robin")).body;
      return (await call<Read>("GET", `/api/designs/${d.id}/pages`, undefined, "robin")).body;
    };
    // nothing at all: the Analyzer, and where carousel styles are kept
    const bare = await lookOf();
    expect(bare.looks).toEqual([]);
    expect(bare.look).toBe('The user has no carousel style yet. Before you design, look at carousels they saved in the Content Analyzer: instagram_search with "kind":"carousel" (with words of this design\'s subject, or none for the most watched), then instagram_post with "pictures":true for two or three that fit what they asked; carry their finish into the frames, never their words or one of them copied. The user keeps carousel styles in the Designer (Carousel styles).');
    // an animation style with pictures, and a carousel style with neither words nor pictures: the animation style is the one after the Analyzer
    styleWith("robin", "Night card", "White on deep blue.", ["55555555-0000-4000-8000-000000000005"], "animation");
    const empty = styleWith("robin", "Empty yet", "", []);
    const after = await lookOf();
    expect(after.look).toContain('With none saved, design in one of their animation styles ("Night card": design_get with "look": its name)');
    expect(after.looks.map((l) => [l.name, l.kind])).toEqual([["Empty yet", "carousel style"], ["Night card", "animation style"]]);
    // a carousel style of words alone is the one: all its words, and the Analyzer for pictures
    const GUIDE = `Cream paper and one loud word. ${"Lots of empty space, nothing glossy. ".repeat(30)}What they hate: drop shadows.`;
    change("robin", (f) => void (f.carousel!.find((s) => s.id === empty.id)!.brief = GUIDE));
    const words = (await lookOf()).look;
    if (typeof words !== "object") throw new Error(String(words));
    expect([words.name, words.brief, words.pictures]).toEqual(["Empty yet", GUIDE, []]);
    expect((words as { more?: string }).more).toMatch(/^It has no pictures yet\. Before you design, look at carousels they saved in the Content Analyzer/);
    // the carousel style is not among the animation styles, nor the other way round
    expect((await call<{ styles: Array<{ name: string }> }>("GET", "/api/designs/styles", undefined, "robin")).body.styles.map((s) => s.name)).toEqual(["Empty yet"]);
    const { animationStyles } = await import("./editor/animation-styles");
    expect(animationStyles("robin").map((s) => s.name)).toEqual(["Night card"]);
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
    else cutoutSent(mac.id, job!.id, { cutout: out });
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

describe("designs: a picture split into layers", () => {
  const png = (w: number, h: number, colour = "red") => execFileSync(ffmpegCommand(), ["-v", "error", "-f", "lavfi", "-i", `color=c=${colour}:s=${w}x${h}`, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"]);
  const line = { text: "Floor first.", x: 0.08, y: 0.16, w: 0.67, h: 0.09, color: "#ffffff", ink: 0.27 };

  it("keeps what the Mac made as pictures of the design and answers the lines; a layout it cannot read fails in words", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "portrait", blank: true })).body;
    const first = (await call<{ id: string }>("POST", `/api/designs/${d.id}/pictures`, { name: "slide", type: "image/png", data: png(108, 135, "navy").toString("base64") })).body.id;
    // a Mac of robin's that is paired and not on: named, with its id, so the page can say so
    const robins = (await call<Design>("POST", "/api/designs", { format: "portrait", blank: true }, "robin")).body;
    const robinPic = (await call<{ id: string }>("POST", `/api/designs/${robins.id}/pictures`, { name: "slide", type: "image/png", data: png(108, 135).toString("base64") }, "robin")).body.id;
    const away = pairDevice("robin", "Robin's Mac Studio").device;
    const off = await call<{ error: string; code: string; device: unknown }>("POST", `/api/designs/${robins.id}/pictures/${robinPic}/split`, {}, "robin");
    expect([off.status, off.body]).toEqual([400, { error: "Robin's Mac Studio hasn't answered yet", code: "no_mac", device: { id: away.id, name: "Robin's Mac Studio" } }]);
    const mac = pairDevice("jordan", "Jordan's split Mac").device;
    // a Mac that cuts out but does not split has an app older than the split
    setDeviceKinds(mac.id, [CUTOUT_KIND]);
    touchDevice(mac.id);
    const old = await call<{ error: string }>("POST", `/api/designs/${d.id}/pictures/${first}/split`, {});
    expect([old.status, old.body.error]).toEqual([400, "Needs the newest Creator Toolset Mac app"]);
    setDeviceKinds(mac.id, [CUTOUT_KIND, SPLIT_KIND]);
    const answer = async (form: Record<string, Buffer | string>) => {
      let job = null as ReturnType<typeof claimCutout>;
      for (let n = 0; n < 200 && !(job = claimCutout(mac, [CUTOUT_KIND, SPLIT_KIND])); n++) await new Promise((r) => setTimeout(r, 10));
      expect(job!.kind).toBe(SPLIT_KIND);
      expect(heldCutout(mac.id, job!.id)!.mime).toBe("image/png");
      return cutoutSent(mac.id, job!.id, form);
    };
    const asked = call<SplitAnswer>("POST", `/api/designs/${d.id}/pictures/${first}/split`, {});
    const [bg, piece] = [png(108, 135, "navy"), png(20, 20, "yellow")];
    expect(await answer({ layout: JSON.stringify({ lines: [line], pieces: [{ x: 0.5, y: 0.6, w: 0.2, h: 0.15 }] }), background: bg, piece0: piece })).toBeNull();
    const made = await asked;
    expect(made.status).toBe(200);
    expect(made.body.lines).toEqual([line]);
    expect(made.body.pieces).toEqual([{ x: 0.5, y: 0.6, w: 0.2, h: 0.15, picture: expect.stringMatching(/^[0-9a-f]{8}\.png$/) }]);
    expect((await call<Design>("GET", `/api/designs/${d.id}`)).body.pictures).toEqual([first, made.body.background, made.body.pieces[0]!.picture]);
    as = "jordan";
    expect(Buffer.from(await (await app.request(`/api/designs/${d.id}/pictures/${made.body.pieces[0]!.picture}`)).arrayBuffer()).equals(piece)).toBe(true);

    // a line with a box outside the picture or a colour that is none is left out, and lines past the cap: the rest stands
    const many = call<SplitAnswer>("POST", `/api/designs/${d.id}/pictures/${first}/split`, {});
    const lines = [{ ...line, x: 1.4 }, { ...line, color: "white" }, ...Array.from({ length: 61 }, (_, n) => ({ ...line, text: `Line ${n + 1}` }))];
    expect(await answer({ layout: JSON.stringify({ lines, pieces: [] }), background: bg })).toBeNull();
    expect((await many).body.lines.map((l) => l.text)).toEqual(Array.from({ length: 60 }, (_, n) => `Line ${n + 1}`));
    // a piece the layout names and the form lacks, or no layout: refused, nothing kept
    for (const form of [{ layout: JSON.stringify({ lines: [], pieces: [{ x: 0, y: 0, w: 1, h: 1 }] }), background: bg }, { layout: "not json", background: bg }]) {
      const refused = call<{ error: string }>("POST", `/api/designs/${d.id}/pictures/${first}/split`, {});
      expect(await answer(form)).toMatch(/^Your Mac sent no/);
      expect((await refused).body.error).toMatch(/^Your Mac sent no/);
    }
    expect((await call<Design>("GET", `/api/designs/${d.id}`)).body.pictures).toHaveLength(4);
  }, 60_000);
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
  // each workspace lists its own designs (the window's, as the app's header says)
  const list = (inWs: string) => workspaceScope.run({ id: inWs }, async () => (await call<DesignListed[]>("GET", "/api/designs")).body);

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

    const [brand, other] = [await list(BRAND), await list(OTHER)];
    const ids = (l: DesignListed[]) => l.map((d) => d.id);
    expect(ids(other)).toEqual(expect.arrayContaining([ofPiece.id, own.id]));
    expect(ids(brand)).toEqual(expect.arrayContaining([ofVideo.id, notMine.id, unsaid.id]));
    expect(ids(brand)).not.toContain(ofPiece.id);
    const all = [...brand, ...other];
    const of = (id: string) => all.find((d) => d.id === id)!;
    expect(of(ofPiece.id)).toMatchObject({ madeFrom: "Tiny Acrobatics floor time", project: OTHER, projectName: "Healthy Homes", from: { session: SESSION, doc: DOC } });
    expect(of(ofVideo.id)).toMatchObject({ madeFrom: "Tiny Acrobatics take", projectName: "Tiny Acrobatics" });
    expect(of(own.id)).toMatchObject({ projectName: "Healthy Homes" });
    expect(of(own.id)).not.toHaveProperty("madeFrom");
    expect(of(notMine.id).projectName).toBe("Tiny Acrobatics");
    // the script moved to the other project: its design follows it at the next list
    writeFileSync(ws("sessions", SESSION, "meta.json"), JSON.stringify({ id: SESSION, owner: "jordan", title: "Floor time", projectId: BRAND, query: "", sources: [], drafts: [], createdAt: 1, updatedAt: 1 }));
    expect((await list(BRAND)).find((d) => d.id === ofPiece.id)).toMatchObject({ project: BRAND, projectName: "Tiny Acrobatics" });
    expect(ids(await list(OTHER))).not.toContain(ofPiece.id);
    // another account's list has none of it
    expect((await call<DesignListed[]>("GET", "/api/designs", undefined, "robin")).body).toEqual([]);
  });

  it("a design whose script, video or project is gone is still listed, without what is gone", async () => {
    const before = [...(await list(BRAND)), ...(await list(OTHER))];
    const ofPiece = before.find((d) => d.madeFrom === "Tiny Acrobatics floor time")!;
    const ofVideo = before.find((d) => d.madeFrom === "Tiny Acrobatics take")!;
    rmSync(ws("sessions", SESSION), { recursive: true, force: true });
    libraryDb().exec("DELETE FROM asset_versions WHERE id = 'ver_v'");
    rmSync(ws("projects", `${OTHER}.json`));
    // what was in the workspace that is gone is the first brand's now
    const res = await workspaceScope.run({ id: BRAND }, () => call<DesignListed[]>("GET", "/api/designs"));
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
