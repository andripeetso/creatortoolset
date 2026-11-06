import { describe, expect, it } from "vitest";
import { MAX_LIBRARY_IDEAS, omitWorkshopPiles, omitWorkshopPosts, parseIdeaBoard, workshopPostIds } from "./idea-board";

describe("parseIdeaBoard", () => {
  it("keeps at most 10 ideas and gives each post to the first pile only", () => {
    const allowed = ["a", "b", "c", "d"];
    const ideas = parseIdeaBoard(
      JSON.stringify({
        ideas: [
          {
            title: "Bedtime routines for toddlers",
            description: "Keep a fixed bedtime through the first 1,000 days.",
            postIds: ["a", "b"],
          },
          {
            title: "Limiting kids' screen time",
            description: "A second name for the same posts should not steal them.",
            postIds: ["b", "c"],
          },
          {
            title: "Raising geniuses",
            description: "Genius comes from a handful of parental habits.",
            postIds: ["c"],
          },
        ],
      }),
      allowed,
    );
    expect(ideas).toHaveLength(2);
    expect(ideas[0]!.postIds).toEqual(["a", "b"]);
    expect(ideas[1]!.title).toBe("Limiting kids' screen time");
    expect(ideas[1]!.postIds).toEqual(["c"]);
  });

  it("drops unknown ids and caps the board", () => {
    const many = Array.from({ length: MAX_LIBRARY_IDEAS + 3 }, (_, i) => ({
      title: `Idea number ${i + 1} here`,
      description: "A strong remakeable pile from the library.",
      postIds: [`id-${i}`],
    }));
    const allowed = many.map((x) => x.postIds[0]!);
    const ideas = parseIdeaBoard(JSON.stringify({ ideas: many }), [...allowed, "ghost"]);
    expect(ideas).toHaveLength(MAX_LIBRARY_IDEAS);
    expect(parseIdeaBoard(
      JSON.stringify({
        ideas: [
          {
            title: "Bedtime routines for toddlers",
            description: "Keep a fixed bedtime through the first 1,000 days.",
            postIds: ["ghost", "a"],
          },
        ],
      }),
      ["a"],
    )[0]!.postIds).toEqual(["a"]);
  });
});

describe("omitWorkshopPiles", () => {
  it("drops a remake whose posts are already in a workshop session", () => {
    const taken = workshopPostIds([{ postIds: ["swim-a", "swim-b", "extra"] }]);
    expect([...taken].sort()).toEqual(["extra", "swim-a", "swim-b"]);
    expect(omitWorkshopPosts([{ id: "swim-a" }, { id: "nap-a" }], taken).map((p) => p.id)).toEqual(["nap-a"]);
    expect(
      omitWorkshopPiles(
        [
          { title: "Swimming boosts early milestones", postIds: ["swim-a", "swim-b"] },
          { title: "Bedtime routines for toddlers", postIds: ["nap-a", "nap-b"] },
          { title: "Mixed", postIds: ["swim-a", "nap-a"] },
        ],
        taken,
      ),
    ).toEqual([
      { title: "Bedtime routines for toddlers", postIds: ["nap-a", "nap-b"] },
      { title: "Mixed", postIds: ["nap-a"] },
    ]);
  });
});
