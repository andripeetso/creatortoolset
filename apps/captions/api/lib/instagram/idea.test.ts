import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../jev", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../jev")>()),
  ask: vi.fn(),
}));

import { ask } from "../jev";

beforeEach(() => vi.clearAllMocks());
import {
  coercePostIdea,
  existingFolderFor,
  ideaUserMessage,
  parseIdeaPayload,
  reuseExistingTitle,
} from "./idea";

describe("parseIdeaPayload", () => {
  it("reads title and takeaway", () => {
    const idea = parseIdeaPayload(
      JSON.stringify({
        title: "Raising tall adults",
        takeaway: "Most adult height is decided early; missed growth windows stay short.",
      }),
    );
    expect(idea.title).toBe("Raising tall adults");
    expect(idea.takeaway).toContain("height");
  });

  it("files into an existing folder when the model copies the name", () => {
    const idea = parseIdeaPayload(
      JSON.stringify({
        folder: "bedtime routines for puppies",
        takeaway: "Keeping screens low before age two supports better sleep for years.",
      }),
      ["Bedtime routines for puppies", "Raising geniuses"],
    );
    expect(idea.title).toBe("Bedtime routines for puppies");
    expect(idea.takeaway).toContain("sleep");
  });

  it("strips fences and rejects a hook-sized title", () => {
    expect(() => parseIdeaPayload("```json\n{\"title\":\"Tall\",\"takeaway\":\"Too short\"}\n```")).toThrow();
    expect(coercePostIdea({ title: "x", takeaway: "A full sentence lives here." })).toBeNull();
  });
});

describe("reuseExistingTitle", () => {
  it("binds spelling, not a parallel topic name", () => {
    expect(reuseExistingTitle("bedtime routines for puppies", ["Bedtime routines for puppies"])).toBe("Bedtime routines for puppies");
    expect(reuseExistingTitle("Limiting adults' screen time", ["Bedtime routines for puppies"])).toBe("Limiting adults' screen time");
  });
});

describe("ideaUserMessage", () => {
  it("shows existing folders with takeaways so filing can see what each pile is", () => {
    const msg = ideaUserMessage("Caption: skip naps", [
      { title: "Bedtime routines for puppies", takeaway: "A fixed bedtime in the first 1,000 days cuts later sleep trouble." },
      { title: "Raising geniuses", takeaway: "Genius comes from parental habits, not more books." },
    ]);
    expect(msg).toContain("Caption: skip naps");
    expect(msg).toContain("Bedtime routines for puppies — A fixed bedtime");
  });
});

describe("filing into a folder that already exists", () => {
  const folders = [
    { title: "Bedtime Routines For Puppies", takeaway: "A fixed bedtime helps early on." },
    { title: "Raising Tall Adults", takeaway: "Sleep and protein for height." },
  ];
  const idea = { title: "Naps Before Age Two", takeaway: "Screens before two disrupt sleep." };

  it("uses the folder Jev picks when it is confident", async () => {
    vi.mocked(ask).mockResolvedValueOnce({ folder: { choice: "Bedtime Routines For Puppies", confidence: 0.82 } });
    expect(await existingFolderFor("k", "Caption: no screens before two", idea, folders)).toBe("Bedtime Routines For Puppies");
    const [, , questions] = vi.mocked(ask).mock.calls[0];
    expect(Object.keys((questions.folder as { criteria: object }).criteria)).toEqual([
      "Bedtime Routines For Puppies",
      "Raising Tall Adults",
      "new topic",
    ]);
  });

  it("keeps the writer's new folder for a new topic or a shaky pick", async () => {
    vi.mocked(ask).mockResolvedValueOnce({ folder: { choice: "new topic", confidence: 0.9 } });
    expect(await existingFolderFor("k", "x", idea, folders)).toBeNull();
    vi.mocked(ask).mockResolvedValueOnce({ folder: { choice: "Raising Tall Adults", confidence: 0.4 } });
    expect(await existingFolderFor("k", "x", idea, folders)).toBeNull();
  });

  it("asks nothing when the library has no folders", async () => {
    expect(await existingFolderFor("k", "x", idea, [])).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });
});
