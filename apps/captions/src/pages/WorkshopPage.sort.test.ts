import { describe, expect, it } from "vitest";
import { shownSessions } from "./WorkshopPage";

type Row = Parameters<typeof shownSessions>[0][number];
const row = (id: string, status: string | undefined, updatedAt: number): Row => ({ id, status, updatedAt, kinds: ["reel"] }) as unknown as Row;

describe("session list sort", () => {
  const rows = [
    row("published", "published", 9),
    row("toPost", "toPost", 1),
    row("idea-old", undefined, 2),
    row("editing", "editing", 5),
    row("ready", "ready", 4),
    row("idea-new", "draft", 8),
    row("production", "production", 3),
  ];

  it("sorts by workflow stage, most complete at the bottom, newest first within a stage", () => {
    expect(shownSessions(rows, "all", "status").map((r) => r.id)).toEqual(["idea-new", "idea-old", "ready", "production", "editing", "toPost", "published"]);
  });

  it("recent sorts by last update only", () => {
    expect(shownSessions(rows, "all", "recent").map((r) => r.id)).toEqual(["published", "idea-new", "editing", "ready", "production", "idea-old", "toPost"]);
  });
});
