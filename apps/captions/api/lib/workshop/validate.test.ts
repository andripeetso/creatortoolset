import { describe, expect, it } from "vitest";
import {
  parseDocCreate,
  parseDocPatch,
  parseFrameworkInput,
  parseGenerateInput,
  parseRuleInput,
  parseTurnInput,
  parseFiles,
  parseHandles,
  parseProjectInput,
  parseLayoutRequest,
  parseSessionPatch,
  parseSources,
  parseSteps,
  slugFilename,
} from "./validate";

const id = (n: number) => `post-${String(n).padStart(6, "0")}`;

describe("parseProjectInput", () => {
  it("clamps, trims and merges over a base", () => {
    const base = { name: "Tiny Acrobatics", audience: "parents", voice: "warm", cta: "link", notes: "", knowledge: [] };
    const out = parseProjectInput({ voice: "  playful  ", audience: "x".repeat(700) }, base);
    expect(out).toMatchObject({ name: "Tiny Acrobatics", voice: "playful", cta: "link" });
    expect(out.audience).toHaveLength(600);
    expect(out.knowledge).toEqual([]);
  });
  it("requires a name", () => {
    expect(() => parseProjectInput({ audience: "parents" })).toThrow(/name/);
  });
  it("keeps knowledge files, names them, and caps the dump", () => {
    const files = parseProjectInput({
      name: "Sample",
      knowledge: [
        { id: "file-1", name: "  brand.md  ", text: "We say movement play", addedAt: 9 },
        { name: "", text: "scratch" },
        { id: "file-1", name: "dup", text: "ignored id" },
        "nope",
      ],
    }).knowledge ?? [];
    expect(files).toHaveLength(3);
    expect(files[0]).toMatchObject({ id: "file-1", name: "brand.md", text: "We say movement play", addedAt: 9 });
    expect(files[1]!.name).toBe("Note");
    expect(files[1]!.id).toMatch(/^[a-z0-9-]{6,40}$/);
    expect(files[2]!.id).not.toBe("file-1");
    const many = parseProjectInput({
      name: "Sample",
      knowledge: Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, text: "x".repeat(10_000) })),
    }).knowledge ?? [];
    expect(many.length).toBeLessThanOrEqual(24);
    expect(many.reduce((n, f) => n + f.text.length, 0)).toBeLessThanOrEqual(160_000);
  });
  it("leaves knowledge alone on a patch that does not send it", () => {
    const kept = [{ id: "file-1", name: "voice.md", text: "warm", addedAt: 1 }];
    const out = parseProjectInput({ voice: "direct" }, { name: "Sample", audience: "", voice: "", cta: "", notes: "", knowledge: kept });
    expect(out.knowledge).toEqual(kept);
  });
  it("links or clears an Analyzer account", () => {
    const linked = parseProjectInput({ name: "Sample", accountId: "acct-01" });
    expect(linked.accountId).toBe("acct-01");
    const kept = parseProjectInput({ notes: "x" }, { name: "Sample", audience: "", voice: "", cta: "", notes: "", knowledge: [], accountId: "acct-01" });
    expect(kept.accountId).toBe("acct-01");
    expect(parseProjectInput({ name: "Sample", accountId: null }).accountId).toBeNull();
    expect(() => parseProjectInput({ name: "Sample", accountId: "x" })).toThrow(/Unknown account/);
  });
});

describe("parseHandles", () => {
  it("keeps known platforms, trims and drops the @, drops blanks and unknown keys", async () => {
    expect(parseHandles({ instagram: "  @tinyacrobatics ", youtube: "  ", myspace: "x", tiktok: 5 })).toEqual({ instagram: "tinyacrobatics" });
    expect(parseHandles("nope")).toEqual({});
    expect(parseHandles(null)).toEqual({});
  });

  it("refuses characters outside letters, digits, dot, dash and underscore, by platform", async () => {
    expect(() => parseHandles({ x: "bad handle!" })).toThrow("Handle for x: letters, numbers, dot, dash or underscore");
    expect(() => parseHandles({ instagram: "a".repeat(61) })).toThrow(/Handle for instagram/);
  });

  it("keeps at most five", async () => {
    const six = { instagram: "a", facebook: "b", youtube: "c", tiktok: "d", x: "e" };
    expect(Object.keys(parseHandles(six))).toHaveLength(5);
  });

  it("is set on the project input: a patch without it keeps the old handles, a blank one clears them", () => {
    const base = { name: "Sample", audience: "", voice: "", cta: "", notes: "", knowledge: [], handles: { instagram: "old" } };
    expect(parseProjectInput({ name: "Sample", handles: { tiktok: "@new" } }).handles).toEqual({ tiktok: "new" });
    expect(parseProjectInput({ notes: "x" }, base).handles).toEqual({ instagram: "old" });
    expect(parseProjectInput({ handles: {} }, base).handles).toEqual({});
    expect(parseProjectInput({ name: "Sample" }).handles).toEqual({});
  });
});

describe("parseFrameworkInput / parseSteps", () => {
  it("accepts steps as a list or numbered lines", () => {
    expect(parseSteps("1. Hook\n2) Story\n\nOffer")).toEqual(["Hook", "Story", "Offer"]);
    expect(parseSteps(["a", "", "b"])).toEqual(["a", "b"]);
    expect(parseSteps(Array.from({ length: 20 }, (_, i) => `s${i}`))).toHaveLength(12);
  });
  it("needs a name and two steps", () => {
    expect(() => parseFrameworkInput({ name: "X", steps: ["one"] })).toThrow(/two steps/);
    expect(() => parseFrameworkInput({ steps: ["a", "b"] })).toThrow(/name/);
    expect(parseFrameworkInput({ name: "X", steps: ["a", "b"], example: "" }).example).toBeUndefined();
    expect(parseFrameworkInput({ name: "X", steps: ["a", "b"] }).role).toBe("narrative");
    expect(parseFrameworkInput({ name: "X", steps: ["a", "b"], role: "argument", pairsWith: " PAS " })).toMatchObject({ role: "argument", pairsWith: "PAS" });
    expect(parseFrameworkInput({ name: "X", steps: ["a", "b"], role: "nonsense" }).role).toBe("narrative");
  });
});

describe("parseRuleInput", () => {
  it("needs text, defaults on, names from the text", () => {
    expect(() => parseRuleInput({ name: "x" })).toThrow(/Write the rule/);
    expect(parseRuleInput({ text: "No and then." })).toEqual({ name: "No and then.", text: "No and then.", on: true });
    expect(parseRuleInput({ on: false }, { name: "A", text: "B", on: true })).toEqual({ name: "A", text: "B", on: false });
  });
});

describe("parseSources / parseSessionPatch", () => {
  it("validates ids, dedupes, keeps notes", () => {
    const out = parseSources([id(1), { postId: id(2), note: "  hook  " }, id(1), "BAD ID", 7], 5);
    expect(out).toEqual([
      { postId: id(1), addedAt: 5 },
      { postId: id(2), addedAt: 5, note: "hook" },
    ]);
    expect(() => parseSources(Array.from({ length: 41 }, (_, i) => id(i)))).toThrow(/at most 40/);
    expect(() => parseSources("nope")).toThrow(/list/);
  });
  it("treats projectId null as clearing and validates the rest", () => {
    expect(parseSessionPatch({ projectId: null, title: " Pools ", notes: "n" })).toEqual({
      projectId: null,
      title: "Pools",
      notes: "n",
    });
    expect(parseSessionPatch({ projectId: "abcdef-123456" })).toEqual({ projectId: "abcdef-123456" });
    expect(() => parseSessionPatch({ projectId: "x" })).toThrow(/Unknown project/);
    expect(parseSessionPatch({ status: "production" })).toEqual({ status: "production" });
    expect(() => parseSessionPatch({ status: "live" })).toThrow(/Unknown status/);
    expect(parseSessionPatch({})).toEqual({});
  });
});

describe("parseGenerateInput", () => {
  it("requires a kind and caps sources", () => {
    expect(() => parseGenerateInput({ prompt: "x" })).toThrow(/reel, carousel, ad, or free/);
    const out = parseGenerateInput({ kind: "reel", prompt: " make it punchy ", sourceIds: [id(1), id(1), "bad"] });
    expect(out).toEqual({ kind: "reel", prompt: "make it punchy", includeNotes: true, sourceIds: [id(1)], frameworkIds: [] });
    expect(parseGenerateInput({ kind: "reel", frameworkIds: [id(2), id(2), "bad", id(3)] }).frameworkIds).toEqual([id(2), id(3)]);
    expect(parseGenerateInput({ kind: "reel", frameworkId: id(4) }).frameworkIds).toEqual([id(4)]);
    expect(parseGenerateInput({ kind: "reel", ruleIds: [id(5), "bad"] }).ruleIds).toEqual([id(5)]);
    expect(parseGenerateInput({ kind: "reel" }).ruleIds).toBeUndefined();
    expect(parseGenerateInput({ kind: "ad", includeNotes: false }).includeNotes).toBe(false);
    expect(() =>
      parseGenerateInput({ kind: "ad", sourceIds: Array.from({ length: 13 }, (_, i) => id(i)) }),
    ).toThrow(/at most 12/);
  });
});

describe("slugFilename", () => {
  it("makes a safe file name", () => {
    expect(slugFilename("Pools & Swimming: Reel #1")).toBe("pools-swimming-reel-1.md");
    expect(slugFilename("   ")).toBe("workshop.md");
    expect(slugFilename("Ärimees", "txt")).toBe("arimees.txt");
  });
});

describe("co-writing inputs", () => {
  it("creates documents with a default title and validates patches", () => {
    expect(parseDocCreate({ kind: "carousel", frameworkIds: [id(1), "bad"] })).toEqual({ kind: "carousel", title: "Carousel", frameworkIds: [id(1)], ruleIds: undefined, text: "" });
    expect(() => parseDocCreate({ kind: "notes" })).toThrow(/reel, carousel, ad, free or youtube/);
    expect(parseDocPatch({ blocks: [{ id: "b2", text: "x" }, { id: "nope", text: "y" }, "junk"], ruleIds: null })).toEqual({ blocks: [{ id: "b2", text: "x" }, { text: "y" }], ruleIds: null });
    expect(parseDocPatch({ blocks: [{ text: "x".repeat(5000) }] }).blocks?.[0]?.text).toHaveLength(4000);
    expect(parseDocPatch({ blocks: [{ text: "x".repeat(5000) }, { text: "y" }] }, "notes").blocks).toEqual([{ text: "x".repeat(5000) }]);
    expect(() => parseDocPatch({ kind: "poem" })).toThrow(/Unknown document kind/);
    expect(parseDocPatch({ carouselType: "insight" })).toEqual({ carouselType: "insight" });
    expect(parseDocPatch({ carouselType: "" })).toEqual({ carouselType: null });
    expect(() => parseDocPatch({ carouselType: "poem" })).toThrow(/Unknown carousel type/);
    expect(parseDocPatch({
      carouselLayouts: { hash: "deadbeef", pick: 0, variants: [["cover", "teaching", "closer"]] },
    }).carouselLayouts).toMatchObject({ hash: "deadbeef", pick: 0 });
    expect(parseDocPatch({ carouselLayouts: null }).carouselLayouts).toBeNull();
    expect(parseLayoutRequest({ regenerate: true, slide: 2, pick: 1, typeId: "compare" })).toEqual({
      regenerate: true,
      slide: 2,
      pick: 1,
      typeId: "compare",
    });
    expect(parseLayoutRequest({ typeId: "poem", slide: 0 })).toEqual({});
    expect(parseDocPatch({ hooks: [{ id: "h1", text: "Open" }, { id: "b1", text: "x" }, "junk"] })).toEqual({
      hooks: [{ id: "h1", text: "Open" }, { text: "x" }],
    });
    expect(parseDocPatch({ hooks: [] })).toEqual({ hooks: [] });
  });

  it("parses a turn with pinned context and reading", () => {
    const t = parseTurnInput({
      docId: id(1),
      text: "  tighten the hook ",
      deep: true,
      comments: true,
      reading: { postId: id(2), slide: 1.7 },
      context: [{ postId: id(2), handle: "coach", slide: 1, field: "slides", text: "SAMPLE" }, { postId: id(2), field: "poem", text: "x" }],
    });
    expect(t).toEqual({
      docId: id(1),
      text: "tighten the hook",
      deep: true,
      comments: true,
      mine: false,
      reading: { postId: id(2), slide: 1 },
      context: [{ postId: id(2), handle: "coach", field: "slides", text: "SAMPLE", slide: 1 }],
    });
    expect(parseTurnInput({ docId: id(1), text: "x", deep: "yes" })).toMatchObject({ deep: false, comments: false });
    expect(() => parseTurnInput({ docId: id(1) })).toThrow(/Say something/);
    expect(() => parseTurnInput({ text: "hi" })).toThrow(/Pick a document/);
  });
});

describe("parseFiles (PDFs with a message)", () => {
  const pdf = (text = "%PDF-1.4 hello") => Buffer.from(text).toString("base64");

  it("keeps an allow-listed PDF with its name and base64", () => {
    expect(parseFiles([{ name: "brief.pdf", type: "application/pdf", data: pdf() }])).toEqual([
      { name: "brief.pdf", type: "application/pdf", data: pdf() },
    ]);
  });

  it("refuses a type that is not on the list, by name", () => {
    expect(() => parseFiles([{ name: "clip.mp4", type: "video/mp4", data: pdf() }])).toThrow(/clip\.mp4 can't be read yet/);
    expect(() => parseFiles([{ name: "x.zip", type: "application/zip", data: pdf() }])).toThrow(/can't be read yet/);
  });

  it("refuses bad base64 and a body that is not a PDF", () => {
    expect(() => parseFiles([{ name: "a.pdf", type: "application/pdf", data: "not base64!" }])).toThrow(/did not come through/);
    expect(() => parseFiles([{ name: "a.pdf", type: "application/pdf", data: "abc" }])).toThrow(/did not come through/);
    expect(() => parseFiles([{ name: "a.pdf", type: "application/pdf", data: Buffer.from("hello world").toString("base64") }])).toThrow(/is not a PDF/);
  });

  it("caps each file and all of them together", () => {
    const head = Buffer.from("%PDF-1.4!").toString("base64"); // 12 base64 characters, a PDF at the start
    const big = head + "A".repeat(14_000_000 - 12);
    const tooBig = head + "A".repeat(14_000_000 - 12 + 4);
    expect(() => parseFiles([{ name: "big.pdf", type: "application/pdf", data: tooBig }])).toThrow(/too big: send it under 10 MB/);
    expect(() => parseFiles([{ name: "a.pdf", type: "application/pdf", data: big }, { name: "b.pdf", type: "application/pdf", data: big }])).toThrow(/too big together/);
  });

  it("is empty when nothing is sent, and parseTurnInput carries the files and the retry refs", () => {
    expect(parseFiles(undefined)).toEqual([]);
    const input = parseTurnInput({
      docId: id(1),
      text: "",
      files: [{ name: "brief.pdf", type: "application/pdf", data: pdf() }],
    });
    expect(input.files).toEqual([{ name: "brief.pdf", type: "application/pdf", data: pdf() }]);
    expect(input.text).toBe("Look at these.");
    const retry = parseTurnInput({
      docId: id(1),
      text: "again",
      fileRefs: [{ id: "file-000001", name: "brief.pdf", type: "application/pdf", bytes: 42 }, { id: "file-000002", name: "x", type: "video/mp4", bytes: 1 }],
    });
    expect(retry.fileRefs).toEqual([{ id: "file-000001", name: "brief.pdf", type: "application/pdf", bytes: 42 }]);
    expect(retry.files).toBeUndefined();
  });
});
