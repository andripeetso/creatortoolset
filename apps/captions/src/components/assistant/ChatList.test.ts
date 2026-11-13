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
  it("what asks you first, then what works, then the rest: the new chat, what finished unseen, the others", () => {
    const { groups, settled } = groupChats(chats);
    expect(groups.map((g) => [g.name, g.chats.map((c) => c.id)])).toEqual([
      ["Needs you", ["asks"]],
      ["Working", ["working"]],
      ["Recent", ["new", "done", "plain", "read"]],
    ]);
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
