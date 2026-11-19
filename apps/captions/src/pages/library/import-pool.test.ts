import { describe, expect, it } from "vitest";
import { gate, gates, importGates, indexAtOnce, volumeOf } from "./import-pool";

// 11-19: 58 dropped files went in one after another. Every file now starts at once and waits only at a full stage.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `n` jobs through `run`, each a slow step; returns the most and the fewest seen running at once while busy. */
async function measure(n: number, run: (i: number, job: () => Promise<void>) => Promise<void>) {
  let now = 0;
  let most = 0;
  const seen: number[] = [];
  await Promise.all(
    Array.from({ length: n }, (_, i) =>
      run(i, async () => {
        now++;
        most = Math.max(most, now);
        seen.push(now);
        await sleep(15);
        now--;
      }).catch(() => {}),
    ),
  );
  return { most, seen };
}

describe("the import stages", () => {
  it("10 files copying to one volume: at most 3 at once, and more than one", async () => {
    const copy = gates(3);
    const { most } = await measure(10, (_, job) => copy("/Volumes/NAS", job));
    expect(most).toBe(3);
  });

  it("each volume has its own 3: two volumes copy 6 at once", async () => {
    const copy = gates(3);
    const { most } = await measure(10, (i, job) => copy(i % 2 ? "/Volumes/NAS" : "/", job));
    expect(most).toBe(6);
  });

  it("one failed or slow file holds only its own place: the rest all finish", async () => {
    const g = gate(2);
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        g(async () => {
          if (i === 0) throw new Error("the share went away");
          if (i === 1) await sleep(60); // a slow one
          await sleep(5);
          done.push(i);
        }).catch(() => {}),
      ),
    );
    expect(done.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("the page's gates: copies 3 per volume, indexing the cores up to 4, server calls 4", async () => {
    expect(indexAtOnce(16)).toBe(4);
    expect(indexAtOnce(2)).toBe(2);
    expect(indexAtOnce(0)).toBe(4);
    const g = importGates();
    expect((await measure(10, (_, job) => g.server(job))).most).toBe(4);
    expect((await measure(10, (_, job) => g.copy("/Volumes/MONOLITH", job))).most).toBe(3);
  });

  it("volumeOf: a /Volumes disk by its name, everything else the computer's own disk", () => {
    expect(volumeOf("/Volumes/MONOLITH DIGITAL/MOO/FOOTAGE/a.mov")).toBe("/Volumes/MONOLITH DIGITAL");
    expect(volumeOf("~/Movies/Creator Toolset/Tiny/Source media")).toBe("/");
    expect(volumeOf("/Users/tiny/Movies/a.mov")).toBe("/");
  });
});
