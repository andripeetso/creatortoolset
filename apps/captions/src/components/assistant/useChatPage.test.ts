import { describe, expect, it } from "vitest";
import { chatPageMove } from "./useChatPage";

const card = (id: string) => ({ id, href: `/review/${id}` });

describe("chatPageMove", () => {
  it("turning chat mode on, or loading the app in it, never moves the page", () => {
    expect(chatPageMove(null, { chat: "a", card: card("v1") }, "/workshop")).toBeNull();
  });
  it("in the same chat only something new it started moves the page", () => {
    expect(chatPageMove({ chat: "a", card: "v1" }, { chat: "a", card: card("v1") }, undefined)).toBeNull();
    expect(chatPageMove({ chat: "a", card: "v1" }, { chat: "a", card: card("v2") }, undefined)).toBe("/review/v2");
    expect(chatPageMove({ chat: "a" }, { chat: "a" }, undefined)).toBeNull();
  });
  it("another chat brings its page back: where it was left, else the newest thing it made, else the page stays", () => {
    expect(chatPageMove({ chat: "a" }, { chat: "b", card: card("v3") }, "/workshop/sessions/s1")).toBe("/workshop/sessions/s1");
    expect(chatPageMove({ chat: "a" }, { chat: "b", card: card("v3") }, undefined)).toBe("/review/v3");
    expect(chatPageMove({ chat: "a" }, { chat: "b" }, undefined)).toBeNull();
  });
});
