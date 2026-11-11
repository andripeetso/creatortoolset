import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sentence } from "../../contracts/editor";
import type { Pack } from "../../contracts/packs";

// What the script step sends the AI for an edit made the plain way (footage, a brief, a script, versions, a target
// length), character for character. The golden file was written by this same test before the app had anything a person
// can add to that prompt, so this file must keep running as it is on an older checkout: it imports nothing newer than
// the script step itself. UPDATE_GOLDEN=1 writes the file; never do that on a branch that changes the prompt.

vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(m.aiFor), completeWithFallback: vi.fn(m.completeWithFallback) };
});

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-same-prompt-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-same-prompt-test-secret";
delete process.env.ANTHROPIC_API_KEY;

const { aiFor, completeWithFallback } = await import("../ai-complete");
const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { installPack } = await import("../lib/packs");
const { createEdit, saveStep } = await import("./store");
const { scriptPrompt } = await import("./script");
const { tick } = await import("./worker");

const file = path.join(import.meta.dirname, "golden", "script-prompt.json");
const golden = (): Record<string, { system: string; user: string }> => JSON.parse(readFileSync(file, "utf8"));
function same(name: string, got: { system: string; user: string }) {
  if (process.env.UPDATE_GOLDEN) writeFileSync(file, `${JSON.stringify({ ...(name === "plain" ? {} : golden()), [name]: got }, null, 2)}\n`);
  expect(got).toEqual(golden()[name]);
}

const sentences: Sentence[] = [1, 2, 3, 4, 5, 6].map((n) => ({ n, src: n <= 3 ? "ver_a" : "ver_b", text: `sentence ${n}`, s: n, e: n + 0.5, w0: 0, w1: 0 }));
const brief = { brief: "A reel for parents of crawlers.\nWarm and slow.", script: "Do puppies need tummy time?\nYes, a little every day.", versions: 2, targetS: 45 };
const answer = { lines: [{ id: "L1", text: "sentence 1", takes: [{ first: 1, last: 1, score: 1 }] }], versions: [{ name: "One", lines: ["L1"] }] };

const pack: Pack = {
  format: 1,
  id: "tiny-script",
  name: "Tiny script",
  version: "1.0.0",
  author: "tinyacrobatics",
  license: "CC0-1.0",
  description: "Test instructions for the script step.",
  instructions: { "editor.script": "Open on the line that asks a question." },
};

/** Makes a plain edit, runs its script step, and gives back what the AI was sent. */
async function sent(): Promise<{ system: string; user: string }> {
  const e = (await createEdit("mem-a", { sources: ["ver_a", "ver_b"], ...brief }))!;
  await saveStep(e.id, "analysis", { sentences, notes: [] });
  let got = { system: "", user: "" };
  vi.mocked(aiFor).mockReturnValueOnce({ only: ["anthropic"], apiKey: "test", mac: { label: "AI Editor script" } });
  vi.mocked(completeWithFallback).mockImplementationOnce(async (system, user, _c, parse) => {
    got = { system, user };
    return parse(JSON.stringify(answer));
  });
  libraryDb().prepare("DELETE FROM edit_jobs").run(); // the draft an earlier run's script step queued: tick takes the oldest step
  enqueueJob(libraryDb(), "mem-a", `${e.id}:`, "script", "mem-a", true, "edit_jobs");
  await tick();
  expect(libraryDb().prepare("SELECT state, error FROM edit_jobs WHERE edit_id = ? AND kind = 'script'").get(e.id)).toEqual({ state: "done", error: null });
  return got;
}

beforeAll(() => {
  libraryDb().exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'mem-a', 'A', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_a', 'lib_a', 'video', 'Take A', 'mem-a', 0), ('ast_b', 'lib_a', 'video', 'Take B', 'mem-a', 0);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES
      ('ver_a', 'ast_a', 1, 'k1', 1, 'x1', 'ready', 'mem-a', 0), ('ver_b', 'ast_b', 1, 'k2', 1, 'x2', 'ready', 'mem-a', 0);
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("AI Editor script: the prompt of a plain edit stays what it was", () => {
  it("an account that added nothing: the step sends the app's own prompt, the same as scriptPrompt gives", async () => {
    const got = await sent();
    same("plain", got);
    expect(scriptPrompt({ sentences, titles: { ver_a: "Take A", ver_b: "Take B" }, ...brief, packText: "" })).toEqual(got);
  });

  it("with a pack's script instructions installed: the app's prompt, then the pack's text, and nothing after it", async () => {
    await installPack("mem-a", pack, 0);
    const got = await sent();
    same("pack", got);
    expect(got.system.endsWith(`[Pack "Tiny script" 1.0.0 by tinyacrobatics]\nOpen on the line that asks a question.`)).toBe(true);
  });
});
