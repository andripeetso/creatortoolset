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
        title: "Raising tall kids",
        takeaway: "Most adult height is decided early; missed growth windows stay short.",
      }),
    );
    expect(idea.title).toBe("Raising tall kids");
    expect(idea.takeaway).toContain("height");
  });

  it("files into an existing folder when the model copies the name", () => {
    const idea = parseIdeaPayload(
      JSON.stringify({
        folder: "bedtime routines for toddlers",
        takeaway: "Keeping screens low before age two supports better sleep for years.",
      }),
      ["Bedtime routines for toddlers", "Raising geniuses"],
    );
    expect(idea.title).toBe("Bedtime routines for toddlers");
    expect(idea.takeaway).toContain("sleep");
  });

  it("strips fences and rejects a hook-sized title", () => {
    expect(() => parseIdeaPayload("```json\n{\"title\":\"Tall\",\"takeaway\":\"Too short\"}\n```")).toThrow();
    expect(coercePostIdea({ title: "x", takeaway: "A full sentence lives here." })).toBeNull();
  });
});

describe("reuseExistingTitle", () => {
  it("binds spelling, not a parallel topic name", () => {
    expect(reuseExistingTitle("bedtime routines for toddlers", ["Bedtime routines for toddlers"])).toBe("Bedtime routines for toddlers");
    expect(reuseExistingTitle("Limiting kids' screen time", ["Bedtime routines for toddlers"])).toBe("Limiting kids' screen time");
  });
});

describe("ideaUserMessage", () => {
  it("shows existing folders with takeaways so filing can see what each pile is", () => {
    const msg = ideaUserMessage("Caption: skip naps", [
      { title: "Bedtime routines for toddlers", takeaway: "A fixed bedtime in the first 1,000 days cuts later sleep trouble." },
      { title: "Raising geniuses", takeaway: "Genius comes from parental habits, not more books." },
    ]);
    expect(msg).toContain("Caption: skip naps");
    expect(msg).toContain("Bedtime routines for toddlers — A fixed bedtime");
  });
});

describe("filing into a folder that already exists", () => {
  const folders = [
    { title: "Bedtime Routines For Toddlers", takeaway: "A fixed bedtime helps early on." },
    { title: "Raising Tall Kids", takeaway: "Sleep and protein for height." },
  ];
  const idea = { title: "Naps Before Age Two", takeaway: "Screens before two disrupt sleep." };

  it("uses the folder Jev picks when it is confident", async () => {
    vi.mocked(ask).mockResolvedValueOnce({ folder: { choice: "Bedtime Routines For Toddlers", confidence: 0.82 } });
    expect(await existingFolderFor("k", "Caption: no screens before two", idea, folders)).toBe("Bedtime Routines For Toddlers");
    const [, , questions] = vi.mocked(ask).mock.calls[0];
    expect(Object.keys((questions.folder as { criteria: object }).criteria)).toEqual([
      "Bedtime Routines For Toddlers",
      "Raising Tall Kids",
      "new topic",
    ]);
  });

  it("keeps the writer's new folder for a new topic or a shaky pick", async () => {
    vi.mocked(ask).mockResolvedValueOnce({ folder: { choice: "new topic", confidence: 0.9 } });
    expect(await existingFolderFor("k", "x", idea, folders)).toBeNull();
    vi.mocked(ask).mockResolvedValueOnce({ folder: { choice: "Raising Tall Kids", confidence: 0.4 } });
    expect(await existingFolderFor("k", "x", idea, folders)).toBeNull();
  });

  it("asks nothing when the library has no folders", async () => {
    expect(await existingFolderFor("k", "x", idea, [])).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });
});
