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
const { ffmpegCommand } = await import("../ffmpeg-runtime");
const { blobs, libraryDb } = await import("../library/db");

const ana = createUser("ana", "password1");
const nico = createUser("nico", "password1");
const anaKey = `Bearer ${newApiKey(ana, "full")}`;
const nicoKey = `Bearer ${newApiKey(nico, "full")}`;

/** What design_make and a design_layers write answer. */
type Made = { id: string; name: string; link: string; size: string; pages: number; existed?: true; left_out?: string[] };
/** What design_layers answers for a read. */
type Read = { how: string; fonts: string[]; pages: Array<{ page: number; words: string; background: string; layers: Array<{ type: string; text?: string }> }> };

/** One tool call through POST /api/mcp, as an AI key from outside the app makes it. */
const tool = async <T = Made>(authorization: string, name: string, args: Record<string, unknown> = {}) => {
  const r = (await (await app.request("/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
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

describe("the designer's tools", () => {
  it("an AI starts a piece's design, reads its pages and how to write them, designs them, and gets the same design back the next time", async () => {
    const made = await tool(anaKey, "design_make", { session: SESSION, doc: DOC });
    expect(made.error).toBe(false);
    expect(made.out).toMatchObject({ name: "Tiny Acrobatics floor time", size: "1080 × 1350", pages: 2 });
    expect(made.out.link).toMatch(new RegExp(`/design/${made.out.id}$`));
    expect(made.out).not.toHaveProperty("existed");

    const read = (await tool<Read>(anaKey, "design_layers", { id: made.out.id })).out;
    expect(read.pages.map((p) => [p.page, p.words])).toEqual([[1, slides[0]], [2, slides[1]]]);
    expect(read.how).toContain('{"type":"drawing"');
    expect(read.fonts).toContain("Bebas Neue");

    const text = { type: "text", font: "Bebas Neue", size: 150, color: "#111111", align: "left", x: 90, y: 500, w: 900, h: 400 };
    const wrote = await tool(anaKey, "design_layers", {
      id: made.out.id,
      pages: [{ page: 2, background: "#ffd400", layers: [{ type: "drawing", svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#111111"/></svg>', x: 760, y: 90, w: 230, h: 230 }, { ...text, text: "Try it today" }, { ...text, y: 1000, text: "Link in bio" }] }],
    });
    expect(wrote.error).toBe(false);
    expect(wrote.out).toMatchObject({ id: made.out.id, pages: 2, left_out: ["Page 2: “Link in bio” is not in its own words: left out"] });
    const after = (await tool<Read>(anaKey, "design_layers", { id: made.out.id })).out;
    expect(after.pages[1]).toMatchObject({ background: "#ffd400", layers: [{ type: "drawing" }, { type: "text", text: "Try it today" }] });

    // the piece has its design: asking again hands that one back, with what was done on it
    expect((await tool(anaKey, "design_make", { session: SESSION, doc: DOC })).out).toMatchObject({ id: made.out.id, existed: true, pages: 2 });
  });

  it("a cover from a library video's frame: the frame is the page's picture, and the words are the ones asked for", async () => {
    const made = await tool(anaKey, "design_make", { version: "ver_t", t: 1, title: "Floor time", format: "thumbnail" });
    expect(made.error).toBe(false);
    expect(made.out).toMatchObject({ name: "Floor time", size: "1280 × 720", pages: 1 });
    const read = (await tool<Read & { pictures: Array<{ id: string; what: string }> }>(anaKey, "design_layers", { id: made.out.id })).out;
    expect(read.pictures).toMatchObject([{ what: "the video's own frame" }]);
    expect(read.pages[0]).not.toHaveProperty("words");
    expect(read.pages[0]!.layers.map((l) => l.type)).toEqual(["image", "text"]);
    const wrote = await tool(anaKey, "design_layers", {
      id: made.out.id,
      pages: [{ page: 1, layers: [{ type: "image", picture: read.pictures[0]!.id, fit: "cover", x: 0, y: 0, w: 1280, h: 720 }, { type: "text", text: "3 MISTAKES", font: "Anton", size: 200, color: "#ffffff", align: "left", x: 60, y: 60, w: 900, h: 460 }] }],
    });
    expect(wrote.error).toBe(false);
    expect(wrote.out).not.toHaveProperty("left_out");
    expect((await tool<Read>(anaKey, "design_layers", { id: made.out.id })).out.pages[0]!.layers[1]).toMatchObject({ text: "3 MISTAKES" });
    // a video starts a new design each time; one that is not this account's is not found
    expect((await tool(anaKey, "design_make", { version: "ver_t", t: 0 })).out.id).not.toBe(made.out.id);
    expect((await tool(nicoKey, "design_make", { version: "ver_t", t: 1 })).error).toBe(true);
  });

  it("says in words what it cannot do, and another account's design is not found", async () => {
    expect((await tool(anaKey, "design_make", {})).text).toContain("Say what to design");
    expect((await tool(anaKey, "design_layers", {})).text).toContain("Give the design's id");
    const { out } = await tool(anaKey, "design_make", { session: SESSION, doc: DOC });
    const theirs = await tool(nicoKey, "design_layers", { id: out.id });
    expect(theirs.error).toBe(true);
    expect(theirs.text).toContain("Not found");
    expect((await tool(nicoKey, "design_make", { session: SESSION, doc: DOC })).error).toBe(true);
    const nothing = await tool(anaKey, "design_layers", { id: out.id, pages: [{ page: 1, layers: [{ type: "text", text: "Other words", font: "Anton", size: 40, color: "#000000", align: "left", x: 0, y: 0, w: 100, h: 100 }] }] });
    expect(nothing.error).toBe(true);
    expect(nothing.text).toContain("is not in its own words");
  });
});
