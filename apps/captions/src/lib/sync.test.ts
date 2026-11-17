import { describe, expect, it, vi } from "vitest";
import { topicOf } from "./sync";

describe("sync topicOf", () => {
  it("names the same topic as the server (api/lib/sync.ts) for an address, and for a saved list's key", () => {
    expect(topicOf("/api/review/abc")).toBe("review");
    expect(topicOf("/api/x/tiny/editor/1")).toBe("x/tiny");
    expect(topicOf("/api/workshop")).toBe("workshop");
    expect(topicOf("workshop/sessions?p=1")).toBe("workshop");
    expect(topicOf("instagram/posts?{}|p=")).toBe("instagram");
  });
});

describe("sync connection", () => {
  it("is down from the stream's error until the next hello, and opens a closed stream again", async () => {
    vi.useFakeTimers();
    const opened: FakeSource[] = [];
    class FakeSource {
      static CLOSED = 2;
      readyState = 0;
      onerror: (() => void) | null = null;
      private on = new Map<string, (e: { data: string }) => void>();
      constructor() {
        opened.push(this);
      }
      addEventListener(type: string, fn: (e: { data: string }) => void) {
        this.on.set(type, fn);
      }
      emit(type: string, data: unknown) {
        this.on.get(type)?.({ data: JSON.stringify(data) });
      }
      close() {}
    }
    vi.stubGlobal("EventSource", FakeSource);
    vi.stubGlobal("BroadcastChannel", undefined); // one stream per tab: no leader to wait for
    const sync = await import("./sync");
    sync.startSync();
    const hello = { boot: "b", seq: 1, topics: {} };
    opened[0].emit("hello", hello);
    expect(sync.connected()).toBe(true);
    opened[0].readyState = FakeSource.CLOSED; // a 502 while the server restarts
    opened[0].onerror?.();
    expect(sync.connected()).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(opened).toHaveLength(2);
    opened[1].emit("hello", hello);
    expect(sync.connected()).toBe(true);
    sync.stopSync();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
