import { describe, expect, it } from "vitest";
import { bareNow, chatLayout, frontAt, LIST_W, MIN_CHAT, MIN_PAGE, paneBelow } from "./chat-mode";

const fresh = { w: 0, page: true };

describe("chatLayout", () => {
  it("is half the window until the edge is dragged, then what was dragged", () => {
    expect(chatLayout(fresh, 1440)).toEqual({ chat: 720, full: false, forced: false, list: true });
    expect(chatLayout({ ...fresh, w: 760 }, 1440).chat).toBe(760);
  });
  it("keeps the list beside the chat while half the window has room for both", () => {
    expect(chatLayout(fresh, 1280)).toMatchObject({ chat: 640, list: true });
    expect(LIST_W + MIN_CHAT).toBeLessThanOrEqual(1272 - MIN_PAGE); // a 1280 window less its scrollbar still has the list
    expect(chatLayout(fresh, 1100)).toMatchObject({ chat: 1100 - MIN_PAGE, full: false, list: false });
  });
  it("never squeezes the page under its least, nor the chat", () => {
    expect(chatLayout({ ...fresh, w: 1400 }, 1440).chat).toBe(1440 - MIN_PAGE);
    expect(chatLayout({ ...fresh, w: 100 }, 1440).chat).toBe(MIN_CHAT);
  });
  it("folds the list away when the chat would be too narrow beside it", () => {
    expect(chatLayout({ ...fresh, w: 500 }, 1440).list).toBe(false);
  });
  it("takes the whole window when the page is hidden or the window has no room for both", () => {
    expect(chatLayout({ ...fresh, page: false }, 1440)).toEqual({ chat: 1440, full: true, forced: false, list: true });
    expect(chatLayout(fresh, MIN_CHAT + MIN_PAGE - 1)).toMatchObject({ chat: MIN_CHAT + MIN_PAGE - 1, full: true, forced: true });
  });
  it("gives a screen the width it says it needs, as far as the chat's least allows", () => {
    expect(chatLayout(fresh, 1440, 960)).toMatchObject({ chat: 480, full: false, list: false });
    expect(chatLayout(fresh, 1920, 960)).toMatchObject({ chat: 960, list: true });
    expect(chatLayout(fresh, 1200, 2000)).toMatchObject({ chat: MIN_CHAT, full: false });
  });
});

describe("a new chat", () => {
  it("has no page: only chats, whatever was chosen for the page, and not because the window is too narrow", () => {
    expect(chatLayout({ ...fresh, bare: true }, 1440)).toMatchObject({ chat: 1440, full: true, forced: false, list: true });
    expect(chatLayout({ ...fresh, bare: false }, 1440)).toMatchObject({ full: false });
  });
  it("stays without a page when its first message is sent, until something ends that; another chat is judged anew", () => {
    const chatMode = true;
    expect(bareNow(false, { chatMode, another: false, unsent: true })).toBe(true);
    // sent: nothing moves
    expect(bareNow(true, { chatMode, another: false, unsent: false })).toBe(true);
    // the page was asked for on the new-chat screen and a message sent after: it stays
    expect(bareNow(false, { chatMode, another: false, unsent: false })).toBe(false);
    // another chat: one that was started has its page, a new one has none
    expect(bareNow(true, { chatMode, another: true, unsent: false })).toBe(false);
    expect(bareNow(false, { chatMode, another: true, unsent: true })).toBe(true);
    // outside chat mode a chat that was started is about the page on screen
    expect(bareNow(true, { chatMode: false, another: false, unsent: false })).toBe(false);
  });
});

describe("paneBelow", () => {
  it("names every breakpoint the page is narrower than", () => {
    expect(paneBelow(720)).toBe("lt-md lt-lg lt-xl lt-2xl");
    expect(paneBelow(1024)).toBe("lt-xl lt-2xl");
    expect(paneBelow(1600)).toBe("");
    expect(paneBelow(MIN_PAGE)).toBe("lt-md lt-lg lt-xl lt-2xl");
  });
});

describe("the wash's front", () => {
  it("starts at the button, ends at its reach, and is slower at first than at the end", () => {
    expect(frontAt(0)).toBe(0);
    expect(frontAt(1)).toBe(1);
    expect(frontAt(0.5) - frontAt(0)).toBeLessThan(frontAt(1) - frontAt(0.5));
  });
});
