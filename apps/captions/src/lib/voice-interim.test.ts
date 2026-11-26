import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interimWords } from "./voice-interim";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("interimWords: one pass in flight, stopped at once", () => {
  it("skips a tick while the last pass still runs", async () => {
    let finish = (_: string | null) => {};
    const run = vi.fn(() => new Promise<string | null>((r) => (finish = r)));
    const show = vi.fn();
    const s = interimWords(run, show, 2000);
    await vi.advanceTimersByTimeAsync(6500);
    expect(run).toHaveBeenCalledTimes(1);
    finish("hello");
    await vi.advanceTimersByTimeAsync(0);
    expect(show).toHaveBeenCalledWith("hello");
    s.stop();
  });

  it("stop() ends the ticks and aborts the pass in flight; its late answer shows nothing", async () => {
    let signal: AbortSignal | undefined;
    let finish = (_: string | null) => {};
    const run = vi.fn((sig: AbortSignal) => {
      signal = sig;
      return new Promise<string | null>((r) => (finish = r));
    });
    const show = vi.fn();
    const s = interimWords(run, show, 2000);
    await vi.advanceTimersByTimeAsync(2000);
    s.stop();
    expect(signal?.aborted).toBe(true);
    finish("too late");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(show).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a failed pass shows nothing and the next tick tries again", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue("again");
    const show = vi.fn();
    const s = interimWords(run, show, 1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith("again");
    s.stop();
  });

  it("null shows nothing for that tick", async () => {
    const show = vi.fn();
    const s = interimWords(async () => null, show, 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(show).not.toHaveBeenCalled();
    s.stop();
  });
});
