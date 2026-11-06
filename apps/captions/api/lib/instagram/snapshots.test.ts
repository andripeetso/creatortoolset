import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendSnapshot, diffSnapshots, snapshotFromCounts } from "./snapshots";

describe("snapshots", () => {
  it("appends and diffs public counts", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ig-snap-"));
    const file = path.join(dir, "snapshots.json");
    const a = snapshotFromCounts({ likes: 10, comments: 1, plays: 100 }, "apify");
    a.at = 1_000;
    await appendSnapshot(file, a);
    const b = snapshotFromCounts({ likes: 12, comments: 3, plays: 250 }, "apify");
    b.at = 1_000 + 86_400_000;
    const list = await appendSnapshot(file, b);
    expect(list).toHaveLength(2);
    expect(diffSnapshots(list[0], list[1])).toEqual({
      elapsedMs: 86_400_000,
      likes: 2,
      comments: 2,
      plays: 150,
      followers: undefined,
    });
  });

  it("appends follower snapshots from profile and catalog fetches", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ig-acct-snap-"));
    const file = path.join(dir, "snapshots.json");
    const profile = await appendSnapshot(file, {
      at: 1_000,
      source: "apify",
      followers: 100,
      following: 10,
      posts: 4,
    });
    expect(profile).toHaveLength(1);
    const catalog = await appendSnapshot(file, {
      at: 1_000 + 86_400_000,
      source: "session",
      followers: 108,
      following: 10,
      posts: 5,
    });
    expect(catalog).toHaveLength(2);
    expect(diffSnapshots(catalog[0]!, catalog[1]!)).toMatchObject({ followers: 8, elapsedMs: 86_400_000 });
    const skipped = await appendSnapshot(file, {
      at: 1_000 + 86_400_000 + 1_000,
      source: "apify",
      followers: 108,
      following: 10,
      posts: 5,
    });
    expect(skipped).toHaveLength(2);
  });
});
