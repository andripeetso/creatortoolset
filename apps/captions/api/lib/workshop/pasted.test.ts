import { describe, expect, it } from "vitest";
import { LIMITS, parsePasted, parseTurnInput } from "./validate";
import { buildTurnPrompt } from "./chat-prompt";
import { newDocument } from "./doc";

const docId = "doc-000001";
const big = "The intern's carousel, slide by slide. ".repeat(400); // ~16,000 characters

describe("pastes are attachments, never cut", () => {
  it("keeps a typed message whole far past the old 4,000 and a paste whole as an attachment", () => {
    const typed = "word ".repeat(3000).trim(); // 14,999 characters
    expect(parseTurnInput({ docId, text: typed }).text).toBe(typed);
    const t = parseTurnInput({ docId, text: "", pasted: [{ name: "Intern draft", text: big }] });
    expect(t.text).toBe("Read what I pasted.");
    expect(t.pasted).toEqual([{ name: "Intern draft", text: big }]);
  });

  it("refuses one too big rather than cutting it, and names untitled ones", () => {
    expect(() => parsePasted([{ text: "x".repeat(LIMITS.pastedText + 1) }])).toThrow("over");
    expect(parsePasted([{ text: "a" }, { name: "", text: "b" }, { text: "  " }]).map((p) => p.name)).toEqual(["Pasted text 1", "Pasted text 2"]);
  });

  it("takes a retry's pastes by reference", () => {
    const t = parseTurnInput({ docId, text: "", pastedRefs: [{ id: "abcdef-1234", name: "Intern draft", chars: 16000 }, { id: "../etc" }] });
    expect(t.pastedRefs).toEqual([{ id: "abcdef-1234", name: "Intern draft", chars: 16000 }]);
  });

  it("puts the paste in front of the writer whole: a file on the Mac, inline otherwise", () => {
    const doc = newDocument("d1", "s1", "carousel", "Carousel", { text: "x", now: 1 });
    const base = { frameworks: [], rules: [], doc, pinned: [], sources: [], history: [], message: "find the storyline" };
    const inline = buildTurnPrompt({ ...base, pasted: [{ name: "Intern draft", text: big }] }).user;
    expect(inline).toContain(`### Intern draft\n${big}`);
    const folder = buildTurnPrompt({ ...base, folder: { contextFiles: [] }, pasted: [{ name: "Intern draft", text: big, file: "pasted/x/intern-draft-1.md" }] });
    expect(folder.user).toContain("- Intern draft (15,600 characters): read pasted/x/intern-draft-1.md");
    expect(folder.user).not.toContain(big);
    expect(folder.system).toContain("pasted/ — everything the author pasted");
  });

  it("names a past paste in the history", () => {
    const doc = newDocument("d1", "s1", "carousel", "Carousel", { text: "x", now: 1 });
    const { user } = buildTurnPrompt({
      frameworks: [],
      rules: [],
      doc,
      pinned: [],
      sources: [],
      history: [{ id: "m1", role: "user", text: "here's the draft", at: 1, docId: "d1", pasted: [{ id: "p1-000000", name: "Intern draft", chars: 15600 }] }],
      message: "now?",
    });
    expect(user).toContain("Author: here's the draft [pasted: Intern draft, 15,600 characters]");
  });
});

describe("a web search waits for the author", () => {
  const doc = newDocument("d1", "s1", "carousel", "Carousel", { text: "x", now: 1 });
  const base = { frameworks: [], rules: [], doc, pinned: [], sources: [], history: [], message: "is this true?" };

  it("is only ever proposed, on the Mac and on the API key", () => {
    const mac = buildTurnPrompt({ ...base, folder: { contextFiles: [] } });
    expect(mac.system).toContain("You don't search the web on your own");
    expect(mac.system).not.toContain("search the web yourself");
    const api = buildTurnPrompt(base);
    expect(api.system).toContain("Either one is asked of the author first and runs only if they say yes");
    expect(api.system).not.toContain("runs right away");
  });

  it("runs the one search the author approved, for this turn", () => {
    const { user } = buildTurnPrompt({ ...base, folder: { contextFiles: [] }, web: "Did puppies with less tummy time crawl later?" });
    expect(user).toContain("The author approved one web search for this turn: «Did puppies with less tummy time crawl later?»");
    expect(parseTurnInput({ docId, text: "Search the web: x", web: " x " }).web).toBe("x");
  });
});

describe("a paste of the piece into an empty tab", () => {
  const slides = "**Slide 1**\nSwimmers who train before work are ahead\n\n**Slide 2**\n7,000 adults";
  const base = { frameworks: [], rules: [], pinned: [], sources: [], history: [], message: "Read what I pasted.", pasted: [{ name: "Pasted text 1", text: slides }] };

  it("goes in first, as written", () => {
    const empty = newDocument("d1", "s1", "carousel", "Carousel", { now: 1 });
    expect(buildTurnPrompt({ ...base, doc: empty }).user).toContain("This carousel is still empty. If the paste is the piece itself");
    const full = newDocument("d1", "s1", "carousel", "Carousel", { text: "x", now: 1 });
    expect(buildTurnPrompt({ ...base, doc: full }).user).not.toContain("still empty");
    const notes = newDocument("d1", "s1", "notes", "Notes", { now: 1 });
    expect(buildTurnPrompt({ ...base, doc: notes }).user).not.toContain("still empty");
  });
});

describe("pictures with a message", () => {
  const jpeg = Buffer.from("\xff\xd8\xff slide", "latin1").toString("base64");

  it("come in as base64 of an image type, and a message of only pictures still sends", async () => {
    const { parseImages } = await import("./validate");
    expect(parseImages([{ name: "1.jpg", type: "image/jpeg", data: jpeg }, { name: "x.svg", type: "image/svg+xml", data: jpeg }, { type: "image/png", data: "not base64!" }])).toEqual([{ name: "1.jpg", type: "image/jpeg", data: jpeg }]);
    const t = parseTurnInput({ docId, text: "", images: [{ name: "1.jpg", type: "image/jpeg", data: jpeg }] });
    expect(t.text).toBe("Look at these.");
    expect(parseTurnInput({ docId, text: "", imageRefs: [{ id: "abcdef-1234", name: "1.jpg", type: "image/jpeg" }, { id: "../x", type: "image/jpeg" }] }).imageRefs).toEqual([{ id: "abcdef-1234", name: "1.jpg", type: "image/jpeg" }]);
  });

  it("accepts a message that is only citation chips, and keeps the citations", () => {
    const quotes = [{ postId: "C8xYz_aBc", handle: "coach", text: "Hook" }];
    const t = parseTurnInput({ docId, text: "⟦1⟧", quotes });
    expect(t.text).toBe("Look at these.");
    expect(t.quotes).toEqual(quotes);
    expect(() => parseTurnInput({ docId, text: "⟦1⟧" })).toThrow("Say something first");
  });

  it("reach the writer in their order, as files on the Mac, and an empty piece is filled from them first", () => {
    const empty = newDocument("d1", "s1", "carousel", "Carousel", { now: 1 });
    const base = { frameworks: [], rules: [], pinned: [], sources: [], history: [], message: "Look at these.", doc: empty };
    const mac = buildTurnPrompt({ ...base, folder: { contextFiles: [] }, images: [{ name: "1.jpg", file: "attached/01-1.jpg" }, { name: "2.jpg", file: "attached/02-2.jpg" }] }).user;
    expect(mac).toContain("The author attached 2 pictures with this message, in this order:\n1. 1.jpg: read attached/01-1.jpg (the Read tool shows you the picture)\n2. 2.jpg: read attached/02-2.jpg");
    expect(mac).toContain("This carousel is still empty. If these are the piece itself (its slides or its script), put it in as written first: one block per slide, the words exactly as they are on each picture");
    const api = buildTurnPrompt({ ...base, images: [{ name: "1.jpg" }] }).user;
    expect(api).toContain("1. 1.jpg (image 1 above)");
  });
});
