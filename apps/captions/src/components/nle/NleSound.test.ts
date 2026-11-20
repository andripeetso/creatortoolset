import { afterEach, describe, expect, it, vi } from "vitest";
import { measured, spoken } from "@/lib/nle/loudness";
import type { NleTimeline } from "@/lib/nle/model";
import { measure, nleSound, type SourceSound } from "./NleSound";

const b64 = (xs: number[]) => Buffer.from(Float32Array.from(xs).buffer).toString("base64");
const tl = { timeline: { fps: 25 }, sources: {}, tracks: {} } as NleTimeline;

describe("measure (Normalize and Lower Under Voice ask first)", () => {
  const ask = nleSound.ask;
  afterEach(() => {
    nleSound.ask = ask;
    measured.clear();
    spoken.clear();
    vi.useRealTimers();
  });

  it("waits with the line while a computer measures, then keeps the blocks and words", async () => {
    vi.useFakeTimers();
    const answers: Record<string, SourceSound>[] = [
      { voice: { line: "Waiting for your computer", words: [[1, 2]] }, gone: { error: "Not found" } },
      { voice: { blocks: b64([0.5, 0.25]), words: [[1, 2]] } },
    ];
    const asked: string[][] = [];
    nleSound.ask = async (srcs) => (asked.push(srcs), answers.shift()!);
    const lines: string[] = [];
    const done = measure(tl, ["voice", "gone"], (l) => lines.push(l), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await done).toEqual({ gone: "Not found" });
    expect(lines).toEqual(["Waiting for your computer"]);
    expect(asked).toEqual([["voice", "gone"], ["voice"]]);
    expect(Array.from(measured.get("voice")!.blocks)).toEqual([0.5, 0.25]);
    expect(spoken.get("voice")).toEqual([[1, 2]]);
  });

  it("asks nothing for what it already has", async () => {
    measured.set("voice", { blocks: [1] });
    nleSound.ask = vi.fn();
    expect(await measure(tl, ["voice"], () => {}, new AbortController().signal)).toEqual({});
    expect(nleSound.ask).not.toHaveBeenCalled();
  });
});
