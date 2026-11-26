import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "work-slots-"));
process.env.DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// each library job runs until the test ends it
const ends = vi.hoisted(() => [] as (() => void)[]);
vi.mock("./library", async (actual) => ({
  ...(await actual<typeof import("./library")>()),
  runLibraryJob: () => new Promise<"done">((r) => ends.push(() => r("done"))),
}));
const { startComputerWorker } = await import("./computer");

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
};

it("with two slots: two library jobs run at once, a third waits for a slot, and the worker ends only after its jobs", async () => {
  const jobs = [1, 2, 3].map((id) => ({ pkg: null, lib: { v: 1, job: { id, kind: "fingerprint" } } }));
  let asked = 0;
  const fetch = async (u: string) => {
    if (!u.endsWith("/work/claim")) return Response.json({ ok: true });
    // as the server's long poll: nothing waiting answers after a moment, never at once
    if (asked >= jobs.length) await new Promise((r) => setTimeout(r, 10));
    return Response.json(jobs[asked++] ?? { pkg: null });
  };
  let ended: string | undefined;
  const worker = startComputerWorker({ server: "http://server.test", token: "ctd_test", fetch, retryMs: 10, idleMs: 150, slots: 2 }).then((r) => (ended = r));
  await until(() => ends.length === 2);
  await new Promise((r) => setTimeout(r, 60));
  expect(asked).toBe(2); // both slots taken: no third claim
  ends[0]!();
  await until(() => ends.length === 3); // a slot came free: the third job started beside the second
  ends[1]!();
  await new Promise((r) => setTimeout(r, 300)); // nothing more to claim for longer than idleMs, one job still running
  expect(ended).toBeUndefined();
  ends[2]!();
  expect(await worker).toBe("idle");
});
