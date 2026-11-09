import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Snapshot history: kept per account across pulls and reconnects, never sent to the browser. Files go to a temp dir.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "snapshots-"));

const { mergeSnapshots, patchAccount, publicAccount, readConnectors, saveAccounts } = await import("./store");

describe("mergeSnapshots", () => {
  it("adds a day's rows and replaces that day's earlier rows for the same posts", () => {
    const day1 = [{ day: "2026-11-01", id: "v1", views: 100 }];
    const after = mergeSnapshots(day1, "2026-11-02", [{ day: "2026-11-02", id: "v1", views: 150 }]);
    expect(after).toEqual([
      { day: "2026-11-01", id: "v1", views: 100 },
      { day: "2026-11-02", id: "v1", views: 150 },
    ]);
    const again = mergeSnapshots(after, "2026-11-02", [{ day: "2026-11-02", id: "v1", views: 170 }]);
    expect(again).toEqual([
      { day: "2026-11-01", id: "v1", views: 100 },
      { day: "2026-11-02", id: "v1", views: 170 },
    ]);
  });

  it("drops rows older than 90 days and keeps the rest", () => {
    const old = { day: "2026-07-01", id: "v0", views: 5 };
    const kept = { day: "2026-10-10", id: "v0", views: 9 };
    const out = mergeSnapshots([old, kept], "2026-11-02", []);
    expect(out).toEqual([kept]);
  });
});

describe("snapshot history on a connected account", () => {
  const user = "snapshot-user";
  const tt = { platform: "tiktok" as const, platformId: "o1", handle: "tinyacrobatics", via: "login" as const, token: "tok" };

  it("survives a reconnect and stays out of the browser view", () => {
    saveAccounts(user, [tt]);
    patchAccount(user, "tiktok:o1", { snapshots: [{ day: "2026-11-01", id: "v1", views: 100 }] });
    saveAccounts(user, [{ ...tt, token: "new-tok" }]);
    const stored = readConnectors(user).accounts.find((a) => a.key === "tiktok:o1")!;
    expect(stored.snapshots).toEqual([{ day: "2026-11-01", id: "v1", views: 100 }]);
    expect(stored.token).toBe("new-tok");
    const view = publicAccount(stored);
    expect("snapshots" in view).toBe(false);
    expect("token" in view).toBe(false);
  });

  it("keeps the daily account history across a restart and keeps it out of the browser view", async () => {
    const ig = { platform: "instagram" as const, platformId: "1784", handle: "tinyacrobatics", via: "login" as const, token: "tok" };
    saveAccounts(user, [ig]);
    const daily = [{ day: "2026-11-01", id: "instagram:1784", reach: 40, newFollows: 3 }];
    patchAccount(user, "instagram:1784", { daily });
    // a restart: a fresh module reads the same files from disk, with nothing cached
    vi.resetModules();
    const fresh = await import("./store");
    const stored = fresh.readConnectors(user).accounts.find((a) => a.key === "instagram:1784")!;
    expect(stored.daily).toEqual(daily);
    expect("daily" in fresh.publicAccount(stored)).toBe(false);
  });
});
