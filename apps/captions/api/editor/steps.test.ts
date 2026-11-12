import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { StepsView } from "../../contracts/editor-steps";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "edit-steps-"));
process.env.CT_EDITOR_STEPS = path.resolve("editor-steps");
const { definePlugin, mountPlugins } = await import("../lib/plugin");
const { bundledPlugins, chosenSteps, editStepsApp } = await import("./steps");

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
mountPlugins(new Hono(), [blur]);

const app = new Hono();
app.use("*", async (c, next) => { c.set("user" as never, { username: "me", role: "admin" } as never); await next(); });
app.route("/", editStepsApp);
const put = (id: string, body: unknown) => app.request(`/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("Settings → AI Editor's steps", () => {
  it("lists a loaded step on, in use, with its defaults; new edits take it", async () => {
    const view = (await (await app.request("/")).json()) as StepsView;
    expect(view.steps).toEqual([expect.objectContaining({ id: "blur", state: "on", use: true, values: { who: "everyone except me", how: "blur" } })]);
    expect(view.canAdd).toBe(false);   // not the Mac app's own server: the steps that come with the app are not offered
    expect(chosenSteps("me")).toEqual([{ id: "blur", values: { who: "everyone except me", how: "blur" } }]);
  });

  it("saves the person's values and use, and refuses what the step does not have", async () => {
    expect((await put("blur", { values: { who: "the people in the background" } })).status).toBe(200);
    expect((await put("blur", { values: { how: "smudge" } })).status).toBe(400);
    expect((await put("blur", { values: { colour: "red" } })).status).toBe(400);
    expect((await put("nope", { use: false })).status).toBe(400);
    expect(chosenSteps("me")).toEqual([{ id: "blur", values: { who: "the people in the background", how: "blur" } }]);
    await put("blur", { use: false });
    expect(chosenSteps("me")).toEqual([]);
  });

  it("puts nothing in a plug-ins folder off the Mac app's own server", async () => {
    expect((await app.request("/add/voice", { method: "POST" })).status).toBe(404);
  });

  it("reads the plug-ins that come with the app from their folders, without running them, each with its own kind", () => {
    expect(bundledPlugins()).toContainEqual({ folder: "voice", pluginId: "editor-voice", title: "Voice", about: "Cleans and levels the voice in every edit, on this computer", kind: "AI Editor step" });
    // every folder says its kind (a team plug-in added later too); the steps say they are steps
    expect(bundledPlugins().filter((b) => !b.kind)).toEqual([]);
    expect(Object.fromEntries(bundledPlugins().map((b) => [b.folder, b.kind]))).toMatchObject({
      colour: "AI Editor step",
      "face-blur": "AI Editor step",
      "face-refine": "AI Editor step",
      voice: "AI Editor step",
    });
  });

  it("on the Mac app's own server: Community gets every team plug-in, Settings → AI Editor only the loaded steps", async () => {
    const appFolder = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "edit-steps-app-"));
    // the team's folder: a step whose plugin.ts says no kind (an option's kind: "choice" must not stand in), and an engine
    const team = path.join(appFolder, "team");
    const plugin = (folder: string, text: string) => (mkdirSync(path.join(team, folder), { recursive: true }), writeFileSync(path.join(team, folder, "plugin.ts"), text));
    plugin("tiny-step", `export default definePlugin({ id: "tiny-step", name: "Tiny step", about: "A step.", editor: { steps: [{ id: "s", options: [{ id: "o", kind: "choice" }] }] } });`);
    plugin("tiny-enhance", `export default definePlugin({\n  id: "tiny-enhance",\n  name: "Tiny Enhance",\n  about: "Cleans voices.",\n  kind: "Audio Enhancer engine",\n  routes,\n});`);
    Object.assign(process.env, { CT_LOCAL: "1", CT_APP_FOLDER: appFolder, CT_EDITOR_STEPS: team });
    try {
      const view = async () => (await (await app.request("/")).json()) as StepsView;
      const row = async (id: string) => (await view()).steps.find((r) => r.id === id);
      expect(await row("tiny-enhance")).toMatchObject({ title: "Tiny Enhance", about: "Cleans voices.", kind: "Audio Enhancer engine", state: "add", folder: "tiny-enhance" });
      expect(await row("tiny-step")).toMatchObject({ kind: "", state: "add" });
      // Download: the folder goes into the plug-ins folder, the same road as a step's
      expect((await app.request("/add/tiny-enhance", { method: "POST" })).status).toBe(200);
      expect(existsSync(path.join(appFolder, "plugins", "tiny-enhance", "plugin.ts"))).toBe(true);
      expect((await row("tiny-enhance"))?.state).toBe("off");
      // switched on and loaded: Installed in Community, and no row of it among the steps
      mountPlugins(new Hono(), [blur, definePlugin({ id: "tiny-enhance", name: "Tiny Enhance" })]);
      expect((await row("tiny-enhance"))?.state).toBe("loaded");
      expect((await view()).steps.filter((r) => r.state === "on").map((r) => r.id)).toEqual(["blur"]);
    } finally {
      mountPlugins(new Hono(), [blur]);
      process.env.CT_EDITOR_STEPS = path.resolve("editor-steps");
      delete process.env.CT_LOCAL;
      delete process.env.CT_APP_FOLDER;
      rmSync(appFolder, { recursive: true, force: true });
    }
  });
});
