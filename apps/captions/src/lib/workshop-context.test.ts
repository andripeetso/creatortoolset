import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readComposerContext, saveComposerContext } from "./workshop";

describe("composer context", () => {
  // the test environment is node: a small stand-in for the browser's localStorage
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps quotes, pinned context and the toggles, and reads them back", () => {
    const ctx = { pinned: [{ postId: "p1", handle: "x", field: "caption" as const, text: "hook" }], quotes: [{ blockId: "b1", slide: 0, text: "cut" }], deep: true, mine: false };
    saveComposerContext("k:ctx", ctx);
    expect(readComposerContext("k:ctx")).toEqual(ctx);
  });

  it("clears the key when nothing is left, and reads nothing from a broken value", () => {
    saveComposerContext("k:ctx", { pinned: [], quotes: [], deep: true, mine: false });
    saveComposerContext("k:ctx", { pinned: [], quotes: [], deep: false, mine: false });
    expect(store.has("k:ctx")).toBe(false);
    store.set("k:ctx", "{not json");
    expect(readComposerContext("k:ctx")).toEqual({});
  });

  it("drops a context too big to keep rather than storing half of it", () => {
    const big = { pinned: [], quotes: [{ text: "x".repeat(60_000) }], deep: false, mine: false };
    saveComposerContext("k:ctx", big);
    expect(store.has("k:ctx")).toBe(false);
  });
});
