import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DESIGN_LIMITS, type Design, type DesignAnswer, type DesignFont } from "../contracts/design";

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "design-fonts-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = "design-fonts-test-secret";

const { Hono } = await import("hono");
const { designsApp } = await import("./designs");
const { createUser } = await import("./users");

createUser("jordan", "password1", { role: "user" });
createUser("robin", "password1", { role: "user" });
let as = "jordan";
const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  c.set("user", { username: as, role: "user", cloud: true, off: [] });
  await next();
});
app.route("/api/designs", designsApp as never);
const call = async <T = Record<string, unknown>>(method: string, url: string, body?: unknown, who = "jordan"): Promise<{ status: number; type: string; body: T }> => {
  as = who;
  const r = await app.request(url, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const type = r.headers.get("content-type") ?? "";
  return { status: r.status, type, body: type.includes("json") ? ((await r.json()) as T) : (Buffer.from(await r.arrayBuffer()) as never) };
};
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const bundled = (name: string) => readFileSync(path.join(import.meta.dirname, "..", "public", "fonts", name));
/** A bundled open-licence font that calls itself something else: every place its name table spells `from`, `to` (as long) stands. */
function renamed(font: Buffer, from: string, to: string): Buffer {
  const out = Buffer.from(font);
  for (const [a, b] of [[Buffer.from(from, "utf16le").swap16(), Buffer.from(to, "utf16le").swap16()], [Buffer.from(from, "latin1"), Buffer.from(to, "latin1")]] as const) {
    for (let at = out.indexOf(a); at >= 0; at = out.indexOf(a, at + a.length)) b.copy(out, at);
  }
  return out;
}
/** Single-face fonts as one collection (as in lib/font-file.test.ts). */
function collectionOf(fonts: Buffer[]): Buffer {
  const head = Buffer.alloc(12 + fonts.length * 4);
  head.write("ttcf", 0, "latin1");
  head.writeUInt32BE(0x00010000, 4);
  head.writeUInt32BE(fonts.length, 8);
  let at = head.length;
  const parts = fonts.map((font, k) => {
    const copy = Buffer.from(font);
    for (let t = 0; t < copy.readUInt16BE(4); t++) copy.writeUInt32BE(copy.readUInt32BE(12 + t * 16 + 8) + at, 12 + t * 16 + 8);
    head.writeUInt32BE(at, 12 + k * 4);
    at += copy.length;
    return copy;
  });
  return Buffer.concat([head, ...parts]);
}
const nabev = renamed(bundled("Bevan-Regular.ttf"), "Bevan", "Nabev");
const dratsuoc = renamed(bundled("Coustard-Black.ttf"), "Coustard", "Dratsuoc");

type Fonts = { fonts: DesignFont[] };
type Added = Fonts & { added: DesignFont[]; notes: string[] };
type Wrote = DesignAnswer & { touched: string[] };
const add = (file: Buffer, who = "jordan") => call<Added & { error?: string }>("POST", "/api/designs/fonts", { name: "a font", data: file.toString("base64") }, who);
const fontsFile = () => path.join(dataDir, "designs", "jordan", ".fonts", "index.json");
const word = (id: string, font: string) => ({ id, type: "text", text: "Floor time", font, size: 90, color: "#111111", align: "left", x: 80, y: 80, w: 900, h: 200 });

describe("designs: a person's own fonts", () => {
  it("a font file is added under the name its face gives itself, listed, and served to its owner alone", async () => {
    expect((await call<Fonts>("GET", "/api/designs/fonts")).body).toEqual({ fonts: [] });
    const one = await add(nabev);
    expect(one.status).toBe(200);
    expect(one.body.added).toMatchObject([{ family: "Nabev" }]);
    expect(one.body.notes).toEqual([]);
    const id = one.body.added[0]!.id;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect((await call<Fonts>("GET", "/api/designs/fonts")).body.fonts).toEqual([{ id, family: "Nabev" }]);
    const file = await call<Buffer>("GET", `/api/designs/fonts/${id}`);
    expect([file.status, file.type]).toEqual([200, "font/ttf"]);
    expect(file.body.equals(nabev)).toBe(true);
    // another account has none of it
    expect((await call<Fonts>("GET", "/api/designs/fonts", undefined, "robin")).body).toEqual({ fonts: [] });
    expect((await call("GET", `/api/designs/fonts/${id}`, undefined, "robin")).status).toBe(404);
    expect((await call("DELETE", `/api/designs/fonts/${id}`, undefined, "robin")).status).toBe(404);
    expect((await call("GET", "/api/designs/fonts/..%2Findex.json")).status).toBe(404);
  });

  it("a collection adds every face it holds; one of the app's own names, or one that is there already, is said and left out", async () => {
    const both = await add(collectionOf([nabev, dratsuoc, bundled("Bevan-Regular.ttf")]));
    expect(both.body.added.map((f) => f.family)).toEqual(["Dratsuoc Black"]);
    expect(both.body.notes).toEqual(["Nabev is among your fonts already", "Bevan is one of the app's own fonts"]);
    expect(both.body.fonts.map((f) => f.family)).toEqual(["Nabev", "Dratsuoc Black"]);
    // the face cut out of the collection is a font file of its own
    const cut = await call<Buffer>("GET", `/api/designs/fonts/${both.body.added[0]!.id}`);
    expect(cut.body.readUInt32BE(0)).toBe(0x00010000);
    expect(cut.body.length).toBe(dratsuoc.length);
  });

  it("refuses what is no font, and a file too heavy, in words", async () => {
    expect((await add(Buffer.from("not a font at all, just words"))).body.error).toBe("This is not a TrueType or OpenType font");
    expect((await add(bundled("Archivo-ExpandedBlack.woff2"))).body.error).toBe("A web font (WOFF) cannot be added: add the font's .ttf or .otf file");
    expect((await call<{ error: string }>("POST", "/api/designs/fonts", {})).body.error).toBe("Send the font file");
    const heavy = await call<{ error: string }>("POST", "/api/designs/fonts", { data: "A".repeat(Math.ceil(DESIGN_LIMITS.fontBytes / 3) * 4 + 8) });
    expect([heavy.status, heavy.body.error]).toEqual([400, "A font file can be up to 16 MB"]);
    expect((await call<Fonts>("GET", "/api/designs/fonts")).body.fonts).toHaveLength(2);
  });

  it("an AI is offered the person's fonts and may set words in them; a name it makes up still becomes a face that is there", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const got = (await call<{ fonts: string[] }>("GET", `/api/designs/${d.id}/pages`)).body;
    expect(got.fonts.slice(-2)).toEqual(["Nabev", "Dratsuoc Black"]);
    expect(got.fonts).toContain("Bevan");
    const out = (await call<Wrote>("POST", `/api/designs/${d.id}/pages`, { frames: [{ id: d.pages[0]!.id, layers: [word("mine", "Nabev"), word("made-up", "Comic Sans")] }] })).body;
    expect(out.design.pages[0]!.layers.map((l) => l.type === "text" && l.font)).toEqual(["Nabev", "Inter"]);
    // robin has no such font: the same write sets both in the app's own
    const theirs = (await call<Design>("POST", "/api/designs", { format: "square", blank: true }, "robin")).body;
    const other = (await call<Wrote>("POST", `/api/designs/${theirs.id}/pages`, { frames: [{ id: theirs.pages[0]!.id, layers: [word("mine", "Nabev")] }] }, "robin")).body;
    expect(other.design.pages[0]!.layers.map((l) => l.type === "text" && l.font)).toEqual(["Inter"]);
  });

  it("a font taken away stays named in the texts set in it, through a save by hand and an AI's change beside it", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    const frame = d.pages[0]!.id;
    await call("POST", `/api/designs/${d.id}/pages`, { frames: [{ id: frame, layers: [word("mine", "Nabev"), word("plain", "Anton")] }] });
    const id = (await call<Fonts>("GET", "/api/designs/fonts")).body.fonts.find((f) => f.family === "Nabev")!.id;
    expect((await call<Fonts>("DELETE", `/api/designs/fonts/${id}`)).body.fonts.map((f) => f.family)).toEqual(["Dratsuoc Black"]);
    expect((await call("GET", `/api/designs/fonts/${id}`)).status).toBe(404);
    const fontOf = async () => (await call<Design>("GET", `/api/designs/${d.id}`)).body.pages[0]!.layers.map((l) => l.type === "text" && l.font);
    // a save by hand of the frame as the page holds it
    const now = (await call<Design>("GET", `/api/designs/${d.id}`)).body;
    expect((await call("PUT", `/api/designs/${d.id}`, { pages: now.pages })).status).toBe(200);
    expect(await fontOf()).toEqual(["Nabev", "Anton"]);
    // an AI changes the layer beside it
    await call("POST", `/api/designs/${d.id}/pages`, { changes: [{ frame, layer: "plain", set: { size: 120 } }] });
    expect(await fontOf()).toEqual(["Nabev", "Anton"]);
    // added again, it is the same name: the texts are drawn in it once more
    expect((await add(nabev)).body.added).toMatchObject([{ family: "Nabev" }]);
  });

  it("an account's fonts go with the account, and nobody else's do", async () => {
    expect((await add(dratsuoc, "robin")).body.added).toMatchObject([{ family: "Dratsuoc Black" }]);
    const { deleteUserContent } = await import("./retention");
    await deleteUserContent("robin");
    expect((await call<Fonts>("GET", "/api/designs/fonts", undefined, "robin")).body).toEqual({ fonts: [] });
    expect(existsSync(path.join(dataDir, "designs", "robin", ".fonts"))).toBe(false);
    expect((await call<Fonts>("GET", "/api/designs/fonts")).body.fonts.length).toBeGreaterThan(0);
  });

  it("a fonts list that cannot be read is an error, never no fonts: nothing set in them is rewritten", async () => {
    const d = (await call<Design>("POST", "/api/designs", { format: "square", blank: true })).body;
    await call("POST", `/api/designs/${d.id}/pages`, { frames: [{ id: d.pages[0]!.id, layers: [word("mine", "Dratsuoc Black")] }] });
    const kept = readFileSync(fontsFile(), "utf8");
    writeFileSync(fontsFile(), "{ this is not the list");
    try {
      expect((await call("GET", "/api/designs/fonts")).status).toBe(500);
      const now = (await call<Design>("GET", `/api/designs/${d.id}`)).body;
      expect((await call("PUT", `/api/designs/${d.id}`, { pages: now.pages })).status).toBe(500);
      expect((await call("POST", `/api/designs/${d.id}/pages`, { changes: [{ frame: d.pages[0]!.id, layer: "mine", set: { size: 100 } }] })).status).toBe(500);
    } finally {
      writeFileSync(fontsFile(), kept);
    }
    expect((await call<Design>("GET", `/api/designs/${d.id}`)).body.pages[0]!.layers).toMatchObject([{ id: "mine", font: "Dratsuoc Black", size: 90 }]);
  });
});
