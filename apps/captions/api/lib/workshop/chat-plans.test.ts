import { describe, expect, it } from "vitest";
import { askedForCaption, askedForPinned, askedOnlyForCaption, editsForNewDocument, gateCompanionEdits, isAudienceQuestion, parseTurn } from "./chat-plans";

describe("parseTurn", () => {
  it("parses reply and every op shape, dropping malformed ones", () => {
    const t = parseTurn(
      JSON.stringify({
        reply: "Tightened the hook.",
        edits: [
          { op: "replace", id: "b2", text: "New" },
          { op: "insert_after", id: "b2", text: "After" },
          { op: "insert_before", block: "b1", content: "Before" },
          { op: "append", text: "End" },
          { op: "delete", id: "b3" },
          { op: "replace", id: "caption", text: "Under the post." },
          { op: "replace", id: "pinned", text: "Book a lesson." },
          { op: "add_hook", text: "Closing her mouth" },
          { op: "replace", id: "h1", text: "Wait for it" },
          { op: "delete", id: "h2" },
          { op: "replace", id: "nope", text: "x" },
          { op: "append", text: "" },
          "junk",
        ],
      }),
    );
    expect(t.reply).toBe("Tightened the hook.");
    expect(t.edits).toEqual([
      { op: "replace", id: "b2", text: "New" },
      { op: "insert_after", id: "b2", text: "After" },
      { op: "insert_before", id: "b1", text: "Before" },
      { op: "append", text: "End" },
      { op: "delete", id: "b3" },
      { op: "set_caption", text: "Under the post." },
      { op: "set_pinned", text: "Book a lesson." },
      { op: "add_hook", text: "Closing her mouth" },
      { op: "replace", id: "h1", text: "Wait for it" },
      { op: "delete", id: "h2" },
    ]);
    expect(t.newDocument).toBeUndefined();
    expect(t.revertTo).toBeUndefined();
  });

  it("accepts a new document and a revert, validates them", () => {
    const t = parseTurn('```json\n{"reply":"Carousel version started.","newDocument":{"kind":"carousel","title":"Carousel version"},"revertTo":"v3"}\n```');
    expect(t.newDocument).toEqual({ kind: "carousel", title: "Carousel version" });
    expect(t.revertTo).toBe("v3");
    expect(parseTurn('{"reply":"x","newDocument":{"kind":"notes","title":"n"},"revertTo":"three"}')).toEqual({ reply: "x", edits: [] });
  });

  it("takes fetch requests, a search, research and an audit proposal", () => {
    const t = parseTurn('{"reply":"Pulling.","fetch":[{"source":"S2","parts":["transcript","comments","poem"]},{"source":"","parts":["caption"]},{"source":"S1","parts":[]}],"search":"puppy pool"}');
    expect(t.fetch).toEqual([{ source: "S2", parts: ["transcript", "comments"] }]);
    expect(t.search).toBe("puppy pool");
    expect(parseTurn('{"needComments":true}')).toMatchObject({ reply: "Pulling that in.", fetch: [{ source: "*", parts: ["comments"] }] });
    expect(parseTurn('{"reply":"Reading voice.","fetch":[{"source":"K1"}]}')).toMatchObject({
      reply: "Reading voice.",
      fetch: [{ source: "K1", parts: [] }],
    });
    expect(parseTurn('{"reply":"Reading.","fetch":[{"source":"voice.md"}]}')).toMatchObject({ fetch: [{ source: "voice.md", parts: [] }] });
    expect(parseTurn('{"reply":"Stats.","fetch":[{"source":"account"}]}')).toMatchObject({ fetch: [{ source: "account", parts: [] }] });
    expect(parseTurn('{"reply":"Stats.","fetch":[{"source":"@tinyacrobatics"}]}')).toMatchObject({ fetch: [{ source: "@tinyacrobatics", parts: [] }] });
    expect(parseTurn('{"search":"swim"}')).toEqual({ reply: "Let me look in the library.", edits: [], search: "swim" });
    expect(parseTurn('{"reply":"Checking.","research":{"question":"Was it about swimming?","depth":"deep"},"audit":"quick"}')).toMatchObject({ research: { question: "Was it about swimming?", depth: "deep" }, audit: "quick" });
    expect(() => parseTurn('{"search":"x"}')).toThrow(/neither a reply nor edits/);
  });

  it("throws on an empty answer and fills a reply when only edits came back", () => {
    expect(() => parseTurn('{"edits":[]}')).toThrow(/neither a reply nor edits/);
    expect(parseTurn('{"edits":[{"op":"append","text":"Hi"}]}').reply).toBe("Done.");
  });
});

describe("gateCompanionEdits", () => {
  const pin = (text: string) => ({ op: "set_pinned" as const, text });
  const cap = (text: string) => ({ op: "set_caption" as const, text });
  const slide = { op: "replace" as const, id: "b1", text: "Hook" };
  const ctx = (over: { message?: string; caption?: string; pinned?: string } = {}) => ({
    message: "write the carousel",
    caption: "",
    pinned: "",
    ...over,
  });

  it("spots audience questions and which field this turn asked for", () => {
    expect(isAudienceQuestion("How old was yours?")).toBe(true);
    expect(isAudienceQuestion("Book: https://x.test/a?ref=1")).toBe(false);
    expect(askedForPinned("put that in the pinned comment")).toBe(true);
    expect(askedForPinned("tighten the hook")).toBe(false);
    expect(askedForCaption("write the description")).toBe(true);
    expect(askedForCaption("write the carousel")).toBe(false);
    expect(askedForCaption("descriptions start with Most families")).toBe(true);
    expect(askedForCaption("add that to my caption")).toBe(true);
    expect(askedOnlyForCaption("Write the post description")).toBe(true);
    expect(askedOnlyForCaption("Another take of the post description")).toBe(true);
    expect(askedOnlyForCaption("descriptions start with Most families and then add the income split")).toBe(true);
    expect(askedOnlyForCaption("write the description and tighten the hook")).toBe(false);
    expect(askedOnlyForCaption("rewrite as a normal Instagram caption like the ones I usually post")).toBe(true);
  });

  it("clears a question that was replacing a question, even when they did not ask for a pin", () => {
    expect(
      gateCompanionEdits([slide, pin("How old was yours when they first got in the water?")], ctx({
        message: "that question is tryhard, nobody will answer",
        pinned: "What age did your dog first get in the water — and did you notice anything change outside the pool?",
      })),
    ).toEqual([slide, pin("")]);
  });

  it("drops slide edits when the turn is caption-only", () => {
    expect(
      gateCompanionEdits([slide, cap("The swimmers were ahead in all four socio-economic groups."), pin("How old was yours?")], ctx({
        message: "Write the post description",
      })),
    ).toEqual([cap("The swimmers were ahead in all four socio-economic groups.")]);
  });

  it("drops unsolicited caption and pin when drafting the piece", () => {
    expect(gateCompanionEdits([slide, cap("Merrow also split by income."), pin("The study also split by income.")], ctx())).toEqual([slide]);
  });

  it("writes one caption when asked, and another take without a briefing", () => {
    expect(
      gateCompanionEdits([cap("The swimmers were ahead in all four socio-economic groups.")], ctx({ message: "write the description" })),
    ).toEqual([cap("The swimmers were ahead in all four socio-economic groups.")]);
    expect(
      gateCompanionEdits([cap("Water is a three-dimensional coordination task.")], ctx({
        message: "another",
        caption: "The swimmers were ahead in all four socio-economic groups.",
      })),
    ).toEqual([cap("Water is a three-dimensional coordination task.")]);
  });

  it("keeps a caption edit when they pasted their own wording and asked to add to it", () => {
    const opening = "Most families in the study didn't book lessons for development -- they did it so their child would be safe around water.";
    const next = `${opening}\n\nSo the coordination gains were extra. And it held in every socio-economic group.`;
    expect(
      gateCompanionEdits([cap(next)], ctx({
        message: `descriptions start with "${opening}" and then add socioeconomic to the end`,
        caption: opening,
      })),
    ).toEqual([cap(next)]);
    expect(
      gateCompanionEdits([cap(next)], ctx({
        message: `keep this and add the income split at the end:\n${opening}`,
        caption: opening,
      })),
    ).toEqual([cap(next)]);
  });

  it("drops an unsolicited pin and leaves a real pin alone when the model asks a question", () => {
    expect(gateCompanionEdits([pin("The study also split by income.")], ctx())).toEqual([]);
    expect(
      gateCompanionEdits([pin("How old was yours?")], ctx({
        message: "tighten slide 3",
        pinned: "Book the first lesson: https://x.test/a?ref=1",
      })),
    ).toEqual([]);
  });

  it("keeps a statement pin when this turn asked for one, and always allows a clear", () => {
    expect(
      gateCompanionEdits([pin("The swimmers were ahead in all four socio-economic groups.")], ctx({
        message: "put the breakdown in the pinned comment",
      })),
    ).toEqual([pin("The swimmers were ahead in all four socio-economic groups.")]);
    expect(gateCompanionEdits([pin("")], ctx({ pinned: "How old was yours?" }))).toEqual([pin("")]);
  });
});

describe("editsForNewDocument", () => {
  it("keeps captions, pinned comments, hooks and appends; turns edits that named the old piece into slides; drops deletes and old hooks", () => {
    expect(
      editsForNewDocument([
        { op: "set_caption", text: "Caption." },
        { op: "replace", id: "b1", text: "New slide." },
        { op: "insert_after", id: "b2", text: "Another." },
        { op: "delete", id: "b3" },
        { op: "replace", id: "h1", text: "An old hook." },
        { op: "append", text: "Appended." },
        { op: "set_pinned", text: "Pinned." },
        { op: "add_hook", text: "Hook two." },
      ]),
    ).toEqual([
      { op: "set_caption", text: "Caption." },
      { op: "append", text: "New slide." },
      { op: "append", text: "Another." },
      { op: "append", text: "Appended." },
      { op: "set_pinned", text: "Pinned." },
      { op: "add_hook", text: "Hook two." },
    ]);
  });
});
