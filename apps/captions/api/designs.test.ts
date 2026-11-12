import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Design, DesignAnswer, DesignSummary } from "../contracts/design";

vi.mock("./ai-complete", async (real) => {
  const m = await real<typeof import("./ai-complete")>();
  return { ...m, aiFor: vi.fn(m.aiFor), completeWithFallback: vi.fn(m.completeWithFallback) };
});
vi.mock("./ai-vision", async (real) => ({ ...(await real<typeof import("./ai-vision")>()), completeVisionWithFallback: vi.fn() }));

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "designs-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = "designs-test-secret";

const { Hono } = await import("hono");
const { aiFor, completeWithFallback } = await import("./ai-complete");
const { completeVisionWithFallback } = await import("./ai-vision");
const { DESIGN_SYSTEM, designPrompt, designsApp, parseDesign } = await import("./designs");
const { createAnimation, pictureFile } = await import("./editor/animation-styles");
const { change } = await import("./editor/styles");
const { ffmpegCommand } = await import("./ffmpeg-runtime");
const { blobs, libraryDb } = await import("./library/db");
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
const aiAnswers = (pages: unknown) => {
  vi.mocked(aiFor).mockReturnValueOnce({ only: ["anthropic"], apiKey: "test", mac: { label: "Designer" } });
  vi.mocked(completeWithFallback).mockImplementationOnce(async (_s, _u, _c, parse) => parse(JSON.stringify({ pages })));
};

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
    for (const [m, u] of [["GET", ""], ["PUT", ""], ["DELETE", ""], ["POST", "/design"], ["POST", "/pictures"]] as const) expect((await call(m, `/api/designs/${d.id}${u}`, m === "GET" || m === "DELETE" ? undefined : {}, "robin")).status, `${m} ${u}`).toBe(404);
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
    expect((await call("PUT", `/api/designs/${d.id}`, { pages: [] })).body).toEqual({ error: "A design keeps at least one page" });
    expect((await call<Design>("GET", `/api/designs/${d.id}`)).body.pages[0]!.background).toBe("#ffe08a");
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

describe("designs: the person's AI designs the pages", () => {
  it("asks for the task and the answer's shape: the size, the fonts, the look, the notes, the pictures and each page's own words", () => {
    const { system, user } = designPrompt({ kind: "carousel", w: 1080, h: 1350, pages: ["Roll the mat out", "Try it today"], look: { name: "Playmat", brief: "Foam tiles, sticker letters.", made: 2, inspirations: 3 }, notes: "Big type.", pictures: [{ id: "ab12cd34.jpg", what: "a picture the author added" }] });
    expect(system).toBe(DESIGN_SYSTEM);
    expect(user).toContain("A carousel of 2 slides. Each page is 1080 × 1350 pixels.");
    expect(user).toContain('Fonts: "Anton", "Archivo Black"');
    expect(user).toContain('The look: "Playmat", in the author\'s own words:\nFoam tiles, sticker letters.\nThe pictures with this message show that look: the first 2 are ones the author made and liked, the rest are inspirations.');
    expect(user).toContain("Notes from the author:\nBig type.");
    expect(user).toContain("Pictures:\nab12cd34.jpg = a picture the author added");
    expect(user).toContain("--- page 1 ---\nRoll the mat out\n--- page 2 ---\nTry it today");
    const bare = designPrompt({ kind: "cover", w: 1080, h: 1920, pages: ["Floor time"], pictures: [] }).user;
    expect(bare).toContain("A video's cover. Each page is 1080 × 1920 pixels.");
    expect(bare).toContain("The look: none picked.");
    expect(bare).toContain("Pictures:\n(none)");
    expect(bare).not.toContain("Notes from the author");
    expect(() => parseDesign('{"pages":[]}')).toThrow("The AI's answer has no pages");
  });

  it("in words alone when no look is picked: the design is saved with the slides' words where the AI put them, and anything else it said is left out with a note", async () => {
    const d = await fromPiece();
    aiAnswers([
      { background: "#FFE08A", layers: [{ type: "shape", shape: "ellipse", x: 700, y: -100, w: 600, h: 600, fill: "#ff7a59" }, { type: "text", text: "ROLL THE MAT OUT", font: "Anton", size: 150, color: "#111111", align: "left", x: 80, y: 300, w: 900, h: 400 }, { type: "text", text: "On a soft floor, with you next to it.", font: "Inter", size: 48, color: "#111111", align: "left", x: 80, y: 760, w: 800, h: 200 }, { type: "text", text: "Swipe →", font: "Inter", size: 40, color: "#111111", align: "right", x: 700, y: 1240, w: 300, h: 60 }, { type: "drawing", x: 100, y: 1000, w: 200, h: 200, svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#111"/></svg>' }] },
      { background: "#111111", layers: [{ type: "text", text: "Then the ramp goes down", font: "Montserrat ExtraBold", size: 110, color: "#ffffff", align: "center", valign: "middle", x: 80, y: 200, w: 920, h: 900 }] },
      { background: "#ffffff", layers: [{ type: "drawing", x: 0, y: 0, w: 10, h: 10, svg: "<svg><script/></svg>" }] },
      { background: "#ffffff", layers: [{ type: "text", text: "A fourth page nobody asked for", x: 0, y: 0, w: 10, h: 10 }] },
    ]);
    const { status, body } = await call<DesignAnswer>("POST", `/api/designs/${d.id}/design`, { notes: "Big type." });
    expect(status).toBe(200);
    expect(vi.mocked(completeVisionWithFallback)).not.toHaveBeenCalled();
    const sent = vi.mocked(completeWithFallback).mock.calls.at(-1)!;
    expect(sent[0]).toBe(DESIGN_SYSTEM);
    expect(sent[1]).toContain("--- page 1 ---\nRoll the mat out\n\nOn a soft floor, with you next to it.\n--- page 2 ---\nThen the ramp goes down\n--- page 3 ---\nTry it today");
    expect(sent[1]).toContain("Notes from the author:\nBig type.");
    expect(body.design.pages).toHaveLength(3);
    expect(body.design.pages.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    expect(body.design.pages[0]!.layers.map((l) => l.type)).toEqual(["shape", "text", "text", "drawing"]);
    expect(body.design.pages[1]).toMatchObject({ background: "#111111" });
    // page 3's answer had nothing that could be drawn: it stays as it was
    expect(body.design.pages[2]).toEqual(d.pages[2]);
    expect(body.notes).toEqual(["Page 1: “Swipe →” is not in its own words: left out", "Page 3: a drawing that is not plain shapes: left out", "Page 3: nothing in the answer could be drawn, so it is as it was"]);
    expect((await call<Design>("GET", `/api/designs/${d.id}`)).body.pages).toEqual(body.design.pages);
  });

  it("with a look picked: its brief goes in the words and its pictures with the call, the made ones first; the design remembers the look", async () => {
    const style = createAnimation("jordan", { name: "Playmat", brief: "Foam tiles, sticker letters." });
    if (typeof style === "string") throw new Error(style);
    // two pictures of the style, written as the style's own files are
    for (const [id, kind] of [["11111111-0000-4000-8000-000000000001", "made"], ["22222222-0000-4000-8000-000000000002", "inspiration"]] as const) {
      change("jordan", (f) => void f.animation!.find((s) => s.id === style.id)!.pictures.push({ id, kind, at: kind === "made" ? 2 : 1 }));
      const file = pictureFile("jordan", style.id, id)!;
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    const d = await fromPiece();
    vi.mocked(completeVisionWithFallback).mockImplementationOnce((async (_s: string, _u: string, _i: unknown, _c: unknown, parse: (t: string) => unknown) => ({
      value: parse(JSON.stringify({ pages: slides.map((_, k) => ({ background: "#ffe08a", layers: [{ type: "text", text: ["Roll the mat out", "Then the ramp goes down", "Try it today"][k], font: "Anton", size: 120, color: "#111111", align: "left", x: 80, y: 200, w: 900, h: 600 }] })) })),
      provider: "Claude",
    })) as never);
    const { status, body } = await call<DesignAnswer>("POST", `/api/designs/${d.id}/design`, { look: style.id });
    expect(status).toBe(200);
    const sent = vi.mocked(completeVisionWithFallback).mock.calls.at(-1)!;
    expect(sent[1]).toContain('The look: "Playmat", in the author\'s own words:\nFoam tiles, sticker letters.\nThe pictures with this message show that look: the first 1 is one the author made and liked, the rest are inspirations.');
    expect(sent[2]).toHaveLength(2);
    expect(sent[6]).toMatchObject({ label: "Designer", job: "editor" });
    expect(body.design.look).toBe(style.id);
    expect(body.notes).toEqual([]);
    expect((await call("POST", `/api/designs/${d.id}/design`, { look: "nope" })).body).toEqual({ error: "That style is gone: pick another" });
  });

  it("says in words why nothing was designed: no AI, an answer that could not be read, an answer with nothing to draw; the design is as it was", async () => {
    const d = await fromPiece();
    vi.mocked(aiFor).mockReturnValueOnce({ only: [], off: "No AI for your account: add one in Settings → Providers" } as never);
    expect(await call("POST", `/api/designs/${d.id}/design`, {})).toEqual({ status: 400, body: { error: "No AI for your account: add one in Settings → Providers" } });
    vi.mocked(aiFor).mockReturnValueOnce({ only: ["anthropic"], apiKey: "test", mac: { label: "Designer" } });
    vi.mocked(completeWithFallback).mockRejectedValueOnce(new Error("The model returned no JSON"));
    expect(await call("POST", `/api/designs/${d.id}/design`, {})).toEqual({ status: 502, body: { error: "The model returned no JSON" } });
    aiAnswers([{ layers: [{ type: "text", text: "Buy my course", x: 0, y: 0, w: 10, h: 10 }] }]);
    expect(await call("POST", `/api/designs/${d.id}/design`, {})).toEqual({ status: 502, body: { error: "The AI's design had nothing that could be drawn (Page 1: “Buy my course” is not in its own words: left out; Page 1: nothing in the answer could be drawn, so it is as it was)" } });
    expect((await call<Design>("GET", `/api/designs/${d.id}`)).body.pages).toEqual(d.pages);
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
    // the AI is told which picture is the video's own frame, and the words it may place are the title's
    aiAnswers([{ background: "#000000", layers: [{ type: "image", picture: d.pictures[0], x: 0, y: 0, w: 1080, h: 1920, fit: "cover" }, { type: "text", text: "FLOOR TIME", font: "Anton", size: 220, color: "#ffffff", align: "center", x: 60, y: 1300, w: 960, h: 400 }, { type: "text", text: "Watch now", x: 0, y: 0, w: 100, h: 100 }] }]);
    const designed = (await call<DesignAnswer>("POST", `/api/designs/${d.id}/design`, {})).body;
    expect(vi.mocked(completeWithFallback).mock.calls.at(-1)![1]).toContain(`Pictures:\n${d.pictures[0]} = the video's own frame`);
    expect(designed.design.pages[0]!.layers.map((l) => l.type)).toEqual(["image", "text"]);
    expect(designed.notes).toEqual(["Page 1: “Watch now” is not in its own words: left out"]);
  }, 60_000);

  it("refuses a carousel size for a video, a video the account cannot read, and a moment that is not a time", async () => {
    expect((await call("POST", "/api/designs", { format: "portrait", version: "ver_v", t: 1 })).body).toEqual({ error: "A video's frame takes the cover or the thumbnail size" });
    expect((await call("POST", "/api/designs", { format: "cover", version: "ver_v", t: 1 }, "robin")).status).toBe(404);
    expect((await call("POST", "/api/designs", { format: "cover", version: "ver_nope", t: 1 })).status).toBe(404);
    expect((await call("POST", "/api/designs", { format: "cover", version: "ver_v", t: -3 })).status).toBe(400);
  });
});
