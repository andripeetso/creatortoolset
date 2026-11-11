import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { StepsView } from "../../contracts/editor-steps";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "edit-steps-"));
process.env.CT_EDITOR_STEPS = path.resolve("editor-steps");
const { definePlugin, mountPlugins } = await import("../lib/plugin");
const { bundledSteps, chosenSteps, editStepsApp } = await import("./steps");

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

  it("reads the steps that come with the app from their folders, without running them", () => {
    expect(bundledSteps()).toContainEqual({ folder: "voice", pluginId: "editor-voice", title: "Voice", about: "Cleans and levels the voice in every edit, on this computer" });
  });
});
