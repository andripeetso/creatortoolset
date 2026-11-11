import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Edit } from "../../contracts/editor";
import { MAX_EDITING_STYLES, STYLE_NAME_MAX, STYLE_NOTES_MAX, type EditingStyle, type EditingStylesView } from "../../contracts/editor-styles";
import type { Pack } from "../../contracts/packs";
import { energy, FPS, lines, plans, probe, sentences, words } from "./golden/pauses";

vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(m.aiFor), completeWithFallback: vi.fn(m.completeWithFallback) };
});

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-styles-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-styles-test-secret";
delete process.env.ANTHROPIC_API_KEY;

const { aiFor, completeWithFallback } = await import("../ai-complete");
const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
// A loaded plug-in that replaces /api/editor answers the root itself, so these tests (which drive the built-in root) run only without one.
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { definePlugin, mountPlugins } = await import("../lib/plugin");
const { installPack } = await import("../lib/packs");
const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { saveTranscript } = await import("../library/transcribe");
const { ENERGY_PER_SECOND, energyFile } = await import("./analyze");
const { cutTake } = await import("./cut");
const { runSteps } = await import("./post");
const { editDir, readDraft, readEdit, saveStep } = await import("./store");
const { styleBlock } = await import("./styles");
const { NATURAL_CUT } = await import("./timeline");
const { tick } = await import("./worker");

const cookies: Record<string, string> = {};
async function login(username: string) {
  setOff(createUser(username, "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { cookie: cookies[user]!, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
const styles = (user: string) => json<EditingStylesView>(call(user, "GET", "/api/editor/styles"));
const newStyle = (user: string, body: object) => call(user, "POST", "/api/editor/styles", body);
const made = async (user: string, body: object) => json<EditingStyle>(newStyle(user, body));
const newEdit = (user: string, extra: object = {}) => call(user, "POST", "/api/editor", { name: "Tiny Acrobatics hook", sources: ["ver_a", "ver_b"], ...extra });
const edit = async (user: string, extra: object = {}) => json<Edit & { steps?: unknown }>(call(user, "GET", `/api/editor/${(await json<{ id: string }>(newEdit(user, extra))).id}`));
/** Every style of the account goes, so a test starts from none. */
const clear = async (user: string) => {
  for (const s of (await styles(user)).styles) await call(user, "DELETE", `/api/editor/styles/${s.id}`);
};

/** A post-processing step, as a plug-in adds one (Settings → AI Editor). */
const blur = definePlugin({
  id: "tiny-blur",
  editor: {
    steps: [{
      id: "blur", title: "Blur faces", about: "", order: 30, run: async () => ({}),
      options: [
        { id: "who", label: "What to blur", kind: "text", default: "everyone except me" },
        { id: "how", label: "How", kind: "choice", default: "blur", choices: [{ value: "blur", label: "Blur" }, { value: "pixels", label: "Pixels" }] },
      ],
    }],
  },
});

/** A pack with a grade, and instructions for the script step. */
const pack: Pack = {
  format: 1,
  id: "tiny-looks",
  name: "Tiny looks",
  version: "1.0.0",
  author: "tinyacrobatics",
  license: "CC0-1.0",
  description: "A test grade and script instructions.",
  permissions: ["grade"],
  grades: [{ name: "warm", title: "Warm", cdl: { slope: [1.05, 1, 0.95], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1 } }],
  instructions: { "editor.script": "Open on the line that asks a question." },
};

beforeAll(async () => {
  for (const u of ["maker", "other"]) await login(u);
  const d = libraryDb();
  d.exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'maker', 'A', 'local', 0), ('lib_b', 'other', 'B', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_a', 'lib_a', 'video', 'Take A', 'maker', 0), ('ast_b', 'lib_a', 'video', 'Take B', 'maker', 0);
    INSERT INTO collections (id, library_id, name, kind, created_at) VALUES ('col_a', 'lib_a', 'B-roll', 'manual', 0), ('col_gone', 'lib_a', 'Old B-roll', 'manual', 0), ('col_b', 'lib_b', 'Theirs', 'manual', 0);
  `);
  for (const [v, a] of [["ver_a", "ast_a"], ["ver_b", "ast_b"]] as const) {
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, ?, 'ready', 'maker', 0)").run(
      v, a, `libraries/lib_a/v/${v}/source`, `sha-${v}`, JSON.stringify({ ...probe, fps: FPS[v] }),
    );
    saveTranscript(d, v, "deepgram", "en", [], words);
    mkdirSync(path.dirname(energyFile(v)), { recursive: true });
    writeFileSync(energyFile(v), energy(ENERGY_PER_SECOND));
  }
  await installPack("maker", pack, 0);
  mountPlugins(app, [blur]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(rootReplaced)("Editing styles: the person's own list", () => {
  it("an account that made none has none, and its edits carry no style", async () => {
    expect(await styles("maker")).toEqual({ styles: [], last: null });
    const e = await edit("maker");
    expect(e.style).toBeUndefined();
    expect("style" in JSON.parse(readFileSync(path.join(editDir(e.id), "edit.json"), "utf8"))).toBe(false);
    expect(await styles("maker")).toEqual({ styles: [], last: null });
  });

  it("makes one with the choices of a plain edit, changes it, deletes it; another account never sees or touches it", async () => {
    const s = await made("maker", { name: "  Fast and warm  " });
    expect(s).toMatchObject({ name: "Fast and warm", notes: "", versions: 1, targetS: 0, pace: "tight", punch: 1.15, grade: null, brollCollectionId: null, steps: null });
    const put = (user: string, body: object) => call(user, "PUT", `/api/editor/styles/${s.id}`, body);
    const changed = await json<EditingStyle>(put("maker", { notes: "Short lines. No intro.", versions: 9, targetS: 44.6, pace: "natural", punch: 1.24, grade: "warm", brollCollectionId: "col_a" }));
    // versions and seconds are kept in range, and a punch-in is the nearest of the three a style has
    expect(changed).toMatchObject({ name: "Fast and warm", notes: "Short lines. No intro.", versions: 5, targetS: 45, pace: "natural", punch: 1.3, grade: "warm", brollCollectionId: "col_a" });
    expect((await styles("maker")).styles).toEqual([changed]);

    expect((await styles("other")).styles).toEqual([]);
    expect((await put("other", { name: "Mine now" })).status).toBe(404);
    expect((await call("other", "DELETE", `/api/editor/styles/${s.id}`)).status).toBe(404);
    expect((await call("other", "POST", "/api/editor", { sources: ["ver_a"], style: s.id })).status).toBe(404);
    expect((await styles("maker")).styles[0]!.name).toBe("Fast and warm");

    expect((await call("maker", "DELETE", `/api/editor/styles/${s.id}`)).status).toBe(200);
    expect((await call("maker", "DELETE", `/api/editor/styles/${s.id}`)).status).toBe(404);
    expect((await styles("maker")).styles).toEqual([]);
  });

  it("refuses what a style cannot be: no name, an unknown pace, a folder that is not the person's", async () => {
    for (const body of [{}, { name: "   " }, { name: "A", pace: "frantic" }, { name: "A", brollCollectionId: "col_b" }, { name: "A", brollCollectionId: "col_nope" }, { name: "A", notes: 7 }, { name: "A", steps: "blur" }]) {
      expect((await newStyle("maker", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await styles("maker")).styles).toEqual([]);
  });

  it(`the caps: a name of ${STYLE_NAME_MAX} characters, notes of ${STYLE_NOTES_MAX}, ${MAX_EDITING_STYLES} styles; one more of each is refused`, async () => {
    expect((await newStyle("maker", { name: "n".repeat(STYLE_NAME_MAX + 1) })).status).toBe(400);
    expect((await newStyle("maker", { name: "A", notes: "w".repeat(STYLE_NOTES_MAX + 1) })).status).toBe(400);
    const full = await made("maker", { name: "n".repeat(STYLE_NAME_MAX), notes: "w".repeat(STYLE_NOTES_MAX) });
    expect([full.name.length, full.notes.length]).toEqual([STYLE_NAME_MAX, STYLE_NOTES_MAX]);
    expect((await call("maker", "PUT", `/api/editor/styles/${full.id}`, { notes: "w".repeat(STYLE_NOTES_MAX + 1) })).status).toBe(400);
    for (let i = 1; i < MAX_EDITING_STYLES; i++) expect((await newStyle("maker", { name: `Style ${i}` })).status).toBe(200);
    expect((await styles("maker")).styles).toHaveLength(MAX_EDITING_STYLES);
    const over = await newStyle("maker", { name: "One too many" });
    expect(over.status).toBe(400);
    expect((await json(over)).error).toMatch(/40 editing styles/);
    expect((await styles("maker")).styles).toHaveLength(MAX_EDITING_STYLES);
    await clear("maker");
  });

  it("keeps the other things in the account's file", async () => {
    await clear("maker");
    const file = path.join(dir, "editor-styles", "maker.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), animation: [{ id: "a1", name: "Paper" }] }));
    const s = await made("maker", { name: "Kept" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ animation: [{ id: "a1", name: "Paper" }], editing: [{ id: s.id }] });
    await clear("maker");
  });
});

describe.skipIf(rootReplaced)("Editing styles: an edit made with one", () => {
  it("gets the style's choices, keeps its own copy, and what the request says itself wins", async () => {
    await clear("maker");
    const steps = [{ id: "blur", values: { who: "the people behind me", how: "pixels" } }];
    const s = await made("maker", { name: "Fast and warm", notes: "Short lines. No intro.", versions: 3, targetS: 30, pace: "natural", punch: 1.3, grade: "warm", brollCollectionId: "col_a", steps });
    const plain = await edit("maker");
    expect(plain).toMatchObject({ versions: 1, targetS: 0, framing: { punch: 1.15 }, brollCollectionId: null, bundle: { grade: "none" }, steps: [{ id: "blur", values: { who: "everyone except me", how: "blur" } }] });
    expect(plain.style).toBeUndefined();

    const e = await edit("maker", { style: s.id });
    expect(e).toMatchObject({ versions: 3, targetS: 30, framing: { punch: 1.3 }, brollCollectionId: "col_a", bundle: { grade: "warm", designSystem: "plain" }, steps });
    expect(e.style).toEqual({ id: s.id, name: "Fast and warm", notes: "Short lines. No intro.", pace: "natural" });

    const own = await edit("maker", { style: s.id, versions: 2, targetS: 0, brollCollectionId: null });
    expect(own).toMatchObject({ versions: 2, targetS: 0, brollCollectionId: null, framing: { punch: 1.3 } });

    // the style changes, then goes: the edit made with it is as it was
    await call("maker", "PUT", `/api/editor/styles/${s.id}`, { name: "Slow", notes: "Long takes.", versions: 1, pace: "tight", punch: 1, grade: null, brollCollectionId: null, steps: [] });
    expect(await json<Edit>(call("maker", "GET", `/api/editor/${e.id}`))).toMatchObject({ versions: 3, framing: { punch: 1.3 }, brollCollectionId: "col_a", bundle: { grade: "warm" }, steps, style: e.style });
    await call("maker", "DELETE", `/api/editor/styles/${s.id}`);
    expect((await json<Edit>(call("maker", "GET", `/api/editor/${e.id}`))).style).toEqual(e.style);
    expect((await newEdit("maker", { style: s.id })).status).toBe(404); // a style that is gone makes no edit
  });

  it("a folder or grade the style names that is no longer there is left out; the request's own bad folder is still refused", async () => {
    await clear("maker");
    const s = await made("maker", { name: "Old folder", grade: "a-grade-since-removed", brollCollectionId: "col_gone" });
    libraryDb().prepare("DELETE FROM collections WHERE id = 'col_gone'").run();
    expect(await edit("maker", { style: s.id })).toMatchObject({ brollCollectionId: null, bundle: { grade: "none" }, style: { id: s.id } });
    expect((await newEdit("maker", { style: s.id, brollCollectionId: "col_b" })).status).toBe(404);
  });

  it("a style's steps: one this app has gets its options' values, one it does not have is kept and skipped with a note, as an edit skips it", async () => {
    await clear("maker");
    const s = await made("maker", { name: "Steps", steps: [{ id: "blur", values: { who: "x".repeat(2001), how: "smudge", colour: "red" } }, { id: "voice-since-removed", values: { level: "-16" } }] });
    expect(s.steps).toEqual([{ id: "blur", values: { who: "everyone except me", how: "blur" } }, { id: "voice-since-removed", values: { level: "-16" } }]);
    const e = await edit("maker", { style: s.id });
    expect(e.steps).toEqual(s.steps);
    const { pluginEditorSteps } = await import("../lib/plugin");
    const run = await runSteps(readEdit(e.id)!.steps!, pluginEditorSteps(), { edit: e, variant: "v1", timeline: { sources: {} } as never, base: {}, workRoot: path.join(dir, "post-work"), signal: new AbortController().signal });
    expect(run.notes).toEqual(["Post-processing: voice-since-removed is not switched on in this app, so it was skipped"]);
    // no steps at all in a style is a choice too; a style that says nothing about steps takes the ones in use (the plain edit above)
    const none = await made("maker", { name: "No steps", steps: [] });
    expect((await edit("maker", { style: none.id })).steps).toEqual([]);
  });

  it("New edit opens on the style used last: an edit made with one remembers it, None forgets it, an edit that says nothing changes nothing", async () => {
    await clear("maker");
    const a = await made("maker", { name: "A" });
    const b = await made("maker", { name: "B" });
    expect((await styles("maker")).last).toBeNull();
    await edit("maker", { style: a.id });
    expect((await styles("maker")).last).toBe(a.id);
    const quiet = await edit("maker"); // the Media Library's "Edit this clip", the phone, the assistant: no style key
    expect(quiet.style).toBeUndefined();
    expect((await styles("maker")).last).toBe(a.id);
    await edit("maker", { style: b.id });
    expect((await styles("maker")).last).toBe(b.id);
    expect((await edit("maker", { style: null })).style).toBeUndefined();
    expect((await styles("maker")).last).toBeNull();
    await edit("maker", { style: a.id });
    await call("maker", "DELETE", `/api/editor/styles/${a.id}`);
    expect((await styles("maker")).last).toBeNull();
  });

  it("PATCH puts a style on an edit that has not run, under what the patch sets itself, and null takes it off", async () => {
    await clear("maker");
    const s = await made("maker", { name: "Fast and warm", notes: "Short lines.", versions: 3, targetS: 30, pace: "natural", punch: 1, grade: "warm" });
    const e = await edit("maker");
    const patch = (body: object) => call("maker", "PATCH", `/api/editor/${e.id}`, body);
    const on = await json<Edit>(patch({ style: s.id, versions: 2 }));
    expect(on).toMatchObject({ versions: 2, targetS: 30, framing: { punch: 1 }, bundle: { grade: "warm", voiceMix: "level" }, style: { id: s.id, pace: "natural", notes: "Short lines." } });
    expect((await patch({ style: "no-such-style" })).status).toBe(404);
    expect((await call("other", "PATCH", `/api/editor/${e.id}`, { style: s.id })).status).toBe(404);
    const off = await json<Edit>(patch({ style: null }));
    expect(off.style).toBeUndefined();
    expect(off).toMatchObject({ versions: 2, targetS: 30 });
    // a patch that says nothing about a style leaves it
    await patch({ style: s.id });
    expect((await json<Edit>(patch({ name: "Renamed" }))).style).toMatchObject({ id: s.id });
    // an edit that already has a B-roll folder keeps it under a style that names none, and takes the style's when it names one
    const withFolder = await edit("maker", { brollCollectionId: "col_a" });
    expect(await json<Edit>(call("maker", "PATCH", `/api/editor/${withFolder.id}`, { style: s.id }))).toMatchObject({ brollCollectionId: "col_a", versions: 3, framing: { punch: 1 } });
    libraryDb().exec("INSERT INTO collections (id, library_id, name, kind, created_at) VALUES ('col_c', 'lib_a', 'Other B-roll', 'manual', 0)");
    const named = await made("maker", { name: "Other folder", brollCollectionId: "col_c" });
    expect((await json<Edit>(call("maker", "PATCH", `/api/editor/${withFolder.id}`, { style: named.id }))).brollCollectionId).toBe("col_c");
  });

  it("Save as style copies an edit's choices and nothing of what the video is; only its maker can", async () => {
    await clear("maker");
    const first = await made("maker", { name: "Fast and warm", notes: "Short lines. No intro.", pace: "natural", grade: "warm", brollCollectionId: "col_a", steps: [] });
    const e = await edit("maker", { style: first.id, brief: "SECRET-BRIEF about the launch", script: "SECRET-SCRIPT line one", versions: 4, targetS: 50, framing: { punch: 1.9 } });
    expect((await newStyle("other", { fromEdit: e.id, name: "Stolen" })).status).toBe(404);
    expect((await newStyle("maker", { fromEdit: "no-such-edit", name: "X" })).status).toBe(404);
    expect((await newStyle("maker", { fromEdit: e.id })).status).toBe(400); // it asks for a name
    const s = await made("maker", { fromEdit: e.id, name: "From the hook" });
    expect(s).toMatchObject({ name: "From the hook", notes: "Short lines. No intro.", versions: 4, targetS: 50, pace: "natural", punch: 1.3, grade: "warm", brollCollectionId: "col_a", steps: [] });
    expect(s.id).not.toBe(first.id);
    expect(JSON.stringify(s)).not.toMatch(/SECRET|ver_a|Tiny Acrobatics hook/);
    // an edit made with no style gives a style with the plain cut and no notes
    const plain = await made("maker", { fromEdit: (await edit("maker", { versions: 2 })).id, name: "Plain" });
    expect(plain).toMatchObject({ notes: "", versions: 2, pace: "tight", punch: 1.15, grade: "none", brollCollectionId: null });
  });
});

describe.skipIf(rootReplaced)("Editing styles: what reaches the script step", () => {
  const brief = { brief: "A reel for parents of crawlers.\nWarm and slow.", script: "Do puppies need tummy time?\nYes, a little every day.", versions: 2, targetS: 45 };
  /** The app's own prompt for this brief, as main sends it to an account with nothing installed (script.same-prompt.test.ts keeps it). */
  const golden = JSON.parse(readFileSync(path.join(import.meta.dirname, "golden", "script-prompt.json"), "utf8")) as Record<"plain" | "pack", { system: string; user: string }>;
  const sixSentences = [1, 2, 3, 4, 5, 6].map((n) => ({ n, src: n <= 3 ? "ver_a" : "ver_b", text: `sentence ${n}`, s: n, e: n + 0.5, w0: 0, w1: 0 }));

  /** Runs the script step of a new edit and gives back what the AI was sent. */
  async function sent(extra: object): Promise<{ system: string; user: string }> {
    const e = await edit("maker", { ...brief, ...extra });
    await saveStep(e.id, "analysis", { sentences: sixSentences, notes: [] });
    let got = { system: "", user: "" };
    vi.mocked(aiFor).mockReturnValueOnce({ only: ["anthropic"], apiKey: "test", mac: { label: "AI Editor script" } });
    vi.mocked(completeWithFallback).mockImplementationOnce(async (system, user, _c, parse) => {
      got = { system, user };
      return parse(JSON.stringify({ lines: [{ id: "L1", text: "sentence 1", takes: [{ first: 1, last: 1, score: 1 }] }], versions: [{ name: "One", lines: ["L1"] }] }));
    });
    libraryDb().prepare("DELETE FROM edit_jobs").run();
    enqueueJob(libraryDb(), "maker", `${e.id}:`, "script", "maker", true, "edit_jobs");
    await tick();
    return got;
  }

  it("the notes go in once, after the app's text and the packs' text, marked as the author's own; the rest of the prompt is the same", async () => {
    await clear("maker");
    // this account's prompt with no style: the app's own text, then its packs' (the one installed here and the one every new account gets)
    const before = await sent({});
    expect(before.system.startsWith(`${golden.plain.system}\n\nInstructions from packs the author installed for the script.`)).toBe(true);
    expect(before.system.endsWith("Never end on a black or empty frame.")).toBe(true);
    expect(before.user).toBe(golden.plain.user);

    const s = await made("maker", { name: "Fast and warm", notes: "Short lines. No intro.\nEnd on the question." });
    const got = await sent({ style: s.id });
    expect(got.system).toBe(`${before.system}\n\nEditing style "Fast and warm", in the author's own words:\nShort lines. No intro.\nEnd on the question.`);
    expect(got.user).toBe(before.user);

    // an edit with no style gets what it got before the account had a style, and a style with no notes adds nothing
    expect(await sent({})).toEqual(before);
    expect(await sent({ style: null })).toEqual(before);
    const bare = await made("maker", { name: "Only numbers", pace: "natural", punch: 1 });
    expect(await sent({ style: bare.id })).toEqual(before);
  });

  it("at the cap: the block is never more than the name and the notes a style can hold, even from a file changed by hand", () => {
    const head = (name: string) => `Editing style ${JSON.stringify(name)}, in the author's own words:\n`;
    const full = styleBlock({ id: "s", name: "n".repeat(STYLE_NAME_MAX), notes: "w".repeat(STYLE_NOTES_MAX), pace: "tight" });
    expect(full).toBe(head("n".repeat(STYLE_NAME_MAX)) + "w".repeat(STYLE_NOTES_MAX));
    expect(styleBlock({ id: "s", name: "n".repeat(500), notes: "w".repeat(50_000), pace: "tight" })).toBe(full);
    expect(styleBlock(undefined)).toBe("");
    expect(styleBlock({ id: "s", name: "A", notes: "  \n ", pace: "natural" })).toBe("");
  });
});

describe.skipIf(rootReplaced)("Editing styles: pace and punch-in change the cut", () => {
  /** A new edit drafted from the fixture's plan: its first version's speaker track. */
  async function drafted(extra: object) {
    const e = await edit("maker", extra);
    await saveStep(e.id, "analysis", { sentences, notes: [] });
    await saveStep(e.id, "plan", { lines, plans, notes: [] });
    libraryDb().prepare("DELETE FROM edit_jobs").run();
    enqueueJob(libraryDb(), "maker", `${e.id}:`, "draft", "maker", true, "edit_jobs");
    while (await tick());
    const t = readDraft(e.id, "v1")!.timeline;
    const v1 = t.tracks.V1.items;
    return { items: v1, seconds: v1.reduce((n, i) => n + i.len, 0) / t.fps, timeline: t };
  }

  it("Tight is the plain cut; Natural leaves the short pauses in, so the same lines run longer in fewer shots", async () => {
    await clear("maker");
    const plain = await drafted({});
    const tight = await drafted({ style: (await made("maker", { name: "Tight" })).id });
    const natural = await drafted({ style: (await made("maker", { name: "Natural", pace: "natural" })).id });
    expect(tight.timeline).toEqual(plain.timeline);
    // the plain cut takes out all three pauses (0.4 s, 0.8 s and 0.35 s): five shots
    expect(plain.items).toHaveLength(5);
    // Natural keeps the 0.4 s and the 0.35 s pause and cuts only the 0.8 s one: three shots, and at least those two pauses longer
    expect(natural.items).toHaveLength(3);
    expect(natural.seconds - plain.seconds).toBeGreaterThan(0.4 + 0.35);
    expect(natural.seconds).toBeLessThan(plain.seconds + 0.4 + 0.35 + 0.8);
  });

  it("Natural still cuts between the words: a word of the take before does not get in", () => {
    // "um" ends 0.35 s before the line starts: too short a pause for Natural to call one, so it cuts at the quietest frame between them
    const w = [{ w: "um", s: 0, e: 0.3 }, { w: "we", s: 0.65, e: 0.95 }, { w: "roll", s: 0.95, e: 1.25 }];
    const loud = new Float32Array(2 * ENERGY_PER_SECOND);
    for (const x of w) loud.fill(0.5, Math.round(x.s * ENERGY_PER_SECOND), Math.round(x.e * ENERGY_PER_SECOND));
    const cut = cutTake(w, 1, 3, "we roll", loud, 25, NATURAL_CUT);
    expect(cut.segments).toHaveLength(1);
    expect(cut.segments[0]![0]).toBeGreaterThanOrEqual(Math.ceil(0.3 * 25)); // after "um" has ended
    expect(cut.segments[0]![0]).toBeLessThanOrEqual(Math.floor(0.65 * 25)); // and "we" is whole
  });

  it("the punch-in: None leaves every shot as filmed, Strong zooms every other shot further than the plain cut does", async () => {
    await clear("maker");
    const zooms = async (punch: number) => (await drafted({ style: (await made("maker", { name: `Punch ${punch}`, punch })).id })).items.map((i) => i.zoom ?? 1);
    expect(await zooms(1)).toEqual([1, 1, 1, 1, 1]);
    expect(await zooms(1.15)).toEqual([1, 1.15, 1, 1.15, 1]);
    expect(await zooms(1.3)).toEqual([1, 1.3, 1, 1.3, 1]);
  });
});
