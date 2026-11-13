import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sentence } from "../../contracts/editor";

vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(m.aiFor), completeWithFallback: vi.fn(m.completeWithFallback) };
});

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-script-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-script-test-secret";
delete process.env.ANTHROPIC_API_KEY;

const { aiFor, completeWithFallback } = await import("../ai-complete");
const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { whoFor } = await import("../library/describe");
const { createEdit, readEdit, saveEdit, saveStep, viewOf } = await import("./store");
const { allocate, parseScript, scriptPrompt, takeMap } = await import("./script");
const { tick } = await import("./worker");

/** Sentences 1-3 in file A, 4-6 in file B: two takes of the same two lines. */
const sentences: Sentence[] = [1, 2, 3, 4, 5, 6].map((n) => ({ n, src: n <= 3 ? "ver_a" : "ver_b", text: `sentence ${n}`, s: n, e: n + 0.5, w0: 0, w1: 0 }));
const answer = {
  lines: [
    { id: "L1", text: "We teach rolls", takes: [{ first: 1, last: 1, score: 0.9 }, { first: 4, last: 4, score: 0.8 }] },
    { id: "L2", text: "Join the class", takes: [{ first: 2, last: 3, score: 0.7 }, { first: 5, last: 6, score: 0.6 }, { first: 3, last: 4, score: 1 }] },
    { id: "L3", text: "Out of range", takes: [{ first: 9, last: 9, score: 1 }] },
  ],
  versions: [
    { name: "Short", lines: ["L1", "L2", "L9"] },
    { name: "Reversed", lines: ["L2", "L1"] },
    { name: "Extra", lines: ["L1"] },
  ],
};

let editId = "";
const scriptJob = () => libraryDb().prepare("SELECT state, error FROM edit_jobs WHERE edit_id = ? AND kind = 'script'").get(editId) as { state: string; error: string | null };
async function runScript() {
  enqueueJob(libraryDb(), "mem-a", `${editId}:`, "script", "mem-a", true, "edit_jobs");
  await tick();
  return scriptJob();
}

beforeAll(async () => {
  libraryDb().exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'mem-a', 'A', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_a', 'lib_a', 'video', 'Take A', 'mem-a', 0), ('ast_b', 'lib_a', 'video', 'Take B', 'mem-a', 0);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES
      ('ver_a', 'ast_a', 1, 'k1', 1, 'x1', 'ready', 'mem-a', 0), ('ver_b', 'ast_b', 1, 'k2', 1, 'x2', 'ready', 'mem-a', 0);
  `);
  const e = (await createEdit("mem-a", { sources: ["ver_a", "ver_b"], brief: "A reel for parents of crawlers.", versions: 2 }))!;
  editId = e.id;
  await saveStep(editId, "analysis", { sentences, notes: [] });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("AI Editor script: takes", () => {
  it("drops takes outside the footage or across two files with a note, and the versions past the count", () => {
    const m = takeMap(parseScript(JSON.stringify(answer)), sentences, 2);
    expect(m.lines.map((l) => [l.id, l.takes.map((t) => `${t.first}-${t.last}`)])).toEqual([
      ["L1", ["1-1", "4-4"]],
      ["L2", ["2-3", "5-6"]],
    ]);
    expect(m.versions).toEqual([
      { name: "v1", title: "Short", lines: ["L1", "L2"] },
      { name: "v2", title: "Reversed", lines: ["L2", "L1"] },
    ]);
    expect(m.notes).toEqual([
      "Line L2: take 3-4 runs across two files: dropped",
      "Line L3: take 9-9 is not in sentences 1-6: dropped",
      "Line L3 has no take in the footage: left out",
      "Short names lines that are not there (L9): skipped them",
    ]);
  });

  it("versions share no take while a line has a spare one; then one is reused, with a note", () => {
    const m = takeMap(parseScript(JSON.stringify(answer)), sentences, 3);
    const { plans, notes } = allocate(m.lines, m.versions);
    const takes = (i: number) => plans[i]!.lines.map((l) => `${l.line}:${l.take.first}-${l.take.last}`);
    expect(takes(0)).toEqual(["L1:1-1", "L2:2-3"]);
    expect(takes(1)).toEqual(["L2:5-6", "L1:4-4"]);
    expect(takes(2)).toEqual(["L1:1-1"]);
    expect(notes).toEqual(["Extra reuses line L1's take 1-1: it has no other"]);
  });

  it("refuses an answer with no lines", () => {
    expect(() => parseScript('{"versions": []}')).toThrow(/no lines/);
  });
});

describe("AI Editor script: the prompt", () => {
  it("carries the user's brief and script verbatim, and no built-in style rules", () => {
    const brief = "Warm and slow. Open on the question parents ask most.";
    const script = "Do puppies need tummy time?\nYes, a little every day.";
    const { system, user } = scriptPrompt({ sentences, titles: { ver_a: "Take A", ver_b: "Take B" }, brief, script, versions: 2, targetS: 45 });
    expect(user).toContain(brief);
    expect(user).toContain(script);
    expect(user).toContain("4 S2 4.0-4.5 sentence 4");
    expect(system).not.toMatch(/hook|punch|tone|style|energy|viral|engag|retention|call to action|\bcta\b|emotion|story|pacing/i);
  });

  it("adds pack instructions after the app's own system prompt; an empty text changes nothing", () => {
    const input = { sentences, titles: { ver_a: "Take A", ver_b: "Take B" }, brief: "", script: "", versions: 1, targetS: 30 };
    const plain = scriptPrompt(input);
    expect(scriptPrompt({ ...input, packText: "" })).toEqual(plain);
    expect(scriptPrompt({ ...input, packText: "PACK-SCRIPT-ZQ" }).system).toBe(`${plain.system}\n\nPACK-SCRIPT-ZQ`);
  });
});

describe("AI Editor script: the step", () => {
  it("runs on the creator's AI and saves lines and plans", async () => {
    vi.mocked(aiFor).mockReturnValueOnce({ only: ["anthropic"], apiKey: "test", mac: { label: "AI Editor script" } });
    vi.mocked(completeWithFallback).mockImplementationOnce(async (_s, user, _c, parse) => {
      expect(user).toContain("A reel for parents of crawlers.");
      return parse(JSON.stringify(answer));
    });
    expect(await runScript()).toEqual({ state: "done", error: null });
    expect(vi.mocked(aiFor)).toHaveBeenLastCalledWith(expect.objectContaining({ username: "mem-a" }), "editor", "AI Editor script");
    const view = viewOf(readEdit(editId)!);
    expect(view.lines.map((l) => l.id)).toEqual(["L1", "L2"]);
    expect(view.plans.map((p) => p.name)).toEqual(["v1", "v2"]);
    expect(view.notes).toContain("Line L3 has no take in the footage: left out");
    // nobody named the edit: it is named after the first line of its first version
    expect(view.name).toBe(view.lines.find((l) => l.id === view.plans[0]!.lines[0]!.line)!.text);
    // a name the person gave stays through the next run
    await saveEdit({ ...readEdit(editId)!, name: "Crawlers" });
    vi.mocked(aiFor).mockReturnValueOnce({ only: ["anthropic"], apiKey: "test", mac: { label: "AI Editor script" } });
    vi.mocked(completeWithFallback).mockImplementationOnce(async (_s, _u, _c, parse) => parse(JSON.stringify(answer)));
    expect(await runScript()).toEqual({ state: "done", error: null });
    expect(readEdit(editId)!.name).toBe("Crawlers");
  });

  it("with no AI route parks as needs_key with aiFor's own message", async () => {
    const off = aiFor(whoFor("mem-a"), "editor", "check").off;
    expect(off).toBeTruthy();
    expect(await runScript()).toEqual({ state: "needs_key", error: off });
  });

  it("a Mac that never picks the request up parks as needs_key, not failed", async () => {
    vi.mocked(aiFor).mockReturnValueOnce({ only: ["mac"], mac: { label: "AI Editor script" } }); // no device: the relay answers unclaimed
    const r = await runScript();
    expect(r.state).toBe("needs_key");
    expect(r.error).toMatch(/No Mac runs this provider/);
  });

  it("a failed AI run fails the step", async () => {
    vi.mocked(aiFor).mockReturnValueOnce({ only: ["anthropic"], apiKey: "test", mac: { label: "AI Editor script" } });
    vi.mocked(completeWithFallback).mockRejectedValueOnce(new Error("The model returned an empty answer"));
    expect((await runScript()).state).toBe("queued"); // a failure retries after a backoff, as every job does
    expect(scriptJob().error).toBe("The model returned an empty answer");
  });
});
