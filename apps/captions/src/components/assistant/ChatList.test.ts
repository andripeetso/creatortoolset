import { describe, expect, it } from "vitest";
import type { AssistantChat } from "@contracts/assistant";
import { chatTitle, groupChats } from "./ChatList";

const chat = (id: string, more: Partial<AssistantChat> = {}): AssistantChat => ({ id, title: id, at: 0, last: "", count: 2, ...more });

describe("groupChats", () => {
  const chats = [
    chat("plain"),
    chat("asks", { asks: true, working: true }),
    chat("working", { working: true }),
    chat("done", { unread: true }),
    chat("new", { count: 0, open: true }),
    chat("settled", { settled: true }),
    chat("read", { unread: true, open: true }),
  ];
  it("what asks you first, then what works, then the rest: what finished unseen, the others; a chat nothing was said in is not listed", () => {
    const { groups, settled } = groupChats(chats);
    expect(groups.map((g) => [g.name, g.chats.map((c) => c.id)])).toEqual([
      ["Needs you", ["asks"]],
      ["Working", ["working"]],
      ["Recent", ["done", "plain", "read"]],
    ]);
    expect(settled.map((c) => c.id)).toEqual(["settled"]);
  });
  it("pinned chats are first, the newest pin on top; chats put away are apart, the soonest back first; a settled or put-away chat is in its own fold whether pinned or not", () => {
    const { groups, snoozed, settled } = groupChats([
      chat("old pin", { pinned: 10 }),
      chat("new pin", { pinned: 20, asks: true }),
      chat("away long", { snoozed: 900 }),
      chat("away pinned", { snoozed: 300, pinned: 5 }),
      chat("settled", { settled: true }),
      chat("plain"),
      chat("woke", { woke: true }),
    ]);
    expect(groups.map((g) => [g.name, g.chats.map((c) => c.id)])).toEqual([
      ["Pinned", ["new pin", "old pin"]],
      ["Recent", ["plain", "woke"]],
    ]);
    expect(snoozed.map((c) => c.id)).toEqual(["away pinned", "away long"]);
    expect(settled.map((c) => c.id)).toEqual(["settled"]);
  });
  it("a search keeps the chats that have every word, in the title or the newest line, and drops empty groups", () => {
    const found = groupChats([chat("a", { title: "Barefoot reel", last: "Three hooks" }), chat("b", { title: "Sleep", working: true })], "hooks BARE");
    expect(found.groups.map((g) => [g.name, g.chats.map((c) => c.id)])).toEqual([["Recent", ["a"]]]);
  });
  it("a chat nothing was said in is a new chat", () => {
    expect(chatTitle({ title: "Conversation", count: 0 })).toBe("New chat");
    expect(chatTitle({ title: "Hooks", count: 3 })).toBe("Hooks");
  });
});
