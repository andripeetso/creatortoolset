import { describe, expect, it } from "vitest";
import { removedMetadata, sameCleanOptions } from "./clean-workspace";

describe("workspace comparisons", () => {
  it("counts actual removed entries, leaving retained tags out of the removal count", () => {
    const title = { where: "File", key: "title", value: "Keep" };
    const location = { where: "File", key: "location", value: "Remove" };
    expect(removedMetadata([title, location], [title])).toEqual([location]);
    expect(removedMetadata([title], [title])).toEqual([]);
  });
  it("detects unapplied tool changes against the selected version", () => {
    const original = { stripMetadata: true, unique: false };
    expect(sameCleanOptions(original, { ...original })).toBe(true);
    expect(sameCleanOptions(original, { ...original, unique: true })).toBe(
      false,
    );
    expect(
      sameCleanOptions(original, { ...original, stripMetadata: false }),
    ).toBe(false);
  });
});
