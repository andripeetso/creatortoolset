import { describe, expect, it } from "vitest";
import {
  mediaOwnerProjectId,
  originalProjectIds,
  sharedOriginalObjectKey,
} from "./project-copy";

describe("mediaOwnerProjectId", () => {
  it("keeps pointing at the original media owner across copies", () => {
    expect(mediaOwnerProjectId("source", {})).toBe("source");
    expect(mediaOwnerProjectId("copied", { mediaProjectId: "source" })).toBe(
      "source",
    );
  });
});

describe("original lookup for shared media", () => {
  it("checks the media owner before the copy", () => {
    expect(originalProjectIds("copied", { mediaProjectId: "source" })).toEqual([
      "source",
      "copied",
    ]);
    expect(originalProjectIds("source", {})).toEqual(["source"]);
  });

  it("uses the owner's object key when the copy has none", () => {
    expect(
      sharedOriginalObjectKey({}, { originalObjectKey: "projects/a/orig" }),
    ).toBe("projects/a/orig");
    expect(
      sharedOriginalObjectKey({ originalObjectKey: "projects/copy/orig" }),
    ).toBe("projects/copy/orig");
  });
});
