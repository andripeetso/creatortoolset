import { describe, expect, it } from "vitest";
import {
  clusterIdeaPosts,
  ideaMatchesQuery,
  ideaTerms,
  needsIdeaDistill,
  sameGrandIdea,
} from "./instagram-ideas";

describe("ideaTerms", () => {
  it("stems swimming/kids and drops stopwords", () => {
    expect(ideaTerms("Swimming for kids")).toEqual(["swim", "kid"]);
    expect(ideaTerms("Raising tall kids")).toEqual(["rai", "tall", "kid"]);
  });
});

describe("sameGrandIdea", () => {
  it("merges near-duplicate folder names and keeps different subjects apart", () => {
    const swim = {
      title: "Swimming for kids",
      takeaway: "Kids who swam before five were 11 months ahead in reading.",
    };
    const swim2 = {
      title: "Kids swimming before five",
      takeaway: "Early swimming predicted later reading scores.",
    };
    const tall = {
      title: "Raising tall kids",
      takeaway: "Most adult height is decided early; missed growth windows stay short.",
    };
    const genius = {
      title: "Raising geniuses",
      takeaway: "Genius comes from a handful of parental habits, not more books.",
    };
    const bedtime = {
      title: "Bedtime routines for toddlers",
      takeaway: "A fixed bedtime in the first 1,000 days cuts the risk of up to 30 later sleep problems.",
    };
    const bedtime2 = {
      title: "Limiting kids' screen time",
      takeaway: "Keeping screens low before age two supports better sleep for years.",
    };
    expect(sameGrandIdea(swim, swim2)).toBe(true);
    expect(sameGrandIdea(tall, genius)).toBe(false);
    expect(sameGrandIdea(swim, tall)).toBe(false);
    expect(sameGrandIdea(bedtime, bedtime2)).toBe(false);
  });
});

describe("clusterIdeaPosts", () => {
  it("puts two swimming posts in one folder and leaves undistilled out", () => {
    const posts = [
      { id: "a", idea: { title: "Swimming for kids", takeaway: "Kids who swam before five were 11 months ahead in reading." }, rank: 5 },
      { id: "b", idea: { title: "Kids swimming before five", takeaway: "Early swimming predicted later reading scores." }, rank: 3 },
      { id: "c", idea: { title: "Raising geniuses", takeaway: "Genius comes from a handful of parental habits, not more books." } },
      { id: "d" },
    ];
    const groups = clusterIdeaPosts(posts, () => 0);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.title).toBe("Swimming for kids");
    expect(groups[0]!.posts.map((p) => p.id)).toEqual(["a", "b"]);
    expect(groups[1]!.title).toBe("Raising geniuses");
  });
});

describe("ideaMatchesQuery", () => {
  it("matches a folder name from a short search", () => {
    expect(ideaMatchesQuery({ title: "Raising tall kids", takeaway: "Height is decided early." }, "tall")).toBe(true);
    expect(ideaMatchesQuery({ title: "Raising tall kids", takeaway: "Height is decided early." }, "genius")).toBe(false);
  });
});

describe("needsIdeaDistill", () => {
  it("skips distilled, duplicate, Know-how, busy, and already-queued posts", () => {
    const idea = { title: "Raising tall kids", takeaway: "Height is decided early." };
    expect(needsIdeaDistill({ idea })).toBe(false);
    expect(needsIdeaDistill({ duplicateOf: "x" })).toBe(false);
    expect(needsIdeaDistill({ knowhow: true, status: "ready" })).toBe(false);
    expect(needsIdeaDistill({ status: "processing" })).toBe(false);
    expect(needsIdeaDistill({ jobs: [{ type: "idea", status: "pending" }] })).toBe(false);
    expect(needsIdeaDistill({ status: "ready" })).toBe(true);
  });
});
