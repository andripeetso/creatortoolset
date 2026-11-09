import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Edit, EditorDefaults } from "../../contracts/editor";
import type { Pack } from "../../contracts/packs";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-bundle-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-bundle-test-secret";

const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
// A loaded plug-in that replaces /api/editor answers the root itself, so these tests (which drive the built-in root) run only without one.
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb } = await import("../library/db");
const { installPack } = await import("../lib/packs");
const { definePlugin, mountPlugins } = await import("../lib/plugin");

/** A test plug-in with two per-edit flags: one on by default, one off. */
const flagPlugin = definePlugin({
  id: "tiny-flags",
  editFlags: [
    { id: "tiny-on", label: "Tiny on", default: true },
    { id: "tiny-off", label: "Tiny off" },
  ],
});

const cookies: Record<string, string> = {};
async function login(username: string) {
  setOff(createUser(username, "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "password1" }),
  });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: { cookie: cookies[user]!, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
const create = (user: string, sources: string[]) => call(user, "POST", "/api/editor", { name: "Bundle test", sources });

/** A pack of one grade and one voice mix; its default voice mix is the one the edits of the installing person start with. */
const tinyPack: Pack = {
  format: 1,
  id: "tiny-looks",
  name: "Tiny looks",
  version: "1.0.0",
  author: "tinyacrobatics",
  license: "CC0-1.0",
  description: "Test grade and voice mix.",
  permissions: ["grade", "voice"],
  grades: [{ name: "warm", title: "Warm", cdl: { slope: [1.05, 1, 0.95], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1 } }],
  voiceMixes: [{ name: "bed", title: "Voice over a bed", voiceLufs: -16, bedLufs: -28, enhancer: "off" }],
  editorDefaults: { voiceMix: "bed" },
};

beforeAll(async () => {
  for (const u of ["maker", "other"]) await login(u);
  libraryDb().exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'maker', 'A', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at, trashed_at) VALUES ('ast_a1', 'lib_a', 'video', 'Take 1', 'maker', 0, NULL);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('ver_a1', 'ast_a1', 1, 'k1', 1, 'x1', 'ready', 'maker', 0);
  `);
  await installPack("maker", tinyPack, 0);
  mountPlugins(app, [flagPlugin]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(rootReplaced)("AI Editor: the default set and the plug-in edit flags", () => {
  it("a new edit records the set it was made with: the pack's default where it has one, else built in", async () => {
    const { id } = await json<{ id: string }>(create("maker", ["ver_a1"]));
    const e = await json<Edit>(call("maker", "GET", `/api/editor/${id}`));
    expect(e.bundle).toEqual({ designSystem: "plain", grade: "none", voiceMix: "bed", sfxSet: "none" });
    expect(e.flags).toEqual({ "tiny-on": true, "tiny-off": false });
    expect(e.flagDefs.map((f) => f.id)).toEqual(["tiny-on", "tiny-off"]);
  });

  it("Settings lists each slot's items; a changed default changes new edits and leaves existing ones alone", async () => {
    const before = await json<{ id: string }>(create("maker", ["ver_a1"]));
    const d0 = await json<EditorDefaults>(call("maker", "GET", "/api/editor/defaults"));
    expect(d0.bundle.grade).toBe("none");
    expect(d0.items.grade.map((i) => i.id)).toEqual(["none", "warm"]);
    expect(d0.items.grade.find((i) => i.id === "warm")).toEqual({ id: "warm", title: "Warm", from: "Tiny looks" });

    const set = await call("maker", "PUT", "/api/editor/defaults/grade", { id: "warm" });
    expect(set.status).toBe(200);
    expect((await json<EditorDefaults>(set)).bundle.grade).toBe("warm");
    const after = await json<{ id: string }>(create("maker", ["ver_a1"]));
    expect((await json<Edit>(call("maker", "GET", `/api/editor/${after.id}`))).bundle.grade).toBe("warm");
    expect((await json<Edit>(call("maker", "GET", `/api/editor/${before.id}`))).bundle.grade).toBe("none");

    // back to the built-in grade: the edit made in between keeps the one it was made with
    const reset = await json<EditorDefaults>(call("maker", "PUT", "/api/editor/defaults/grade", { id: null }));
    expect(reset.bundle.grade).toBe("none");
    expect(reset.chosen.grade).toBeUndefined();
    expect((await json<Edit>(call("maker", "GET", `/api/editor/${after.id}`))).bundle.grade).toBe("warm");
  });

  it("refuses an unknown slot, and an item the slot does not offer", async () => {
    expect((await call("maker", "PUT", "/api/editor/defaults/colour", { id: "warm" })).status).toBe(400);
    expect((await call("maker", "PUT", "/api/editor/defaults/grade", { id: "nope" })).status).toBe(400);
    expect((await call("maker", "PUT", "/api/editor/defaults/grade", { id: "bed" })).status).toBe(400); // a voice mix, not a grade
  });

  it("another person only sees the built-in items: a pack installed by one account is that account's", async () => {
    const d = await json<EditorDefaults>(call("other", "GET", "/api/editor/defaults"));
    expect(d.items.grade.map((i) => i.id)).toEqual(["none"]);
    expect(d.bundle.voiceMix).toBe("level");
  });

  it("a plug-in flag is saved on the edit and reads back; a patch changes only the flags it names, and bad or undeclared values are ignored", async () => {
    const { id } = await json<{ id: string }>(create("maker", ["ver_a1"]));
    const on = await json<Edit>(call("maker", "PATCH", `/api/editor/${id}`, { flags: { "tiny-off": true, undeclared: true } }));
    expect(on.flags).toEqual({ "tiny-on": true, "tiny-off": true });
    expect((await json<Edit>(call("maker", "GET", `/api/editor/${id}`))).flags).toEqual({ "tiny-on": true, "tiny-off": true });
    expect((await json<Edit>(call("maker", "PATCH", `/api/editor/${id}`, { flags: { "tiny-on": "yes" } }))).flags["tiny-on"]).toBe(true);
    expect((await json<Edit>(call("maker", "PATCH", `/api/editor/${id}`, { flags: { "tiny-on": false } }))).flags).toEqual({ "tiny-on": false, "tiny-off": true });
  });

  it("the grade an edit was made with reaches the preview and the OTIO; built in and not-installed grades give none", async () => {
    const { gradeOf } = await import("./store");
    const warm = { designSystem: "plain", grade: "warm", voiceMix: "level", sfxSet: "none" };
    expect(await gradeOf("maker", warm)).toEqual(tinyPack.grades![0]!.cdl);
    expect(await gradeOf("maker", { ...warm, grade: "none" })).toBeUndefined();
    expect(await gradeOf("other", warm)).toBeUndefined(); // the pack is the maker's, not theirs
  });

  it("a pack limited to some projects is still offered and its grade used, since the editor is not per project", async () => {
    const { setPackProjects } = await import("../lib/packs");
    const { gradeOf } = await import("./store");
    const warm = { designSystem: "plain", grade: "warm", voiceMix: "level", sfxSet: "none" };
    await setPackProjects("maker", "tiny-looks", ["tiny-project"]);
    const d = await json<EditorDefaults>(call("maker", "GET", "/api/editor/defaults"));
    expect(d.items.grade.map((i) => i.id)).toContain("warm");
    expect(await gradeOf("maker", warm)).toEqual(tinyPack.grades![0]!.cdl);
    await setPackProjects("maker", "tiny-looks", undefined);
  });

  it("an edit saved before the set and the flags existed reads as built in, with each flag at its default", async () => {
    const { id } = await json<{ id: string }>(create("maker", ["ver_a1"]));
    const file = path.join(dir, "editor", id, "edit.json");
    const old = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    delete old.bundle;
    delete old.flags;
    writeFileSync(file, JSON.stringify(old));
    const e = await json<Edit>(call("maker", "GET", `/api/editor/${id}`));
    expect(e.bundle).toEqual({ designSystem: "plain", grade: "none", voiceMix: "level", sfxSet: "none" });
    expect(e.flags).toEqual({ "tiny-on": true, "tiny-off": false });
  });

  // last: it leaves the pack delisted for the rest of the file
  it("a pack switched off or delisted offers no items and its defaults and grade are not used", async () => {
    const { setPackOn, markDelisted } = await import("../lib/packs");
    const { gradeOf } = await import("./store");
    const warm = { designSystem: "plain", grade: "warm", voiceMix: "level", sfxSet: "none" };
    await setPackOn("maker", "tiny-looks", false);
    const off = await json<EditorDefaults>(call("maker", "GET", "/api/editor/defaults"));
    expect(off.items.grade.map((i) => i.id)).toEqual(["none"]);
    expect(off.bundle.voiceMix).toBe("level");
    expect(await gradeOf("maker", warm)).toBeUndefined();

    await setPackOn("maker", "tiny-looks", true);
    await markDelisted("maker", "tiny-looks", "Removed from the catalog");
    const gone = await json<EditorDefaults>(call("maker", "GET", "/api/editor/defaults"));
    expect(gone.items.grade.map((i) => i.id)).toEqual(["none"]);
    expect(gone.bundle.voiceMix).toBe("level");
    expect(await gradeOf("maker", warm)).toBeUndefined();
  });
});
