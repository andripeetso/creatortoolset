import { describe, expect, it } from "vitest";
import { reordered, withHidden } from "./Tabs";

describe("reordered", () => {
  const ids = ["music", "desktop", "mobile"];
  it("puts the dragged tab before or after the one it is dropped on", () => {
    expect(reordered(ids, "desktop", "music", false)).toEqual(["desktop", "music", "mobile"]);
    expect(reordered(ids, "music", "mobile", true)).toEqual(["desktop", "mobile", "music"]);
    expect(reordered(ids, "mobile", "desktop", false)).toEqual(["music", "mobile", "desktop"]);
  });
  it("is null when nothing moves or a tab is not movable", () => {
    expect(reordered(ids, "music", "music", true)).toBeNull();
    expect(reordered(ids, "music", "desktop", false)).toBeNull();
    expect(reordered(ids, "all", "music", false)).toBeNull();
  });
});

describe("withHidden", () => {
  it("puts the dragged order back around the hidden tabs", () => {
    expect(withHidden(["a", "h", "b", "c"], ["a", "b", "c"], ["c", "a", "b"])).toEqual(["c", "h", "a", "b"]);
  });
});
