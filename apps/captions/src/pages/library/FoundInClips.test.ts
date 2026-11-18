import { describe, expect, it } from "vitest";
import { shortLine } from "./FoundInClips";

describe("shortLine", () => {
  it("keeps the clause naming the searched words", () => {
    expect(shortLine("The player opens the Grand Market window and browses listed items and Jewel of Chaos prices…", "grand market")).toBe("The player opens the Grand Market window");
    expect(shortLine("…Devias market shop as the player interacts with the Market Clerk. Sound…", "market")).toBe("Devias market shop");
  });
  it("cuts a long clause to a few words around the hit", () => {
    expect(shortLine("The player taps on the Market Clerk to open the Grand Market window showing items", "grand")).toBe("…Clerk to open the Grand Market window");
  });
  it("falls back to the first clause, and to nothing", () => {
    expect(shortLine("Entering the building. Sound: doors", "zzz")).toBe("Entering the building");
    expect(shortLine("", "x")).toBe("");
  });
});
