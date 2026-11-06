import { describe, expect, it, vi } from "vitest";
import { PostBatcher } from "./apify-batch";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PostBatcher", () => {
  it("merges requests inside the window into one run per type", async () => {
    const run = vi.fn(async (urls: string[], type: string) => new Map(urls.map((u) => [u, `${type}:${u}`])));
    const b = new PostBatcher(run, { waitMs: 5, maxSize: 50 });
    const results = await Promise.all([
      b.request("https://ig/p/A/", false),
      b.request("https://ig/p/B/", false),
      b.request("https://ig/reel/C/", true),
    ]);
    expect(results).toEqual(["posts:https://ig/p/A/", "posts:https://ig/p/B/", "reels:https://ig/reel/C/"]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map((c) => c[0].length).sort()).toEqual([1, 2]);
  });

  it("retries misses with the other type in one more run, then gives up", async () => {
    const run = vi.fn(async (urls: string[], type: string) =>
      new Map(
        urls
          .filter((u) => !u.includes("none") && (type === "reels") === u.includes("/reel/"))
          .map((u) => [u, u]),
      ),
    );
    const b = new PostBatcher(run, { waitMs: 5, maxSize: 50 });
    const ok = b.request("https://ig/reel/X/", false); // hinted wrong: found on the retry
    const bad = b.request("https://ig/p/none/", true); // never found
    await expect(ok).resolves.toBe("https://ig/reel/X/");
    await expect(bad).rejects.toThrow(/no post/);
    expect(run).toHaveBeenCalledTimes(4);
    expect(b.runs).toBe(4);
  });

  it("flushes early at maxSize and shares one result across duplicate requests", async () => {
    const run = vi.fn(async (urls: string[]) => new Map(urls.map((u) => [u, u.length])));
    const b = new PostBatcher(run, { waitMs: 10_000, maxSize: 2 });
    const a = b.request("https://ig/p/A/", false);
    const a2 = b.request("https://ig/p/A/", false);
    const c = b.request("https://ig/p/CC/", false);
    await tick();
    expect(await Promise.all([a, a2, c])).toEqual([15, 15, 16]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects every waiter when the run fails", async () => {
    const run = vi.fn(async () => {
      throw new Error("apify down");
    });
    const b = new PostBatcher(run, { waitMs: 5, maxSize: 50 });
    await expect(Promise.all([b.request("https://ig/p/A/", false), b.request("https://ig/p/B/", false)])).rejects.toThrow(
      /apify down/,
    );
  });
});
