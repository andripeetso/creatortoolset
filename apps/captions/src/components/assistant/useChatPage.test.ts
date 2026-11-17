import { afterEach, describe, expect, it } from "vitest";
import { chatPageMove, keepChatPages, keptChatPages } from "./useChatPage";

const card = (id: string) => ({ id, href: `/review/${id}` });

describe("chatPageMove", () => {
  it("turning chat mode on, or loading the app in it, never moves the page", () => {
    expect(chatPageMove(null, { chat: "a", card: card("v1") }, { path: "/workshop", ws: "w1" })).toBeNull();
  });
  it("in the same chat only something new it started moves the page", () => {
    expect(chatPageMove({ chat: "a", card: "v1" }, { chat: "a", card: card("v1") }, undefined)).toBeNull();
    expect(chatPageMove({ chat: "a", card: "v1" }, { chat: "a", card: card("v2") }, undefined)).toBe("/review/v2");
    expect(chatPageMove({ chat: "a" }, { chat: "a" }, undefined)).toBeNull();
  });
  it("another chat brings its own page: where it was left, else the newest thing it made, else its workspace's Home", () => {
    expect(chatPageMove({ chat: "a" }, { chat: "b", card: card("v3"), ws: "w2" }, { path: "/workshop/sessions/s1", ws: "w2" })).toBe("/workshop/sessions/s1");
    expect(chatPageMove({ chat: "a" }, { chat: "b", card: card("v3"), ws: "w2" }, undefined)).toBe("/review/v3");
    // never the page of the chat before it
    expect(chatPageMove({ chat: "a" }, { chat: "b", ws: "w2" }, undefined)).toBe("/");
  });
  it("a page left in another workspace than the chat's now is not brought back", () => {
    expect(chatPageMove({ chat: "a" }, { chat: "b", ws: "w2" }, { path: "/review/v1", ws: "w1" })).toBe("/");
    expect(chatPageMove({ chat: "a" }, { chat: "b", card: card("v3"), ws: "w2" }, { path: "/review/v1", ws: "w1" })).toBe("/review/v3");
  });
  it("a new chat gets no page", () => {
    expect(chatPageMove({ chat: "a" }, { chat: "new", ws: "w2", bare: true }, undefined)).toBeNull();
  });
});

describe("the chats' pages through a reload", () => {
  const g = globalThis as { sessionStorage?: unknown };
  afterEach(() => void delete g.sessionStorage);
  it("are kept in this tab's sessionStorage and read back after a reload", () => {
    const store = new Map<string, string>();
    g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    keepChatPages(new Map([["a", { path: "/review/v1", ws: "w1" }]]));
    const back = keptChatPages();
    expect(back.get("a")).toEqual({ path: "/review/v1", ws: "w1" });
    // what chatPageMove reads after the reload: chat a's page comes back in its workspace
    expect(chatPageMove({ chat: "b" }, { chat: "a", ws: "w1" }, back.get("a"))).toBe("/review/v1");
  });
  it("without storage (private window, blocked) the page still works, in memory only", () => {
    g.sessionStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(() => keepChatPages(new Map([["a", { path: "/x" }]]))).not.toThrow();
    expect(keptChatPages().size).toBe(0);
    delete g.sessionStorage;
    expect(keptChatPages().size).toBe(0);
  });
});
