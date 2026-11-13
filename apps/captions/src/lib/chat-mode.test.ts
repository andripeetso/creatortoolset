import { describe, expect, it } from "vitest";
import { chatWidth, MIN_PAGE, MIN_W } from "./chat-mode";

describe("chatWidth", () => {
  it("is half the window until the edge is dragged, then what was dragged", () => {
    expect(chatWidth(0, 1440)).toBe(720);
    expect(chatWidth(900, 1440)).toBe(900);
  });
  it("never goes narrower than the chats need", () => {
    expect(chatWidth(0, 800)).toBe(MIN_W);
  });
  it("takes the whole window when the page would be left too narrow", () => {
    expect(chatWidth(1440 - MIN_PAGE + 1, 1440)).toBe(1440);
    expect(chatWidth(1440, 1200)).toBe(1200);
  });
});
