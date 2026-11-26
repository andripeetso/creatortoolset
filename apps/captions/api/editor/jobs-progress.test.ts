import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// The edit page's steps (jobsOf): a step on one of the person's computers says which computer and, while it downloads,
// the bytes and time left; a queued one says why it waits. What the computer last said (work/place.ts) and the wait
// line (reach.ts) are other parts' code: stubbed here.

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-jobs-progress-"));
process.env.DATA_DIR = dir;

const beats = new Map<number, { device: string; line?: string; done?: number; total?: number; leftS?: number; at: number }>();
vi.mock("../work/place", () => ({ progressOf: (id: number) => beats.get(id) }));
vi.mock("./reach", async (real) => ({ ...(await real<typeof import("./reach")>()), waitLine: () => "Waits for one of your computers. Open Creator Toolset on your Mac" }));

const { libraryDb } = await import("../library/db");
const { pairDevice } = await import("../lib/devices");
const { jobsOf } = await import("./store");

// its server may still be writing as the file ends: a few tries (the run removes its whole temp folder anyway)
afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* still written to: left for the run's own cleanup */ }
});

const add = (version: string, kind: string, state: string, device: string | null = null) =>
  Number(
    libraryDb()
      .prepare("INSERT INTO edit_jobs (library_id, version_id, kind, state, actor, device) VALUES ('lib_1', ?, ?, ?, 'tiny', ?)")
      .run(version, kind, state, device).lastInsertRowid,
  );

describe("jobsOf: which computer works on a step", () => {
  it("a running step a computer reports on: its name, line, bytes and time left; one it holds without a beat yet: its name; a queued one: the wait line", () => {
    const mac = pairDevice("tiny", "Mac Studio").device;
    const fetching = add("edit_a:", "analyze", "running", mac.id);
    beats.set(fetching, { device: "Mac Studio", line: "downloading 2 of 13 proxies", done: 340e6, total: 1.2e9, leftS: 180, at: Date.now() });
    add("edit_a:v1", "preview", "running", mac.id);
    add("edit_a:v2", "preview", "queued");
    add("edit_a:v3", "preview", "done");
    const jobs = jobsOf("edit_a");
    expect(jobs[0]).toMatchObject({ kind: "analyze", line: "downloading 2 of 13 proxies", progress: { device: "Mac Studio", done: 340e6, total: 1.2e9, leftS: 180 } });
    expect(jobs[1]).toMatchObject({ variant: "v1", progress: { device: "Mac Studio" } });
    expect(jobs[2]).toMatchObject({ variant: "v2", line: "Waits for one of your computers. Open Creator Toolset on your Mac" });
    expect(jobs[2]!.progress).toBeUndefined();
    expect(jobs[3]!.progress).toBeUndefined();
    expect(jobs[3]!.line).toBeUndefined();
  });
});
