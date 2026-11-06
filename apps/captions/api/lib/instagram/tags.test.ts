import { describe, expect, it } from "vitest";
import { mergeTags, parseTagsPayload } from "./tags";

describe("parseTagsPayload", () => {
  it("reads kebab labels and kinds", () => {
    const tags = parseTagsPayload(
      JSON.stringify({
        tags: [
          { label: "talking-head", kind: "format", confidence: 0.9 },
          { label: "#Fitness", kind: "topic" },
          { label: "x", kind: "hook" },
        ],
      }),
    );
    expect(tags.map((t) => t.label)).toEqual(["talking-head", "Fitness"]);
    expect(tags[0].kind).toBe("format");
    expect(tags[0].source).toBe("ai");
  });
});

describe("mergeTags", () => {
  it("keeps a user tag over a later AI tag with the same label", () => {
    const user = {
      id: "t_1",
      label: "hook-on-screen",
      kind: "hook" as const,
      source: "user" as const,
    };
    const ai = { ...user, id: "t_2", source: "ai" as const };
    expect(mergeTags([user], [ai])).toEqual([user]);
  });
});
