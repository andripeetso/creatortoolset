import { beforeEach, describe, expect, it } from "vitest";
import { useAuth, type Me } from "./auth";
import { cachedUsage, clearAccountCache, clearLocalCache, putCached, readCached, warmCached } from "./local-cache";

// a stand-in for the browser's localStorage (the test runs in node)
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  },
});

const me = (username: string): Me => ({ username, role: "user", cloud: true, off: [] });
const signIn = (username: string) => useAuth.setState({ me: me(username) });

describe("local-cache", () => {
  beforeEach(() => {
    store.clear();
    clearLocalCache();
    signIn("tinyacrobatics");
  });

  it("keys by account and url, so another account never sees it", () => {
    putCached("tinyacrobatics", "/api/review", [1]);
    expect(readCached("tinyacrobatics", "/api/review")).toEqual([1]);
    expect(readCached("ben", "/api/review")).toBeNull();
    expect(readCached("tinyacrobatics", "/api/review/projects")).toBeNull();
  });

  it("stale then fresh: a warm-up replaces the saved copy", async () => {
    putCached("tinyacrobatics", "/api/clips", ["old"]);
    expect(readCached("tinyacrobatics", "/api/clips")).toEqual(["old"]);
    await warmCached("/api/clips", async () => ["new"]);
    expect(readCached("tinyacrobatics", "/api/clips")).toEqual(["new"]);
  });

  it("sign-out clears every account's saved lists", () => {
    putCached("tinyacrobatics", "/api/clips", ["a"]);
    putCached("ben", "/api/clips", ["b"]);
    clearLocalCache();
    expect(readCached("tinyacrobatics", "/api/clips")).toBeNull();
    expect(readCached("ben", "/api/clips")).toBeNull();
    expect([...store.keys()].some((k) => k.startsWith("ct-swr:"))).toBe(false);
  });

  it("Settings → Cache counts only this account's saved lists", () => {
    putCached("tinyacrobatics", "/api/clips", ["a", "b"]);
    putCached("tinyacrobatics", "/api/review", [1]);
    putCached("ben", "/api/clips", ["c"]);
    const mine = cachedUsage("tinyacrobatics");
    expect(mine.items).toBe(2);
    expect(mine.bytes).toBe('["a","b"]'.length + "[1]".length);
    expect(cachedUsage("ben").items).toBe(1);
    expect(cachedUsage(null)).toEqual({ bytes: 0, items: 0 });
  });

  it("Settings → Cache Clear drops only the signed-in account's lists", () => {
    putCached("tinyacrobatics", "/api/clips", ["a"]);
    putCached("tinyacrobatics", "/api/review", [1]);
    putCached("ben", "/api/clips", ["b"]);
    clearAccountCache("tinyacrobatics");
    expect(readCached("tinyacrobatics", "/api/clips")).toBeNull();
    expect(cachedUsage("tinyacrobatics").items).toBe(0);
    expect(readCached("ben", "/api/clips")).toEqual(["b"]);
    clearAccountCache(null);
    expect(readCached("ben", "/api/clips")).toEqual(["b"]);
  });

  it("a warm-up still in flight during Clear does not save its list back", async () => {
    putCached("tinyacrobatics", "/api/clips", ["old"]);
    let finish!: (v: string[]) => void;
    const pending = warmCached("/api/clips", () => new Promise<string[]>((r) => (finish = r)));
    clearAccountCache("tinyacrobatics");
    finish(["late"]);
    await pending;
    expect(readCached("tinyacrobatics", "/api/clips")).toBeNull();
  });

  it("a failed warm-up keeps the saved copy", async () => {
    putCached("tinyacrobatics", "/api/clips", ["kept"]);
    await warmCached("/api/clips", async () => {
      throw new Error("offline");
    }).catch(() => {});
    expect(readCached("tinyacrobatics", "/api/clips")).toEqual(["kept"]);
  });
});
