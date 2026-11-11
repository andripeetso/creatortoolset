import { describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";
import type { EditorStep } from "../lib/plugin";
import { POST_NOTE, runSteps } from "./post";

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

  it("names a step the edit uses that this app no longer has, and plays the sources as they are", async () => {
    const out = await runSteps([{ id: "blur", values: {} }], [], input);
    expect(out.files).toEqual({});
    expect(out.notes).toEqual([`${POST_NOTE}blur is not switched on in this app, so it was skipped`]);
  });
});
