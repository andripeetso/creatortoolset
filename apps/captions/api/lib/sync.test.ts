import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { announce, announceWrites, currentSeq, syncApp, topicOf } from "./sync";

type N = { seq: number; topic: string; origin: string | null };

/** Opens the stream as `user` and collects its events until `count` arrived. */
async function listen(user: string, count: number, during: () => Promise<void> | void) {
  const app = new Hono<{ Variables: { user: { username: string } } }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: user });
    await next();
  });
  app.route("/api/sync", syncApp as never);
  const ac = new AbortController();
  const res = await app.request("/api/sync/events", { signal: ac.signal });
  const reader = res.body!.getReader();
  const events: { event: string; data: string }[] = [];
  let buf = "";
  const read = (async () => {
    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      for (let i; (i = buf.indexOf("\n\n")) >= 0; ) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /event: (.*)/.exec(block)?.[1] ?? "";
        if (ev !== "ping") events.push({ event: ev, data: /data: (.*)/.exec(block)?.[1] ?? "" });
      }
    }
  })();
  await new Promise((r) => setTimeout(r, 20));
  await during();
  await Promise.race([read, new Promise((r) => setTimeout(r, 500))]);
  ac.abort();
  return events;
}

describe("sync", () => {
  it("names the topic of an address (src/lib/sync.ts topicOf must agree: its test checks the same table)", () => {
    for (const [path, topic] of [
      ["/api/review/abc", "review"],
      ["/api/x/tiny/editor/1", "x/tiny"],
      ["/api/workshop", "workshop"],
    ] as const) {
      expect(topicOf(path)).toBe(topic);
    }
    expect(topicOf("/health")).toBeNull();
  });

  it("an account hears only its own changes, after a hello with each topic's newest seq", async () => {
    announce("tiny", "review");
    const before = currentSeq();
    const events = await listen("tiny", 2, () => {
      announce("someone-else", "review");
      announce("tiny", "workshop", "tab-1");
    });
    expect(events[0].event).toBe("hello");
    expect(JSON.parse(events[0].data).topics.review).toBe(before);
    expect(events.slice(1).map((e) => JSON.parse(e.data) as N)).toEqual([{ seq: before + 2, topic: "workshop", origin: "tab-1" }]);
  });

  it("only real writes announce: not reads, not 204s, not quiet paths", async () => {
    const app = new Hono<{ Variables: { user: { username: string } } }>();
    app.use("*", async (c, next) => {
      c.set("user", { username: "writer" });
      await next();
    });
    app.use("/api/*", announceWrites as never);
    app.get("/api/review", (c) => c.json([]));
    app.post("/api/review/1", (c) => c.json({ ok: true }));
    app.post("/api/editor/worker/claim", (c) => c.body(null, 204));
    app.post("/api/workshop/sessions/1/seen", (c) => c.json({ ok: true }));
    app.post("/api/clips/1", (c) => c.json({ error: "no" }, 400));
    const events = await listen("writer", 2, async () => {
      await app.request("/api/review");
      await app.request("/api/editor/worker/claim", { method: "POST" });
      await app.request("/api/workshop/sessions/1/seen", { method: "POST" });
      await app.request("/api/clips/1", { method: "POST" });
      await app.request("/api/review/1", { method: "POST", headers: { "X-CT-Client": "tab-2" } });
    });
    const changes = events.filter((e) => e.event === "change").map((e) => JSON.parse(e.data) as N);
    expect(changes.map((c) => [c.topic, c.origin])).toEqual([["review", "tab-2"]]);
  });
});
