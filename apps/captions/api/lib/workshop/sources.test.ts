import { describe, expect, it } from "vitest";
import { splitBundle, bundleFiles, inlineFiles, keptFiles, knowledgeFiles, knowledgeIndex, knowledgePath, parseDraft, parseReading } from "./sources";
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
    expect(knowledgePath("a/b.md")).toBe("context/a/b.md");
    expect(knowledgePath("../a//.b.md")).toBe("context/a/b.md");
  });
});

describe("a project's material (Write it for me, and the files it keeps)", () => {
  it("files every file: one the answer skips or garbles is kept, a left-out one says why; no JSON = the answer is the instructions", () => {
    const names = ["kit/README.md", "kit/a/about.md", "kit/b/about.md", "kit/privacy.md"];
    const d = parseDraft(
      '{"notes":"Sold in shops.","files":[{"file":"kit/privacy.md","keep":false,"kind":"other","about":"Legal.","why":"a privacy policy"},{"file":"kit/a/about.md","keep":true,"kind":"poem","about":"Who it is for."}]}',
      names,
    );
    expect(d.notes).toBe("Sold in shops.");
    expect(d.files).toEqual([
      { file: "kit/README.md", keep: true },
      { file: "kit/a/about.md", keep: true, about: "Who it is for." },
      { file: "kit/b/about.md", keep: true },
      { file: "kit/privacy.md", keep: false, kind: "other", about: "Legal.", why: "a privacy policy" },
    ]);
    expect(parseDraft("Plain instructions.", names).files.every((f) => f.keep)).toBe(true);
    // the folder the Mac reads them in, or a "./", is not part of the name
    expect(parseDraft('{"notes":"x","files":[{"file":"material/kit/privacy.md","keep":false},{"file":"./kit/README.md","keep":false}]}', names).files.filter((f) => !f.keep).map((f) => f.file)).toEqual(["kit/README.md", "kit/privacy.md"]);
    expect(() => parseDraft('{"files":[]}', names)).toThrow();
    // what the material says two ways comes back as sentences; anything else in the list is dropped
    expect(d.unsure).toEqual([]);
    expect(parseDraft('{"notes":"x","unsure":["A says 1, B says 2.", 3, " "]}', names).unsure).toEqual(["A says 1, B says 2."]);
  });

  it("a folder kept as one source: each file under its path, its section's lines exact, filed only when every file says what it is", () => {
    const files = [
      { name: "kit/a.md", text: "one\ntwo", about: "A." },
      { name: "kit/b.md", text: "three", about: "B." },
    ];
    const { text, sections } = bundleFiles(files);
    const lines = text.split("\n");
    for (const s of sections) expect(lines[s.from - 1]).toBe(`# ${s.title}`);
    expect(lines.slice(sections[0]!.from - 1, sections[0]!.to)).toEqual(["# kit/a.md", "", "one", "two"]);
    expect(lines.slice(sections[1]!.from - 1, sections[1]!.to)).toEqual(["# kit/b.md", "", "three"]);
    expect(keptFiles(files).filed?.sections).toHaveLength(2);
    expect(keptFiles([files[0]!, { name: "kit/c.md", text: "x" }]).filed).toBeUndefined();
    // the writer's folder has each file at its own path again, and its index says what each is
    const k = keptFiles(files);
    const source = { id: "s", name: "kit", text: k.text, addedAt: 0, ...k.filed };
    expect(knowledgeFiles([source])).toEqual({ "context/kit/a.md": "one\ntwo", "context/kit/b.md": "three" });
    expect(knowledgeIndex([source])).toContain("## context/kit/a.md\nA.\n\n## context/kit/b.md\nB.");
    // a book with sections stays one file
    expect(Object.keys(knowledgeFiles([{ id: "b", name: "book.md", text: "one\ntwo\nthree", addedAt: 0, sections: [{ title: "One", from: 1, to: 1, about: "" }, { title: "Two", from: 2, to: 3, about: "" }] }]))).toEqual(["context/book.md"]);
    expect(keptFiles([{ name: "a.md", text: "x", about: "A.", kind: "nonsense" }]).filed?.kind).toBe("other");
  });

  it("off the Mac the files share the prompt: the last of a folder is never cut off, a short file's room goes to the long ones", () => {
    const out = inlineFiles([{ name: "a", text: "x".repeat(5_000) }, { name: "b", text: "end" }], 4_000);
    expect(out).toContain("=== b ===\nend");
    // b's unused share goes to a
    expect(out).toContain(`=== a ===\n${"x".repeat(3_997)}\n…[shortened]`);
    expect(inlineFiles([{ name: "a", text: "whole" }], 4_000)).toBe("=== a ===\nwhole");
  });
});

describe("splitBundle", () => {
  it("gives a folder kept as one source its files back", () => {
    const { text } = bundleFiles([{ name: "kit/a.md", text: "# A\nalpha" }, { name: "kit/sub/b.md", text: "beta" }]);
    expect(splitBundle("kit", text)).toEqual([
      { path: "kit/a.md", text: "# A\nalpha", about: "" },
      { path: "kit/sub/b.md", text: "beta", about: "" },
    ]);
    expect(splitBundle("kit", "# kit/a.md\n\nonly one")).toBeNull();
    expect(splitBundle("other", text)).toBeNull();
  });
});
