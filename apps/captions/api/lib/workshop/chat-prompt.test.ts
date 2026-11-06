import { describe, expect, it } from "vitest";
import { TURN_BUDGET, buildTurnPrompt, renderDocument, renderSourceHead, renderUserEdits, wantsComments, type SourceView } from "./chat-prompt";
import { keep, markEditsSeen, newDocument, snapshot, userEdit } from "./doc";
import type { ChatMessage } from "./types";

const doc = newDocument("d1", "s1", "reel", "Sample", { text: "Hook", author: "ai", now: 1 });
doc.blocks.push({ id: "b2", text: "Beat two", author: "ai", at: 1 });
doc.nextBlock = 3;
snapshot(doc, "first draft", 2);
userEdit(doc, [{ id: "b1", text: "My hook" }, { id: "b2", text: "Beat two" }], 3);

const source = (over: Partial<SourceView> = {}): SourceView => ({
  ref: "S1",
  handle: "coach",
  kind: "carousel",
  url: "https://x/1",
  hook: "SAMPLE HOOK ONE",
  has: { slides: 900, transcript: 0, caption: 300, comments: 57 },
  loaded: ["slides"],
  markdown: "# @coach — Instagram carousel\n\n## Slides\n\n### Slide 1\nOn-screen text:\n\nSAMPLE HOOK ONE",
  ...over,
});
const base = { frameworks: [], rules: [], doc, pinned: [], sources: [], history: [], message: "x" };

describe("video citations", () => {
  it("name the source number when the video is one of the session's sources, else its handle", () => {
    const quotes = [
      { postId: "C8xYz_aBc", handle: "coach", text: "SAMPLE HOOK ONE", comment: "keep it blunt" },
      { postId: "Dq1rS2tUv", handle: "other", text: "Other hook" },
    ];
    const { user } = buildTurnPrompt({ ...base, sources: [source({ postId: "C8xYz_aBc", ref: "S3" })], message: "⟦1⟧ ⟦2⟧", quotes });
    expect(user).toContain("- ⟦1⟧ source S3 (@coach): «SAMPLE HOOK ONE»\n  their note: keep it blunt\n- ⟦2⟧ @other: «Other hook»");
  });
});

describe("renderDocument", () => {
  it("shows ids, authors, the companions, versions and whether the text moved on", () => {
    const r = renderDocument(doc);
    expect(r).toContain('Document "Sample" (reel)');
    expect(r).toContain("[b1 · you] My hook");
    expect(r).toContain("[b2 · ai] Beat two");
    expect(r).toContain("Hook variations: (none");
    expect(r).toContain("[caption] (empty");
    expect(r).toContain("Versions: v1 (latest) — first draft — the text has been edited since the latest");
    const head = newDocument("d2", "s1", "reel", "Head", { text: "A", author: "ai", now: 1 });
    snapshot(head, "draft", 2);
    expect(renderDocument(head)).toContain("v1 (current) — draft");
    keep(head, "this was good", 3);
    expect(renderDocument(head)).toContain('v1 kept (current) — this was good');
  });
});

describe("renderUserEdits", () => {
  it("shows what the author changed, and keeps seen edits as reminders", () => {
    const r = renderUserEdits(doc.userEdits!);
    expect(r).toContain("since your last turn");
    expect(r).toContain("b1 was (yours): «Hook» → now: «My hook»");
    const copy = structuredClone(doc);
    markEditsSeen(copy);
    userEdit(copy, [{ id: "b1", text: "My hook" }, { text: "Fresh line" }], 4);
    const again = renderUserEdits(copy.userEdits!);
    expect(again.indexOf("since your last turn")).toBeLessThan(again.indexOf("Earlier edits"));
    expect(again).toContain("b3 added: «Fresh line»");
  });
});

describe("renderSourceHead", () => {
  it("says what a source has, what is loaded, and whether it is open", () => {
    const h = renderSourceHead(source({ open: true, openSlide: 2, note: "use the drill" }));
    expect(h).toContain("S1 · @coach · carousel · https://x/1 — open on the author's screen at slide 3");
    expect(h).toContain("has: slide text 900 chars · caption 300 chars · comments 57");
    expect(h).toContain("loaded: slide text");
    expect(h).toContain("how to use it: use the drill");
  });

  it("says when the author tagged a source for this message", () => {
    expect(renderSourceHead(source({ tagged: true }))).toContain("— tagged by the author: this message is about this one");
    expect(renderSourceHead(source())).not.toContain("tagged");
  });

  it("marks a format-only source as layout, not topic", () => {
    const h = renderSourceHead(source({ savedFor: ["format"] }));
    expect(h).toContain("kept for: format (layout only — do not use the topic or claims)");
  });

  it("marks the author's own post", () => {
    expect(renderSourceHead(source({ own: true }))).toContain("author's own post — remake this script");
  });

  it("treats unmarked sources as content", () => {
    expect(renderSourceHead(source())).toContain("kept for: content");
  });
});

describe("buildTurnPrompt", () => {
  it("orders the blocks: frameworks, deliverable, document, edits, pinned, sources, research, history, message", () => {
    const { system, user } = buildTurnPrompt({
      ...base,
      project: { name: "Sample", audience: "parents", voice: "warm", cta: "profile", notes: "" },
      frameworks: [{ name: "Pixar Pitch", role: "narrative", summary: "spine", steps: ["Once", "Every day"], whenToUse: "" }],
      rules: ["No and then."],
      pinned: [{ postId: "p1", handle: "coach", slide: 1, field: "slides", text: "SAMPLE HOOK ONE" }],
      sources: [source({ open: true, openSlide: 1 }), source({ ref: "S2", handle: "other", loaded: ["slides", "comments"], markdown: "pack two" })],
      research: { question: "Is the Merrow study about swimming?", answer: "Yes [1].", citations: ["https://merrow.example.org/x"] },
      history: [
        { id: "m1", role: "user", text: "write the hook", at: 1, docId: "d1" },
        { id: "m2", role: "assistant", text: "Done", at: 2, docId: "d1", edits: { docId: "d1", blockIds: ["b1"] } },
      ],
      message: "make it punchier",
    });
    expect(system).toContain("Project: Sample");
    expect(system).toContain("Rules (they always apply):\n- No and then.");
    expect(user).not.toContain("Project: Sample");
    const order = [
      "Frameworks on this document (1)",
      "Pixar Pitch (shape",
      "Deliverable: A talking-to-camera reel",
      'Document "Sample"',
      "edits since your last turn",
      "Pinned by the author",
      "slide 2 — on-screen slide text",
      "Sources in this session (2)",
      "S1 · @coach · carousel · https://x/1 — open on the author's screen at slide 2",
      "SAMPLE HOOK ONE",
      "S2 · @other",
      "loaded: slide text, comments",
      "Research findings you asked for",
      "Conversation so far",
      "You (edited b1): Done",
      "Author now: make it punchier",
    ];
    let at = -1;
    for (const needle of order) {
      const next = user.indexOf(needle, at + 1);
      expect(next, needle).toBeGreaterThan(at);
      at = next;
    }
    expect(system).toContain('"revertTo"');
    expect(system).toContain('"fetch"');
    expect(system).toContain('"research"');
    expect(system).toContain("are written when this message asks for them");
    expect(system).toContain("Do not call add_hook while drafting");
    expect(system).toContain("add_hook on this reel");
    expect(system).toContain("one of each, into the field");
    expect(system).toContain("The pinned comment is usually empty");
    // what the fields are for, not how they read: no search terms, no bans
    expect(system).not.toContain("search terms");
    expect(system).not.toContain("always wrong");
    expect(system).toContain("How this works:");
    // no writing rules any more: it thinks from the author's posts and sessions instead
    expect(system).not.toContain("rejecting the kind of move");
    expect(system).not.toContain("Write like you talk, in simple words");
    expect(system).not.toContain("No new metaphors");
    expect(system).not.toContain("Your folder");
    expect(system).not.toContain("start the conversation");
    expect(system).not.toContain("learned");
    expect(user).toContain("every step of each must be present");
    expect(user).not.toContain("Write like you talk");
    expect(buildTurnPrompt(base).user).toContain("Sources in this session: none");
  });

  it("puts project instructions in the system prompt and lists context without loading it", () => {
    const file = { id: "file-1", name: "offer.md", text: "The app is tinyacrobatics.com/app", addedAt: 1 };
    const { user, system } = buildTurnPrompt({
      ...base,
      project: {
        name: "Sample",
        audience: "",
        voice: "",
        cta: "",
        notes: "never medical",
        knowledge: [file],
      },
    });
    expect(system).toContain("Instructions:\nnever medical");
    expect(system).toContain("K1 offer.md");
    expect(system).toContain("The app is tinyacrobatics.com/app");
    expect(user).not.toContain("Instructions:\nnever medical");
    expect(user).not.toContain("Context loaded this turn");
    expect(system).toContain("Project instructions are always-on");
  });

  it("keeps the newest messages when the conversation outgrows its budget, and never cuts the author's words", () => {
    const long = "x".repeat(TURN_BUDGET.perMessage + 500);
    const history = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `${i % 2 ? "reply" : "ask"} ${i} ${long}`, at: i, docId: "d1" }));
    const { user } = buildTurnPrompt({ ...base, history, message: `now ${long}` });
    expect(user).toContain("ask 28 ");
    expect(user).toContain("reply 29 ");
    const conversation = user.slice(user.indexOf("Conversation so far"), user.indexOf("Everything the author said"));
    expect(conversation).not.toContain("ask 0 ");
    expect(user).toContain(`Author: ask 28 ${long}`);
    expect(user).toContain(`Author now: now ${long}`);
  });

  it("on the API path, says how many earlier messages it leaves out, and never clips the author's message", () => {
    const history = Array.from({ length: 45 }, (_, i) => ({ id: `m${i}`, role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `line ${i}`, at: i, docId: "d1" }));
    const message = "z".repeat(45_000);
    const { user } = buildTurnPrompt({ ...base, history, message });
    expect(user).toContain("Conversation so far (5 earlier messages of this session are not shown here):");
    expect(user).not.toContain("sessions/");
    expect(user).toContain(`Author now: ${message}`);
  });

  it("with the folder: points at the files, loads nothing, cuts nothing", () => {
    const file = { id: "file-1", name: "what-is-true.md", text: "SECRET FACTS", addedAt: 1 };
    const long = "y".repeat(TURN_BUDGET.history);
    const { system, user } = buildTurnPrompt({
      ...base,
      project: { name: "Sample", audience: "", voice: "", cta: "", notes: "never medical", knowledge: [file] },
      account: { id: "a", username: "tinyacrobatics" },
      sources: [source({ markdown: "SECRET SLIDE TEXT" })],
      history: [{ id: "m1", role: "user", text: long, at: 1, docId: "d1" }],
      folder: { contextFiles: ["what-is-true.md"] },
    });
    expect(system).toContain("Your folder");
    expect(system).toContain("my-posts/INDEX.md");
    expect(system).toContain("Instructions:\nnever medical");
    expect(system).toContain("context/what-is-true.md");
    expect(system).toContain("@tinyacrobatics — every post is in my-posts/");
    expect(system).not.toContain("fetch [{");
    expect(system).not.toContain("SECRET FACTS");
    expect(user).toContain("file: sources/S1-coach.md");
    expect(user).not.toContain("SECRET SLIDE TEXT");
    expect(user).toContain(long);
  });

  it("resumed on the Mac: the history and the sources are the session's, so the turn carries the document, the pins and what changed", () => {
    const pinned = [{ postId: "p1", handle: "coach", slide: 1, field: "slides" as const, text: "PINNED LINE" }];
    const history: ChatMessage[] = [{ id: "m1", role: "user", text: "OLD ASK", at: 1, docId: "d1" }];
    const resumed = buildTurnPrompt({
      ...base,
      sources: [source({ markdown: "SECRET SLIDE TEXT" })],
      history,
      pinned,
      message: "make it shorter",
      folder: { contextFiles: [] },
      resumed: { newSources: [{ ref: "S2", handle: "other" }] },
    });
    const user = resumed.user;
    expect(user).not.toContain("Conversation so far");
    expect(user).not.toContain("OLD ASK");
    expect(user).not.toContain("SECRET SLIDE TEXT");
    expect(user).not.toContain("Sources in this session");
    expect(user).toContain("PINNED LINE");
    expect(user).toContain("Document \"Sample\"");
    expect(user).toContain("CHANGED since your last turn:\n- the author edited: b1 (listed above)\n- new source S2 (@other), in sources/S2-other.md");
    expect(user).toContain("Author now: make it shorter");
    const sameTurnFull = buildTurnPrompt({ ...base, sources: [source()], history, message: "make it shorter", folder: { contextFiles: [] } }).user;
    expect(sameTurnFull).toContain("Conversation so far");
    expect(sameTurnFull).toContain("OLD ASK");
  });

  it("puts the author's closest posts next to the piece, with their numbers and file, and not on a resumed turn", () => {
    const closestPosts = [{ date: "2026-05-02", keptPer1k: 65.49, file: "my-posts/2026-05-02-X.md", text: "The app got its own top" }];
    const { user } = buildTurnPrompt({ ...base, closestPosts, folder: { contextFiles: [] } });
    expect(user).toContain("The author's own posts closest to this piece, most saved and shared first:\n--- 2026-05-02 · 65.5 saves + shares per 1,000 views · my-posts/2026-05-02-X.md\nThe app got its own top\n---");
    const resumed = buildTurnPrompt({ ...base, closestPosts, folder: { contextFiles: [] }, resumed: { newSources: [] } }).user;
    expect(resumed).not.toContain("closest to this piece");
  });

  it("on the Mac too, a long conversation keeps its last 40 messages and says where the rest is", () => {
    const long: ChatMessage[] = Array.from({ length: 45 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", text: `MSG${i}.`, at: i, docId: "d1" }) as ChatMessage);
    const { user } = buildTurnPrompt({ ...base, history: long, folder: { contextFiles: [] } });
    expect(user).toContain("(5 earlier messages of this session are not shown here; the whole conversation is in this session's file in sessions/)");
    expect(user).not.toContain("You: MSG3.");
    expect(user).toContain("You: MSG5.");
    expect(user).toContain("- MSG0."); // every note of theirs still listed in full
  });

  it("resumed: every note of theirs on the piece still comes along, word for word", () => {
    const notes: ChatMessage[] = [
      { id: "m1", role: "user", text: "It's a carousel, keep slide 2 as is.", at: 1, docId: "d1" },
      { id: "m2", role: "assistant", text: "Done.", at: 2, docId: "d1" },
      { id: "m3", role: "user", text: "Shorter hook.", at: 3, docId: "d1" },
    ];
    const { user } = buildTurnPrompt({ ...base, history: notes, folder: { contextFiles: [] }, resumed: { newSources: [] } });
    expect(user).toContain("- It's a carousel, keep slide 2 as is.\n- Shorter hook.");
    expect(user).not.toContain("Conversation so far");
  });

  it("passes on the author's slider: slight keeps the rest as it is, rewrite opens the whole piece, normal says nothing", () => {
    expect(buildTurnPrompt({ ...base, scope: "slight" }).user).toContain("Slight changes (the author's setting for this message)");
    expect(buildTurnPrompt({ ...base, scope: "rewrite" }).user).toContain("Rewrite (the author's setting for this message)");
    const normal = buildTurnPrompt(base).user;
    expect(normal).not.toContain("the author's setting for this message");
  });

  it("resumed with nothing new says so", () => {
    const quiet = structuredClone(doc);
    markEditsSeen(quiet);
    const { user } = buildTurnPrompt({ ...base, doc: quiet, folder: { contextFiles: [] }, resumed: { newSources: [] } });
    expect(user).toContain("CHANGED since your last turn: no edits by the author, no new sources.");
  });

  it("lists the linked Instagram account without dumping stats", () => {
    const { system, user } = buildTurnPrompt({
      ...base,
      project: { name: "Sample", audience: "", voice: "", cta: "", notes: "" },
      account: {
        id: "acct-1",
        username: "tinyacrobatics",
        fullName: "Tiny Acrobatics",
        biography: "Movement play",
        followers: 12400,
        posts: 340,
        fetchedAt: Date.UTC(2026, 8, 16),
        postsPerWeek: 3,
        mix: { reels: 20, carousels: 10, posts: 2 },
      },
    });
    expect(system).toContain("Instagram @tinyacrobatics (Tiny Acrobatics)");
    expect(system).toContain('fetch [{"source":"account"}]');
    expect(system).not.toContain("12400 followers");
    expect(system).not.toContain("Bio: Movement play");
    expect(user).not.toContain("Author's Instagram");
  });

  it("inlines Instagram stats only after fetch", () => {
    const account = {
      id: "acct-1",
      username: "tinyacrobatics",
      fullName: "Tiny Acrobatics",
      biography: "Movement play",
      followers: 12400,
      posts: 340,
      fetchedAt: Date.UTC(2026, 8, 16),
      postsPerWeek: 3,
      mix: { reels: 20, carousels: 10, posts: 2 },
    };
    const { user, system } = buildTurnPrompt({
      ...base,
      project: { name: "Sample", audience: "", voice: "", cta: "", notes: "" },
      account,
      loadedAccount: account,
    });
    expect(system).not.toContain("12400 followers");
    expect(user).toContain("Author's Instagram @tinyacrobatics");
    expect(user).toContain("12400 followers");
    expect(user).toContain("Bio: Movement play");
  });

  it("loads a fetched context file this turn", () => {
    const file = { id: "file-1", name: "offer.md", text: "The app is tinyacrobatics.com/app", addedAt: 1 };
    const { user } = buildTurnPrompt({
      ...base,
      project: { name: "Sample", audience: "", voice: "", cta: "", notes: "", knowledge: [file] },
      loadedKnowledge: [file],
    });
    expect(user).toContain("Context loaded this turn");
    expect(user).toContain("### offer.md");
    expect(user).toContain("The app is tinyacrobatics.com/app");
  });

  it("does not dump source bodies or frameworks when the ask is only the post description", () => {
    const { user } = buildTurnPrompt({
      ...base,
      frameworks: [{ name: "Pixar Pitch", role: "narrative", summary: "spine", steps: ["Once", "Every day"], whenToUse: "" }],
      sources: [source({ loaded: [], markdown: "SECRET SLIDE TEXT" })],
      message: "Write the post description",
    });
    expect(user).toContain("S1 · @coach");
    expect(user).not.toContain("SECRET SLIDE TEXT");
    expect(user).not.toContain("Frameworks on this document");
    expect(user).toContain("Author now: Write the post description");
  });

  it("includes a fetched source body on a caption turn", () => {
    const { user } = buildTurnPrompt({
      ...base,
      sources: [source({ loaded: ["transcript"], markdown: "PULLED TRANSCRIPT" })],
      message: "Write the post description",
    });
    expect(user).toContain("PULLED TRANSCRIPT");
  });

  it("keeps loaded sources inside the budget: each cut to its share, the ones past the total shown as index lines", () => {
    const big = source({ markdown: "w".repeat(30_000) });
    const { user } = buildTurnPrompt({ ...base, sources: [1, 2, 3, 4].map((i) => ({ ...big, ref: `S${i}`, handle: `big${i}` })) });
    expect(user).toContain("…[shortened]");
    expect(user).toContain("S4 · @big4");
    expect(user).toContain("loaded text not shown this turn — budget");
    expect(user.split("loaded text not shown").length - 1).toBe(1);
  });

  it("treats notes as a freeform page", () => {
    const notes = newDocument("n1", "s1", "notes", "Notes", { text: "scrap", author: "user", now: 1 });
    const { user, system } = buildTurnPrompt({ ...base, doc: notes, message: "jot this down" });
    expect(user).toContain("one freeform page");
    expect(user).not.toContain("[caption]");
    expect(user).not.toContain("Versions");
    expect(system).toContain("This tab is working notes");
    expect(system).not.toContain("add_hook on this reel");
    expect(system).not.toContain("are written when this message asks for them");
  });

  it("names the carousel type so the model writes into that recipe", () => {
    const car = newDocument("c1", "s1", "carousel", "Swim", { text: "Hook", author: "ai", now: 1 });
    car.carouselType = "insight";
    const { user } = buildTurnPrompt({ ...base, doc: car, message: "draft the slides" });
    expect(user).toContain("Carousel type (Explainer)");
    expect(user).toContain("one argument");
    expect(buildTurnPrompt({ ...base, doc: newDocument("c2", "s1", "carousel", "Swim", { text: "Hook", now: 1 }) }).user).not.toContain("Carousel type");
  });

  it("uses reel rules on a reel tab and carousel rules on a carousel tab", () => {
    const reel = buildTurnPrompt({ ...base, message: "tighten the hook" });
    expect(reel.system).toContain("This tab is a talking-to-camera reel");
    expect(reel.system).toContain("add_hook on this reel");
    expect(reel.system).toContain("are written when this message asks for them");
    const car = newDocument("c1", "s1", "carousel", "Swim", { text: "Hook", now: 1 });
    const carousel = buildTurnPrompt({ ...base, doc: car, message: "draft the slides" });
    expect(carousel.system).toContain("This tab is an Instagram carousel");
    expect(carousel.system).toContain("are written when this message asks for them");
    expect(carousel.system).not.toContain("add_hook on this reel");
    const ad = newDocument("a1", "s1", "ad", "Ad", { text: "Hook", now: 1 });
    const ads = buildTurnPrompt({ ...base, doc: ad, message: "write variants" });
    expect(ads.system).toContain("This tab is paid social ad copy");
    expect(ads.system).not.toContain("are written when this message asks for them");
    expect(ads.system).not.toContain("add_hook on this reel");
  });
});

describe("wantsComments", () => {
  it("spots questions about the audience", () => {
    for (const t of ["what are the biggest objections in the comments?", "What do people say about sample", "any pushback?", "summarise the audience reaction"]) expect(wantsComments(t), t).toBe(true);
    for (const t of ["tighten the hook", "write the carousel version", "make beat 3 shorter"]) expect(wantsComments(t), t).toBe(false);
  });
});

describe("frameworks the author didn't pick", () => {
  it("on the Mac, the turn says none is picked and where all of them are; a picked one replaces that line", () => {
    expect(buildTurnPrompt({ ...base, folder: { contextFiles: [] } }).user).toContain("none picked by the author. All of theirs are in frameworks/");
    const picked = buildTurnPrompt({ ...base, folder: { contextFiles: [] }, frameworks: [{ name: "PAS", role: "persuasion", summary: "", steps: ["Problem"], whenToUse: "" }] }).user;
    expect(picked).not.toContain("none picked");
    expect(picked).toContain("PAS");
  });
});

describe("citations", () => {
  it("say which field of the piece the words are from, with the author's comment", () => {
    const user = buildTurnPrompt({ ...base, quotes: [{ text: "As a passenger", field: "script", comment: "drop this metaphor" }, { text: "Sample thing A syndrome", field: "caption" }] }).user;
    expect(user).toContain("- ⟦1⟧ the script: «As a passenger»\n  their note: drop this metaphor");
    expect(user).toContain("- ⟦2⟧ the post description: «Sample thing A syndrome»");
    const inline = buildTurnPrompt({ ...base, message: "Cut ⟦1⟧, keep ⟦2⟧", quotes: [{ text: "a" }, { text: "b" }] }).user;
    expect(inline).toContain("(⟦n⟧ in their message is where citation n stands)");
  });
});
