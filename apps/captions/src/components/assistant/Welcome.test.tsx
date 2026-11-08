import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NoticeLine, PILL, PILL_TEXT, WELCOME_CONNECTED, WELCOME_NOT_CONNECTED, WelcomeLine, WelcomePill, pillAfter, welcomeStep } from "./Welcome";
import { popupAllowed } from "./AskAboutSelection";

describe("welcome text", () => {
  it("says the exact hello, connected and not", () => {
    expect(WELCOME_CONNECTED).toBe("Hey, I'm your assistant. If you ever need anything, I'm here. Send me a message, drop a video, whatever.");
    expect(WELCOME_NOT_CONNECTED).toBe("Hey, I'm your assistant. I can't help yet, because I need your AI connected first. It only takes a moment.");
  });

  it("shows the typed text with a caret only while typing", () => {
    expect(renderToStaticMarkup(<WelcomeLine text="Hey, I'm" typing />)).toContain("Hey, I&#x27;m");
    expect(renderToStaticMarkup(<WelcomeLine text="Hey" typing />)).toContain("animate-pulse");
    expect(renderToStaticMarkup(<WelcomeLine text="Hey" typing={false} />)).not.toContain("animate-pulse");
  });
});

describe("welcome stages", () => {
  it("starts once, from idle only", () => {
    expect(welcomeStep("idle", "start")).toBe("typing");
    expect(welcomeStep("idle", "closed")).toBe("idle");
    expect(welcomeStep("ended", "start")).toBe("ended");
  });

  it("ignores a press outside while the typing runs", () => {
    expect(welcomeStep("typing", "away")).toBe("typing");
    expect(welcomeStep("typing", "typed")).toBe("ready");
    expect(welcomeStep("ready", "away")).toBe("ended");
  });

  it("ends for good on a sent message or a close", () => {
    expect(welcomeStep("typing", "sent")).toBe("ended");
    expect(welcomeStep("ready", "sent")).toBe("ended");
    expect(welcomeStep("typing", "closed")).toBe("ended");
    expect(welcomeStep("ready", "closed")).toBe("ended");
  });
});

describe("pill", () => {
  it("follows a close or a press outside, once per browser, never after a sent message", () => {
    expect(pillAfter("closed", false)).toBe(true);
    expect(pillAfter("away", false)).toBe(true);
    expect(pillAfter("closed", true)).toBe(false);
    expect(pillAfter("sent", false)).toBe(false);
  });

  it("has the exact text with no full stop, and the timing", () => {
    expect(PILL_TEXT).toBe("I'm here if you need me");
    expect(PILL_TEXT.endsWith(".")).toBe(false);
    expect(PILL).toEqual({ wait: 400, enter: 250, show: 4000, leave: 400 });
  });

  it("is a clickable status line, not a permanent label", () => {
    const html = renderToStaticMarkup(<WelcomePill corner="br" onOpen={() => {}} onDone={() => {}} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("<button");
    expect(html).toContain("I&#x27;m here if you need me");
    expect(html).not.toContain("need me.");
  });
});

describe("notice", () => {
  it("shows its text and a chip only when one is handed over", () => {
    const n = { text: "You can use this, but it still needs a few things.", chip: { label: "Walk me through it", send: "Walk me through it" } };
    expect(renderToStaticMarkup(<NoticeLine notice={n} onChip={() => {}} />)).toContain("Walk me through it");
    expect(renderToStaticMarkup(<NoticeLine notice={n} />)).not.toContain("<button");
  });
});

describe("selection popup gate", () => {
  const ok = { connected: true, finished: true, talk: "app", dialogOpen: false };
  it("needs setup finished, an AI, no dialog, and not the chat-only path", () => {
    expect(popupAllowed(ok)).toBe(true);
    expect(popupAllowed({ ...ok, connected: false })).toBe(false);
    expect(popupAllowed({ ...ok, finished: false })).toBe(false);
    expect(popupAllowed({ ...ok, dialogOpen: true })).toBe(false);
    expect(popupAllowed({ ...ok, talk: "chat" })).toBe(false);
  });
});
