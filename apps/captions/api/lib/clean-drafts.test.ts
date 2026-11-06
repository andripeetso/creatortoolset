import { describe, expect, it, vi } from "vitest";
import { LatestDrafts } from "./clean-drafts";
const ticket = (revision: number, client = "editor") => ({ client, revision });
const signal = () => new AbortController().signal;
describe("latest-only draft scheduling", () => {
  it("drops intermediate slider revisions and waits for old process cleanup before starting the latest", async () => {
    const queue = new LatestDrafts(),
      started: number[] = [];
    let cleanup!: () => void,
      firstAborted = false;
    const exited = new Promise<void>((resolve) => {
      cleanup = resolve;
    });
    const first = queue.run("video", ticket(1), signal(), async (s) => {
      started.push(1);
      await new Promise<void>((resolve) =>
        s.addEventListener(
          "abort",
          () => {
            firstAborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      await exited;
      s.throwIfAborted();
    });
    await vi.waitFor(() => expect(started).toEqual([1]));
    const rest = [2, 3, 4].map((n) =>
      queue.run("video", ticket(n), signal(), async () => {
        started.push(n);
        return n;
      }),
    );
    const results = Promise.allSettled([first, ...rest]);
    expect(firstAborted).toBe(true);
    expect(started).toEqual([1]);
    cleanup();
    const settled = await results;
    expect(started).toEqual([1, 4]);
    expect(settled.map((item) => item.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "fulfilled",
    ]);
  });
  it("ignores late arrivals and cancellation of older revisions without interrupting the latest", async () => {
    const queue = new LatestDrafts();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const newest = queue.run("video", ticket(8), signal(), async (s) => {
      await gate;
      s.throwIfAborted();
      return "latest";
    });
    await expect(
      queue.run("video", ticket(7), signal(), async () => "stale"),
    ).rejects.toMatchObject({ name: "AbortError" });
    queue.cancel("video", ticket(7));
    release();
    await expect(newest).resolves.toBe("latest");
    queue.cancel("video", ticket(9));
    await expect(
      queue.run(
        "video",
        ticket(9),
        signal(),
        async () => "late cancelled request",
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("cancels a disconnected request and lets a later export proceed after cleanup", async () => {
    const queue = new LatestDrafts(),
      connection = new AbortController();
    let cleaned = false;
    const draft = queue.run(
      "video",
      ticket(1),
      connection.signal,
      async (s) => {
        await new Promise<void>((resolve) =>
          s.addEventListener("abort", () => resolve(), { once: true }),
        );
        cleaned = true;
        s.throwIfAborted();
      },
    );
    const outcome = Promise.allSettled([draft]);
    await Promise.resolve();
    connection.abort();
    await queue.stop("video");
    expect(cleaned).toBe(true);
    expect((await outcome)[0].status).toBe("rejected");
  });
});
