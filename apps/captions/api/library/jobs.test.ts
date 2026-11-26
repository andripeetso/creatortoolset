import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLibraryDb } from "./db";
import type { DatabaseSync } from "node:sqlite";
import { claimJob, defer, enqueueJob, extendLease, finishJob, graceHeld, parkJob, requeueExpired, wakeBudgetStops } from "./jobs";

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

describe("a stopped job", () => {
  it("stays stopped when its step's late finish or failure arrives: neither marks it done nor queues it again", () => {
    enqueueJob(db, "lib_1", "ver_stop", "stoptest", "u1");
    const id = (db.prepare("SELECT id FROM jobs WHERE kind = 'stoptest'").get() as { id: number }).id;
    claimJob(db, 300, 1000, "jobs", undefined, id);
    db.prepare("UPDATE jobs SET state = 'failed', lease_until = NULL, error = 'Stopped' WHERE id = ?").run(id); // what stopEdit does
    finishJob(db, id, true, undefined, 2000);
    expect(state("stoptest").state).toBe("failed");
    finishJob(db, id, false, "late", 2000);
    expect(state("stoptest")).toMatchObject({ state: "failed", error: "Stopped" });
  });
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

describe("long jobs and the editor's table", () => {
  // a database of its own: the queue above still holds jobs that would be claimed first
  let db: DatabaseSync;
  const state = (kind: string) => db.prepare("SELECT state, attempts FROM jobs WHERE kind = ?").get(kind) as { state: string; attempts: number };
  beforeAll(() => {
    db = openLibraryDb(path.join(dir, "long.db"));
  });
  afterAll(() => db.close());

  it("a heartbeat keeps a running job out of requeueExpired", () => {
    enqueueJob(db, "lib_1", "ver_d", "render", "u1");
    const job = claimJob(db, 300, 1000)!;
    extendLease(db, job.id, 300, 1000 + 250_000); // lease now runs to 551 s
    expect(requeueExpired(db, 1000 + 400_000)).toBe(0);
    expect(state("render").state).toBe("running");
  });

  it("a server's start gives each job a computer holds a whole lease, and none to a job it ran itself", () => {
    enqueueJob(db, "lib_1", "ver_g1", "held", "u1");
    enqueueJob(db, "lib_1", "ver_g2", "own", "u1");
    const held = claimJob(db, 300, 1000, "jobs", ["held"])!;
    claimJob(db, 300, 1000, "jobs", ["own"]);
    db.prepare("UPDATE jobs SET held_by = 'dev_tiny', claim_id = 'c1' WHERE id = ?").run(held.id);
    // the server was away 250 s; back, it gives the held job its lease again before it puts anything back
    expect(graceHeld(db, 300, 1000 + 250_000)).toBe(1);
    expect(requeueExpired(db, 1000 + 400_000)).toBe(1); // only the job it ran itself: that run is gone
    expect(state("held")).toMatchObject({ state: "running", attempts: 1 });
    expect(state("own")).toMatchObject({ state: "queued", attempts: 1 });
    // claimed again, it is no one's until its claimer says (work/library-package.ts)
    db.prepare("UPDATE jobs SET state = 'queued' WHERE id = ?").run(held.id);
    expect(claimJob(db, 300, 10 ** 13, "jobs", ["held"])).toMatchObject({ held_by: null, claim_id: null });
    db.prepare("DELETE FROM jobs WHERE kind IN ('held', 'own')").run(); // the tests after count this table's jobs
  });

  it("defer puts a job back in the queue later without counting the attempt", () => {
    enqueueJob(db, "lib_1", "ver_e", "analyze", "u1");
    const job = claimJob(db, 300, 1000)!;
    expect(job.attempts).toBe(1);
    defer(db, job.id, 30, 1000);
    expect(state("analyze")).toMatchObject({ state: "queued", attempts: 0 });
    expect(claimJob(db, 300, 1000 + 29_999)).toBeNull();
    expect(claimJob(db, 300, 1000 + 30_000)!.attempts).toBe(1);
  });

  it("a late answer leaves a stopped job stopped: a failed try, a park and a defer change only a running job", () => {
    enqueueJob(db, "lib_1", "ver_g", "stopped", "u1");
    const job = claimJob(db, 300, 2_000_000, "jobs", ["stopped"])!;
    db.prepare("UPDATE jobs SET state = 'failed', error = 'Stopped' WHERE id = ?").run(job.id);
    finishJob(db, job.id, false, "boom", 2_000_000);
    parkJob(db, job.id, "no key");
    defer(db, job.id, 0, 2_000_000);
    expect(db.prepare("SELECT state, error FROM jobs WHERE id = ?").get(job.id)).toEqual({ state: "failed", error: "Stopped" });
    // removed while its step was out: nothing to record, and nothing thrown
    db.prepare("DELETE FROM jobs WHERE id = ?").run(job.id);
    expect(() => finishJob(db, job.id, false, "boom")).not.toThrow();
  });

  it("the library's claim never takes an edit_jobs row, and edit_id comes from version_id", () => {
    enqueueJob(db, "ws_1", "edit_9:", "script", "u1", false, "edit_jobs");
    expect(claimJob(db, 300, 10 ** 12)).toBeNull();
    expect(db.prepare("SELECT edit_id FROM edit_jobs").get()).toEqual({ edit_id: "edit_9" });
    expect(claimJob(db, 300, 10 ** 12, "edit_jobs")).toMatchObject({ kind: "script", version_id: "edit_9:" });
  });
});

describe("a job parked by a key's spent budget", () => {
  it("is queued again by wakeBudgetStops, and a job parked for a missing key is not", () => {
    for (const [ver, why] of [["ver_budget", "Deepgram key reached its monthly budget of $10: raise it in Settings → API keys"], ["ver_nokey", "Add your Deepgram key in Settings → API keys"]]) {
      enqueueJob(db, "lib_b", ver, "budgettest", "u1");
      const id = (db.prepare("SELECT id FROM jobs WHERE version_id = ?").get(ver) as { id: number }).id;
      claimJob(db, 300, 1000, "jobs", undefined, id);
      parkJob(db, id, why);
    }
    expect(wakeBudgetStops(db)).toBe(1);
    const of = (ver: string) => (db.prepare("SELECT state, error FROM jobs WHERE version_id = ?").get(ver) as { state: string; error: string | null });
    expect(of("ver_budget")).toEqual({ state: "queued", error: null });
    expect(of("ver_nokey").state).toBe("needs_key");
  });
});
