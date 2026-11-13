import { describe, expect, it } from "vitest";
import { bareNow, chatLayout, frontAt, frontReaches, LIST_MAX, LIST_MIN, LIST_W, MIN_CHAT, MIN_PAGE, paneBelow } from "./chat-mode";

const fresh = { w: 0, page: true };

describe("chatLayout", () => {
  it("is half the window until the edge is dragged, then what was dragged", () => {
    expect(chatLayout(fresh, 1440)).toEqual({ chat: 720, full: false, forced: false, list: true, listW: LIST_W });
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
    expect(chatLayout({ ...fresh, page: false }, 1440)).toEqual({ chat: 1440, full: true, forced: false, list: true, listW: LIST_W });
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

describe("the list of chats' own width", () => {
  const fresh = { w: 0, page: true };
  it("is as its edge was dragged, between its least and its most", () => {
    expect(chatLayout({ ...fresh, lw: 340 }, 1440).listW).toBe(340);
    expect(chatLayout({ ...fresh, page: false, lw: 40 }, 1440).listW).toBe(LIST_MIN);
    expect(chatLayout({ ...fresh, page: false, lw: 2000 }, 1440).listW).toBe(LIST_MAX);
  });

  it("gives way to the open chat before it folds away: the chat never gets under its least", () => {
    // half of 1440 is 720 for both: the list can have 720 less the chat's least
    expect(chatLayout({ ...fresh, lw: 460 }, 1440)).toMatchObject({ list: true, listW: 720 - MIN_CHAT });
    expect(chatLayout({ ...fresh, w: MIN_CHAT + LIST_MIN }, 1440)).toMatchObject({ list: true, listW: LIST_MIN });
    expect(chatLayout({ ...fresh, w: MIN_CHAT + LIST_MIN - 1 }, 1440).list).toBe(false);
  });
});

describe("the wave's front", () => {
  it("starts at the button, ends at its reach, and is slower at first than at the end", () => {
    expect(frontAt(0)).toBe(0);
    expect(frontAt(1)).toBe(1);
    expect(frontAt(0.5) - frontAt(0)).toBeLessThan(frontAt(1) - frontAt(0.5));
  });

  it("is on its way at once: a tenth of the time in, it has left the button", () => {
    expect(frontAt(0.1)).toBeGreaterThan(0.01);
  });

  it("reaches a thing when it is that far: the time for a distance is the distance at that time", () => {
    for (const t of [0, 0.05, 0.3, 0.62, 0.9, 1]) expect(frontReaches(frontAt(t))).toBeCloseTo(t, 4);
    expect(frontReaches(-0.2)).toBe(0);
    expect(frontReaches(1.4)).toBe(1);
  });
});
