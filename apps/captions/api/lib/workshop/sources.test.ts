import { describe, expect, it } from "vitest";
import { knowledgePath, parseReading } from "./sources";
import { matchKnowledge } from "./prompt";

describe("knowledge filing", () => {
  it("keeps line numbers inside the text, unknown kinds become other, and a section can be fetched alone", () => {
    const f = parseReading('ok {"kind":"poem","about":"A short text.","sections":[{"title":"Two","from":2,"to":99},{"title":"","from":1,"to":1}]}', 3);
    expect(f.kind).toBe("other");
    expect(f.sections).toEqual([{ title: "Two", from: 2, to: 3, about: "" }]);
    expect(() => parseReading('{"kind":"book"}', 3)).toThrow();

    const files = [{ id: "a", name: "book.md", text: "one\ntwo\nthree", addedAt: 0, sections: f.sections }];
    expect(matchKnowledge(files, "K1§1")?.text).toBe("two\nthree");
    expect(matchKnowledge(files, "K1#2")).toBeUndefined();
    expect(matchKnowledge(files, "K1")?.text).toBe("one\ntwo\nthree");
    expect(knowledgePath("INDEX.md")).toBe("context/file-INDEX.md");
    expect(knowledgePath("a/b.md")).toBe("context/a-b.md");
  });
});
