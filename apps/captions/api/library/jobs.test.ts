import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLibraryDb } from "./db";
import type { DatabaseSync } from "node:sqlite";
import { claimJob, enqueueJob, finishJob, requeueExpired } from "./jobs";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-jobs-"));
let db: DatabaseSync;
const state = (kind: string) => db.prepare("SELECT state, attempts, error FROM jobs WHERE kind = ?").get(kind) as { state: string; attempts: number; error: string | null };

beforeAll(() => {
  db = openLibraryDb(path.join(dir, "library.db"));
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("job queue", () => {
  it("a second enqueue of the same version and kind is a no-op while the job is queued or done", () => {
    enqueueJob(db, "lib_1", "ver_a", "probe", "u1");
    enqueueJob(db, "lib_1", "ver_a", "probe", "u1");
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'probe'").get() as { n: number }).n).toBe(1);
    const job = claimJob(db, 300, 1000)!;
    finishJob(db, job.id, true, undefined, 1000);
    enqueueJob(db, "lib_1", "ver_a", "probe", "u1");
    expect(state("probe").state).toBe("done");
  });

  it("an expired lease goes back to the queue and is claimed again; a live lease is left alone", () => {
    enqueueJob(db, "lib_1", "ver_b", "thumb", null);
    const job = claimJob(db, 300, 1000)!;
    expect(requeueExpired(db, 1000 + 299_000)).toBe(0); // lease still live
    expect(state("thumb").state).toBe("running");
    expect(requeueExpired(db, 1000 + 301_000)).toBe(1);
    expect(state("thumb").state).toBe("queued");
    expect(claimJob(db, 300, 1000 + 301_000)!.id).toBe(job.id);
  });

  it("three failures mark the job failed; each retry waits 60 s times the attempts so far", () => {
    enqueueJob(db, "lib_1", "ver_c", "proxy", "u1");
    let t = 10_000;
    const job1 = claimJob(db, 300, t)!;
    finishJob(db, job1.id, false, "boom", t);
    expect(state("proxy").state).toBe("queued");
    expect(claimJob(db, 300, t + 59_999)).toBeNull(); // backoff: 60 s after the first failure
    t += 60_000;
    const job2 = claimJob(db, 300, t)!;
    finishJob(db, job2.id, false, "boom", t);
    t += 120_000;
    const job3 = claimJob(db, 300, t)!;
    finishJob(db, job3.id, false, "boom", t);
    expect(state("proxy")).toEqual({ state: "failed", attempts: 3, error: "boom" });
    expect(claimJob(db, 300, t + 10 * 60_000)).toBeNull();
  });

  it("a failed job queued again by enqueue starts from zero attempts", () => {
    enqueueJob(db, "lib_1", "ver_c", "proxy", "u1");
    expect(state("proxy")).toEqual({ state: "queued", attempts: 0, error: null });
  });
});
