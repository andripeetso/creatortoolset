import { describe, expect, it } from "vitest";
import {
  copyProjectName,
  mediaOwnerProjectId,
  originalProjectIds,
  sharedOriginalObjectKey,
} from "./project-copy";

describe("copyProjectName", () => {
  it("appends (copy) and keeps untitled for a blank name", () => {
    expect(copyProjectName("HowWeRaiseChildren_d2")).toBe(
      "HowWeRaiseChildren_d2 (copy)",
    );
    expect(copyProjectName("  ")).toBe("untitled (copy)");
  });

  it("stays within the project name limit", () => {
    const name = "n".repeat(120);
    const copied = copyProjectName(name);
    expect(copied.length).toBe(120);
    expect(copied.endsWith(" (copy)")).toBe(true);
  });
});

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
