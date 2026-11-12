import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";
import type { EditorStep } from "../lib/plugin";
import { POST_NOTE, prune, runSteps } from "./post";

const timeline = { sources: { a: {}, b: {} }, tracks: {} } as unknown as Timeline;
const base = { a: "/footage/a.mov", b: "/footage/b.mov" };
const input = { edit: { id: "e", name: "Edit", createdBy: "me" }, variant: "A", timeline, base, workRoot: process.env.TMPDIR ?? "/tmp", signal: new AbortController().signal };

/** A step that makes "<file>+<id>" of the sources it is given, and remembers what it was handed. */
const step = (id: string, only: string[], seen: Record<string, unknown>[]): EditorStep => ({
  id, title: id, about: "",
  run: async (i) => {
    seen.push({ id, files: i.files, values: i.values });
    return Object.fromEntries(only.map((k) => [k, `${i.files[k]}+${id}`]).concat([["not-a-source", "/x"]]));
  },
});

describe("the post step's chain", () => {
  it("runs the chosen steps in the app's order, each on the copies the one before made, and keeps only real sources", async () => {
    const seen: Record<string, unknown>[] = [];
    const steps = [step("colour", ["a", "b"], seen), step("faces", ["a"], seen), step("voice", ["b"], seen)];
    const out = await runSteps([{ id: "voice", values: { noise: "light" } }, { id: "colour", values: {} }], steps, input);
    expect(out.files).toEqual({ a: "/footage/a.mov+colour", b: "/footage/b.mov+colour+voice" });
    expect(seen.map((s) => s.id)).toEqual(["colour", "voice"]);   // faces is not chosen: never run
    expect(seen[1]).toMatchObject({ values: { noise: "light" }, files: { a: "/footage/a.mov+colour" } });
    expect(out.notes).toEqual([]);
  });

  it("puts what a step says in the draft's notes", async () => {
    const talk: EditorStep = { id: "blur", title: "Blur", about: "", run: async (i) => (i.note("Blur found no face that matches “the kids”"), {}) };
    const out = await runSteps([{ id: "blur", values: {} }], [talk], input);
    expect(out.notes).toEqual([`${POST_NOTE}Blur found no face that matches “the kids”`]);
  });

  it("names a step the edit uses that this app no longer has, and plays the sources as they are", async () => {
    const out = await runSteps([{ id: "blur", values: {} }], [], input);
    expect(out.files).toEqual({});
    expect(out.notes).toEqual([`${POST_NOTE}blur is not switched on in this app, so it was skipped`]);
  });
});

describe("one post copy per version", () => {
  it("keeps the copy that plays and removes the earlier steps' and older drafts' copies", async () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "post-prune-"));
    const file = (rel: string) => (mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }), writeFileSync(path.join(root, rel), "x"), path.join(root, rel));
    const face = file("face-refine/a-1.mov");
    const voice = file("voice/a-2.mov");
    const older = file("voice/a-0.mov");
    const side = file("voice/a-2.mov.counts.json");
    const faceSide = file("face-refine/a-1.mov.counts.json");
    await prune(root, new Set([voice]));
    expect([existsSync(face), existsSync(voice), existsSync(older)]).toEqual([false, true, false]);
    expect([existsSync(side), existsSync(faceSide)]).toEqual([true, false]);   // a kept copy's own files stay with it
  });
});

describe("what a running step says", () => {
  it("names each step as it starts, and passes the step's own line on", async () => {
    const said: string[] = [];
    const talks: EditorStep = { id: "faces", title: "Face refinement", about: "", run: async (i) => (i.say("Face refinement: setting up its face tools, the first time only (a few minutes)"), {}) };
    const quiet: EditorStep = { id: "voice", title: "Voice", about: "", run: async () => ({}) };
    await runSteps([{ id: "faces", values: {} }, { id: "voice", values: {} }], [talks, quiet], { ...input, say: (t) => said.push(t) });
    expect(said).toEqual(["Face refinement", "Face refinement: setting up its face tools, the first time only (a few minutes)", "Voice"]);
  });
});
