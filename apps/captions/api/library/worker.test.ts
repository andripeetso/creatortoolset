import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-worker-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { claimJob, enqueueJob, finishJob, prepareFirst, takingClips } = await import("./jobs");
const { LANES, nextJob } = await import("./worker");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const d = libraryDb();
for (const lib of ["lib_a", "lib_b"]) d.prepare(`INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'local', 'L', 'local', '{}', 1)`).run(lib);
const lane = (name: string) => LANES.find((l) => l.name === name)!.kinds;
/** What a lane runs next, as "version kind", and runs it (done at once). */
const next = (name: string, now = Date.now()) => {
  const id = nextJob(d, now, lane(name));
  if (id === null) return null;
  const job = claimJob(d, 300, now, "jobs", lane(name), id)!;
  finishJob(d, job.id, true);
  return `${job.version_id} ${job.kind}`;
};

beforeEach(() => {
  d.prepare("DELETE FROM jobs").run();
  takingClips.clear();
});

describe("the order clips are prepared in", () => {
  it("every clip's picture first, then the slow steps; in a lane, all lighter copies before the duplicate checks", () => {
    // v1 came in and was probed, v2 and v3 came in after: their probes and v1's picture are still to do
    for (const k of ["proxy", "fingerprint", "transcribe", "thumb"]) enqueueJob(d, "lib_a", "v1", k, "local");
    enqueueJob(d, "lib_a", "v2", "probe", "local");
    enqueueJob(d, "lib_a", "v3", "probe", "local");
    expect(nextJob(d, Date.now(), lane("transcripts"))).toBeNull(); // no transcript while a picture can run
    expect([next("files"), next("files"), next("files")]).toEqual(["v2 probe", "v3 probe", "v1 thumb"]);
    for (const v of ["v2", "v3"]) for (const k of ["proxy", "fingerprint"]) enqueueJob(d, "lib_a", v, k, "local");
    expect(next("transcripts")).toBe("v1 transcribe");
    expect([1, 2, 3, 4, 5, 6].map(() => next("files"))).toEqual(["v1 proxy", "v2 proxy", "v3 proxy", "v1 fingerprint", "v2 fingerprint", "v3 fingerprint"]);
  });

  it("slow steps wait while the library's folders hand clips over, and a picture waiting for its retry holds nothing back", () => {
    enqueueJob(d, "lib_a", "v1", "proxy", "local");
    takingClips.add("lib_a");
    expect(next("files")).toBeNull();
    takingClips.delete("lib_a");
    enqueueJob(d, "lib_a", "v2", "thumb", "local");
    d.prepare("UPDATE jobs SET run_after = ? WHERE kind = 'thumb'").run(Date.now() + 60_000); // failed once, tries again in a minute
    expect(next("files")).toBe("v1 proxy");
  });

  it("one library's pictures hold back only its own slow steps", () => {
    enqueueJob(d, "lib_a", "a1", "thumb", "local");
    enqueueJob(d, "lib_b", "b1", "transcribe", "local");
    enqueueJob(d, "lib_a", "a2", "transcribe", "local");
    expect(next("transcripts")).toBe("b1 transcribe");
    expect(next("transcripts")).toBeNull();
  });

  it("a clip the person opens goes before the others, its slow steps too", () => {
    for (const v of ["v1", "v2"]) enqueueJob(d, "lib_a", v, "proxy", "local");
    enqueueJob(d, "lib_a", "v3", "thumb", "local");
    prepareFirst("v2");
    expect([next("files"), next("files"), next("files")]).toEqual(["v2 proxy", "v3 thumb", "v1 proxy"]);
  });

  it("a description waits, unclaimed, while its clip's transcript is to come", () => {
    enqueueJob(d, "lib_a", "v1", "transcribe", "local");
    enqueueJob(d, "lib_a", "v1", "describe", "local");
    expect(next("ai")).toBeNull();
    next("transcripts");
    expect(next("ai")).toBe("v1 describe");
  });
});
