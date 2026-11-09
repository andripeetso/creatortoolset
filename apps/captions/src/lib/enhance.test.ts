import { describe, expect, it } from "vitest";
import { retryPasses } from "./enhance";

describe("Audio Enhancer retry", () => {
  it("a parked run (needs_key) posts the engines it was queued with, not the picker's", () => {
    const parked = { status: "needs_key" as const, chain: ["elevenlabs", "nvidia"] };
    expect(retryPasses(parked, "nvidia", null)).toEqual(["elevenlabs", "nvidia"]);
    expect(retryPasses({ status: "needs_key", chain: ["elevenlabs"] }, "nvidia", "elevenlabs")).toEqual(["elevenlabs", null]);
  });

  it("an error or a cancelled run posts the picker's engines", () => {
    expect(retryPasses({ status: "error", chain: ["elevenlabs"] }, "nvidia", null)).toEqual(["nvidia", null]);
    expect(retryPasses({ status: "ready", chain: ["elevenlabs"] }, "nvidia", "elevenlabs")).toEqual(["nvidia", "elevenlabs"]);
  });

  it("a parked session without a saved chain falls back to the picker", () => {
    expect(retryPasses({ status: "needs_key" }, "elevenlabs", null)).toEqual(["elevenlabs", null]);
  });
});
