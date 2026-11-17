import { describe, expect, it } from "vitest";
import { buildTurnPrompt, unansweredBefore } from "./chat-prompt";
import { sessionText } from "./folder";
import { newDocument } from "./doc";
import type { ChatMessage } from "./types";

// A chat's pictures stay the AI's for the whole chat: a later turn knows where each one is, and a message whose reply
// was stopped or failed is answered by the next turn, pictures and all (the owner's nine slide screenshots, 2026-11-16).

const jpg = (name: string, id: string) => ({ id, name, type: "image/jpeg" as const });
const msg = (id: string, role: ChatMessage["role"], text: string, more: Partial<ChatMessage> = {}): ChatMessage => ({ id, role, text, at: 1, docId: "d1", status: "done", ...more });

const slides = msg("5f0c2a91-aaaa", "user", "this was the conclusion slide, you tell me", { images: [jpg("1.jpg", "i1"), jpg("2.jpg", "i2")] });
const chat = [
  msg("u0", "user", "first"),
  msg("a0", "assistant", "done that"),
  slides,
  msg("a1", "assistant", "", { status: "error", error: "Stopped" }),
  msg("u2", "user", "you stopped?"),
];

describe("a message a stop or a failure left without a reply", () => {
  it("is found right before the new message; a reply that came ends the run", () => {
    expect(unansweredBefore(chat, chat[4]!).map((m) => m.id)).toEqual(["5f0c2a91-aaaa"]);
    expect(unansweredBefore(chat, chat[2]!)).toEqual([]);
    const two = [...chat.slice(0, 4), msg("u1", "user", "and this", { docId: "d2" }), msg("u1b", "user", "also"), msg("a2", "assistant", "", { status: "error", error: "failed" }), chat[4]!];
    expect(unansweredBefore(two, chat[4]!).map((m) => m.id)).toEqual(["5f0c2a91-aaaa", "u1b"]);
  });

  it("is named in the prompt with its pictures: files on the Mac, the pictures after this message's on the API key", () => {
    const doc = newDocument("d1", "s1", "carousel", "Carousel", { text: "x", now: 1 });
    const base = { frameworks: [], rules: [], doc, pinned: [], sources: [], history: chat.slice(0, 2), message: "you stopped?" };
    const onMac = buildTurnPrompt({
      ...base,
      folder: { contextFiles: [], attached: true },
      unanswered: [{ text: slides.text, images: [{ name: "1.jpg", file: "attached/5f0c2a91/01-1.jpg" }], files: [] }],
    }).user;
    expect(onMac).toContain("never got your reply");
    expect(onMac).toContain("«this was the conclusion slide, you tell me»");
    expect(onMac).toContain("picture 1.jpg: read attached/5f0c2a91/01-1.jpg");
    expect(onMac).toContain("Look at every picture listed before you answer.");
    const onKey = buildTurnPrompt({
      ...base,
      images: [{ name: "now.jpg" }],
      unanswered: [{ text: "", images: [{ name: "1.jpg" }, { name: "2.jpg" }], files: [] }],
    }).user;
    expect(onKey).toContain("(no words, only what came with it)");
    expect(onKey).toContain("picture 1.jpg (image 2 above)");
    expect(onKey).toContain("picture 2.jpg (image 3 above)");
    expect(buildTurnPrompt(base).user).not.toContain("never got your reply");
  });
});

describe("an earlier message's pictures", () => {
  it("are named with their folder on the Mac, and said to be missing from this turn without one", () => {
    const doc = newDocument("d1", "s1", "carousel", "Carousel", { text: "x", now: 1 });
    const base = { frameworks: [], rules: [], doc, pinned: [], sources: [], history: [slides, msg("a9", "assistant", "ok")], message: "update the slides" };
    const onMac = buildTurnPrompt({ ...base, folder: { contextFiles: [], attached: true } });
    expect(onMac.user).toContain("[2 pictures in attached/5f0c2a91/: 1.jpg, 2.jpg]");
    expect(buildTurnPrompt(base).user).toContain("[2 pictures, not with this turn: 1.jpg, 2.jpg]");
  });

  it("are listed in this project's session file with their folder, and a message of pictures only is kept", () => {
    const meta = { title: "Strength", createdAt: 1, updatedAt: 1 };
    const only = msg("77aa88bb-cc", "user", "", { images: [jpg("3.jpg", "i3")] });
    const here = sessionText(meta, undefined, [], [slides, only], true);
    expect(here).toContain("(2 pictures, in attached/5f0c2a91/: 1.jpg, 2.jpg)");
    expect(here).toContain("(a picture, in attached/77aa88bb/: 3.jpg)");
    expect(sessionText(meta, undefined, [], [slides], false)).toContain("(2 pictures: 1.jpg, 2.jpg)");
  });
});
