import { describe, expect, it } from "vitest";
import {
  applyKeep,
  avgRank,
  avgVirality,
  keepLabel,
  matchesSavedFor,
  onShelf,
  parseIdeaStatus,
  parseKeep,
  parseRank,
  parseSavedFor,
  parseShelf,
  virality,
} from "./research";
import type { SavedFor } from "./types";

describe("parseIdeaStatus", () => {
  it("accepts the four research marks", () => {
    expect(parseIdeaStatus("done")).toBe("done");
    expect(parseIdeaStatus("nope")).toBeUndefined();
  });
});

describe("parseSavedFor", () => {
  it("accepts content, format, both, and an empty clear", () => {
    expect(parseSavedFor("format")).toEqual(["format"]);
    expect(parseSavedFor(["format", "content", "format"])).toEqual(["content", "format"]);
    expect(parseSavedFor("both")).toEqual(["content", "format"]);
    expect(parseSavedFor([])).toEqual([]);
    expect(parseSavedFor(null)).toEqual([]);
    expect(parseSavedFor("nope")).toBeUndefined();
    expect(parseSavedFor(["nope"])).toBeUndefined();
  });
});

describe("matchesSavedFor", () => {
  it("counts unmarked posts as content, not format", () => {
    expect(matchesSavedFor(undefined, "content")).toBe(true);
    expect(matchesSavedFor(undefined, "format")).toBe(false);
    expect(matchesSavedFor(["format"], "content")).toBe(false);
    expect(matchesSavedFor(["format"], "format")).toBe(true);
    expect(matchesSavedFor(["content", "format"], "content")).toBe(true);
  });
});

describe("parseRank", () => {
  it("keeps 1–10 and drops the rest", () => {
    expect(parseRank(7)).toBe(7);
    expect(parseRank("10")).toBe(10);
    expect(parseRank(0)).toBeUndefined();
    expect(parseRank(11)).toBeUndefined();
    expect(parseRank("")).toBeUndefined();
  });
});

describe("avgRank", () => {
  it("ignores unranked members", () => {
    expect(avgRank([8, undefined, 6])).toBe(7);
    expect(avgRank([undefined])).toBeUndefined();
  });
});

describe("virality", () => {
  it("prefers plays then likes", () => {
    expect(virality({ plays: 12000, likes: 3, fetchedAt: 0 })).toBe(12000);
    expect(virality({ likes: 40, fetchedAt: 0 })).toBe(40);
    expect(avgVirality([{ plays: 10, fetchedAt: 0 }, { plays: 30, fetchedAt: 0 }])).toBe(20);
  });
});

describe("Know-how shelf", () => {
  it("lists Know-how only when asked", () => {
    expect(parseShelf("knowhow")).toBe("knowhow");
    expect(parseShelf("anything")).toBe("library");
    expect(onShelf({}, "library")).toBe(true);
    expect(onShelf({ knowhow: true }, "library")).toBe(false);
    expect(onShelf({ knowhow: true }, "knowhow")).toBe(true);
    expect(onShelf({}, "knowhow")).toBe(false);
    expect(onShelf({ knowhow: true }, "all")).toBe(true);
  });

  it("reads the choice from a body, refusing junk", () => {
    expect(parseKeep({})).toEqual({});
    expect(parseKeep({ savedFor: "format" })).toEqual({ savedFor: ["format"] });
    expect(parseKeep({ knowhow: true })).toEqual({ knowhow: true });
    expect(parseKeep({ knowhow: "yes" })).toBeUndefined();
    expect(parseKeep({ savedFor: "ideas" })).toBeUndefined();
  });

  it("moves a post to Know-how and back, saying when it changed", () => {
    const meta: { savedFor?: SavedFor[]; knowhow?: boolean } = { savedFor: ["format"] };
    expect(keepLabel(meta)).toBe("Format");
    expect(applyKeep(meta, { knowhow: true })).toBe(true);
    expect(keepLabel(meta)).toBe("Know-how");
    expect(applyKeep(meta, { knowhow: true })).toBe(false);
    expect(applyKeep(meta, { savedFor: ["content", "format"] })).toBe(true);
    expect(meta.knowhow).toBeUndefined();
    expect(keepLabel(meta)).toBe("Content and Format");
    expect(applyKeep(meta, {})).toBe(false);
  });
});
