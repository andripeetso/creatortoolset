import { describe, expect, it } from "vitest";
import { chatLayout, LIST_W, MIN_CHAT, MIN_PAGE, paneBelow } from "./chat-mode";

const fresh = { w: 0, page: true };

describe("chatLayout", () => {
  it("is half the window until the edge is dragged, then what was dragged", () => {
    expect(chatLayout(fresh, 1440)).toEqual({ chat: 720, full: false, list: true });
    expect(chatLayout({ ...fresh, w: 900 }, 1440).chat).toBe(900);
  });
  it("keeps the list beside the chat while half the window has room for both", () => {
    expect(chatLayout(fresh, 2 * (LIST_W + MIN_CHAT))).toEqual({ chat: LIST_W + MIN_CHAT, full: false, list: true });
    expect(chatLayout(fresh, 1100)).toEqual({ chat: 550, full: false, list: false });
  });
  it("never squeezes the page under its least, nor the chat", () => {
    expect(chatLayout({ ...fresh, w: 1400 }, 1440).chat).toBe(1440 - MIN_PAGE);
    expect(chatLayout({ ...fresh, w: 100 }, 1440).chat).toBe(MIN_CHAT);
  });
  it("folds the list away when the chat would be too narrow beside it", () => {
    expect(chatLayout({ ...fresh, w: 500 }, 1440).list).toBe(false);
  });
  it("takes the whole window when the page is hidden or the window has no room for both", () => {
    expect(chatLayout({ ...fresh, page: false }, 1440)).toEqual({ chat: 1440, full: true, list: true });
    expect(chatLayout(fresh, MIN_CHAT + MIN_PAGE - 1)).toMatchObject({ chat: MIN_CHAT + MIN_PAGE - 1, full: true });
  });
});

describe("paneBelow", () => {
  it("names every breakpoint the page is narrower than", () => {
    expect(paneBelow(720)).toBe("lt-md lt-lg lt-xl lt-2xl");
    expect(paneBelow(1024)).toBe("lt-xl lt-2xl");
    expect(paneBelow(1600)).toBe("");
    expect(paneBelow(400)).toBe("lt-sm lt-md lt-lg lt-xl lt-2xl");
  });
});
