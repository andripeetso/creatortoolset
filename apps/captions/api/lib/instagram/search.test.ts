import { describe, expect, it } from "vitest";
import { buildSearchText, matchesQuery, queryTokens } from "./search";

describe("search", () => {
  it("builds a lowercase haystack and drops empties", () => {
    expect(buildSearchText(["@Creator", undefined, "  ", "Hook: Don't scroll", null])).toBe(
      "@creator hook: dont scroll",
    );
  });

  it("tokenizes queries", () => {
    expect(queryTokens("  Don't   Scroll ")).toEqual(["dont", "scroll"]);
  });

  it("requires every token", () => {
    const hay = buildSearchText(["@creator", "caption about puppy sleep", "on-screen: 3 tips"]);
    expect(matchesQuery("puppy tips", hay)).toBe(true);
    expect(matchesQuery("puppy walrus", hay)).toBe(false);
    expect(matchesQuery("", hay)).toBe(true);
  });
});
