import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Edit } from "../../contracts/editor";
import {
  ANIMATION_BRIEF_MAX,
  MAX_ANIMATION_STYLES,
  MAX_INSPIRATIONS,
  MAX_MADE,
  PICTURE_MAX_BYTES,
  PICTURE_MAX_SIDE,
  STYLE_NAME_MAX,
  type AnimationStyle,
  type AnimationStylesView,
  type EditingStyle,
} from "../../contracts/editor-styles";
import { ffmpegCommand } from "../ffmpeg-runtime";

// Animation styles through their real routes: the record and its caps, pictures made small on arrival, and the one
// rule that keeps "Made & liked" true: a picture someone sends is always an inspiration.

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "animation-styles-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "animation-styles-test-secret";

const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
// A loaded plug-in that replaces /api/editor answers the root itself, so these tests (which drive the built-in root) run only without one.
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb } = await import("../library/db");
const { addPicture, pictureFile } = await import("./animation-styles");

const cookies: Record<string, string> = {};
async function login(username: string) {
  setOff(createUser(username, "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { cookie: cookies[user]!, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
const base = "/api/editor/animation-styles";
const list = async (user: string) => (await json<AnimationStylesView>(call(user, "GET", base))).styles;
const make = (user: string, body: object) => json<AnimationStyle>(call(user, "POST", base, body));
/** Sends files as the page does: a form with `file` once or more, and whatever else a caller adds. */
const upload = (user: string, id: string, files: string[], extra: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  for (const f of files) form.append("file", new File([readFileSync(f)], path.basename(f)));
  return app.request(`${base}/${id}/pictures`, { method: "POST", headers: { cookie: cookies[user]! }, body: form });
};
const sizeOf = (file: string) =>
  execFileSync(ffmpegCommand().replace(/ffmpeg$/, "ffprobe"), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" })
    .trim()
    .split(",")
    .map(Number);

const small = path.join(dir, "tiny-acrobatics-card.png");
const big = path.join(dir, "tiny-acrobatics-noise.png");

beforeAll(async () => {
  for (const u of ["maker", "other"]) await login(u);
  execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x568:rate=1", "-frames:v", "1", small]);
  // noise does not compress: the worst a camera or a screenshot could send
  execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", "nullsrc=size=2600x1500,geq=random(1)*255:128:128", "-frames:v", "1", big]);
  libraryDb().exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'maker', 'A', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at, trashed_at) VALUES ('ast_a1', 'lib_a', 'video', 'Take 1', 'maker', 0, NULL);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES
      ('ver_a1', 'ast_a1', 1, 'k1', 1, 'x1', 'ready', 'maker', 0);
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(rootReplaced)("animation styles", () => {
  it("a style is a name and a brief; only its maker sees or changes it", async () => {
    expect(await list("maker")).toEqual([]);
    const s = await make("maker", { name: " Bold blue ", brief: "Big white words on deep blue." });
    expect(s).toMatchObject({ name: "Bold blue", brief: "Big white words on deep blue.", pictures: [] });
    expect(s).not.toHaveProperty("from");
    expect((await call("maker", "POST", base, { brief: "no name" })).status).toBe(400);
    expect(await json(call("maker", "PUT", `${base}/${s.id}`, { brief: "Slow moves." }))).toMatchObject({ name: "Bold blue", brief: "Slow moves." });
    expect(await list("other")).toEqual([]);
    expect((await call("other", "PUT", `${base}/${s.id}`, { name: "Mine now" })).status).toBe(404);
    expect((await call("other", "DELETE", `${base}/${s.id}`)).status).toBe(404);
    expect((await upload("other", s.id, [small])).status).toBe(404);
    expect((await list("maker")).map((x) => x.name)).toEqual(["Bold blue"]);
  });

  it("the caps: a name of 60, a brief of 600, 20 styles", async () => {
    const [s] = await list("maker");
    expect((await call("maker", "PUT", `${base}/${s!.id}`, { brief: "b".repeat(ANIMATION_BRIEF_MAX) })).status).toBe(200);
    expect((await call("maker", "PUT", `${base}/${s!.id}`, { brief: "b".repeat(ANIMATION_BRIEF_MAX + 1) })).status).toBe(400);
    expect((await call("maker", "PUT", `${base}/${s!.id}`, { name: "n".repeat(STYLE_NAME_MAX + 1) })).status).toBe(400);
    expect((await list("maker"))[0]!.brief).toHaveLength(ANIMATION_BRIEF_MAX);
    for (let i = (await list("other")).length; i < MAX_ANIMATION_STYLES; i++) expect((await call("other", "POST", base, { name: `Style ${i}` })).status).toBe(200);
    const over = await call("other", "POST", base, { name: "One too many" });
    expect(over.status).toBe(400);
    expect((await json<{ error: string }>(over)).error).toContain(String(MAX_ANIMATION_STYLES));
    expect(await list("other")).toHaveLength(MAX_ANIMATION_STYLES);
  });

  it("a picture is kept as a JPEG of at most 1024 px and 300 KB, whatever was sent", async () => {
    const s = await make("maker", { name: "Pictures" });
    const after = await json<AnimationStyle>(upload("maker", s.id, [big, small]));
    expect(after.pictures.map((p) => p.kind)).toEqual(["inspiration", "inspiration"]);
    const [noise, card] = after.pictures.map((p) => pictureFile("maker", s.id, p.id)!);
    expect(statSync(noise!).size).toBeLessThanOrEqual(PICTURE_MAX_BYTES);
    expect(Math.max(...sizeOf(noise!))).toBeLessThanOrEqual(PICTURE_MAX_SIDE);
    expect(sizeOf(noise!)[0]! / sizeOf(noise!)[1]!).toBeCloseTo(2600 / 1500, 1);
    expect(sizeOf(card!)).toEqual([320, 568]); // a small picture is not made bigger
    const got = await call("maker", "GET", `${base}/${s.id}/pictures/${after.pictures[0]!.id}`);
    expect(got.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await got.arrayBuffer()).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect((await call("other", "GET", `${base}/${s.id}/pictures/${after.pictures[0]!.id}`)).status).toBe(404);

    const text = path.join(dir, "notes.txt");
    writeFileSync(text, "not a picture");
    expect((await upload("maker", s.id, [text])).status).toBe(400);
    expect((await call("maker", "POST", `${base}/${s.id}/pictures`, {})).status).toBe(400);
    // nothing is left beside the two pictures
    expect(readdirSync(path.dirname(noise!)).sort()).toEqual(after.pictures.map((p) => `${p.id}.jpg`).sort());

    const less = await json<AnimationStyle>(call("maker", "DELETE", `${base}/${s.id}/pictures/${after.pictures[0]!.id}`));
    expect(less.pictures).toHaveLength(1);
    expect(existsSync(noise!)).toBe(false);
  });

  it("nobody can send a picture as made, or set a style's pictures or where it came from", async () => {
    const s = await make("maker", { name: "Only inspirations" });
    const sent = await json<AnimationStyle>(upload("maker", s.id, [small], { kind: "made" }));
    expect(sent.pictures.map((p) => p.kind)).toEqual(["inspiration"]);
    const forged = { pictures: [{ id: sent.pictures[0]!.id, kind: "made", at: 1 }], from: "someone", name: "Still mine" };
    expect(await json(call("maker", "PUT", `${base}/${s.id}`, forged))).toMatchObject({ name: "Still mine", pictures: sent.pictures });
    const made = await make("maker", { name: "New", pictures: forged.pictures, from: "someone" });
    expect(made.pictures).toEqual([]);
    expect(made).not.toHaveProperty("from");
    expect((await list("maker")).find((x) => x.id === s.id)).not.toHaveProperty("from");
  });

  it("12 inspirations and 12 made: a thirteenth inspiration is refused, a thirteenth made one takes the oldest's place", async () => {
    const s = await make("maker", { name: "Full" });
    for (let i = 0; i < MAX_INSPIRATIONS; i++) expect((await upload("maker", s.id, [small])).status).toBe(200);
    const over = await upload("maker", s.id, [small]);
    expect(over.status).toBe(400);
    expect((await json<{ error: string }>(over)).error).toContain(String(MAX_INSPIRATIONS));

    // made: what the 👍 on an edit's card calls
    const made: string[] = [];
    for (let i = 0; i < MAX_MADE + 1; i++) {
      const after = (await addPicture("maker", s.id, small, "made")) as AnimationStyle;
      made.push(after.pictures.at(-1)!.id);
    }
    const now = (await list("maker")).find((x) => x.id === s.id)!;
    expect(now.pictures.filter((p) => p.kind === "inspiration")).toHaveLength(MAX_INSPIRATIONS);
    expect(now.pictures.filter((p) => p.kind === "made").map((p) => p.id)).toEqual(made.slice(1));
    expect(readdirSync(path.join(dir, "editor-styles", "maker", s.id))).toHaveLength(MAX_INSPIRATIONS + MAX_MADE);
  });

  it("an editing style names an animation style of the same account, and an edit made with it keeps the id", async () => {
    const anim = await make("maker", { name: "For the edit" });
    const theirs = (await list("other"))[0]!;
    const style = (body: object) => call("maker", "POST", "/api/editor/styles", body);
    expect((await style({ name: "Wrong", animation: theirs.id })).status).toBe(400);
    expect((await style({ name: "Wrong", animation: "nothing" })).status).toBe(400);
    const withCards = await json<EditingStyle>(style({ name: "With cards", animation: anim.id }));
    const plain = await json<EditingStyle>(style({ name: "Plain" }));
    expect(withCards.animation).toBe(anim.id);
    expect(plain).not.toHaveProperty("animation");

    const edit = async (styleId: string) =>
      json<Edit>(call("maker", "GET", `/api/editor/${(await json<{ id: string }>(call("maker", "POST", "/api/editor", { sources: ["ver_a1"], style: styleId }))).id}`));
    expect((await edit(withCards.id)).style).toEqual({ id: withCards.id, name: "With cards", notes: "", pace: "tight", animation: anim.id });
    // a style with no animation style gives an edit the copy it always gave
    expect((await edit(plain.id)).style).toEqual({ id: plain.id, name: "Plain", notes: "", pace: "tight" });

    // the animation style goes: its folder too, and the editing style names none
    await upload("maker", anim.id, [small]);
    const folder = path.join(dir, "editor-styles", "maker", anim.id);
    expect(existsSync(folder)).toBe(true);
    expect((await call("maker", "DELETE", `${base}/${anim.id}`)).status).toBe(200);
    expect(existsSync(folder)).toBe(false);
    const left = (await json<{ styles: EditingStyle[] }>(call("maker", "GET", "/api/editor/styles"))).styles.find((x) => x.id === withCards.id)!;
    expect(left.animation).toBeNull();
  });
});
