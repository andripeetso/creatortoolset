import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "mac-claude-")); // the usage tally lands here
const { isOnline, pairDevice } = await import("./devices");
const { backgroundRoom, macUsageLines, macUsageSince, patienceMs, recordUsage, relayRoutes, streamMacClaude: streamOnMac, usageIn, usageOf } = await import("./mac-claude");
const { workspaceScope } = await import("./workshop/workspace");
import type { MacOpts, MacUsage } from "./mac-claude";

const mac = pairDevice("alex", "Test Mac").device;
const macClaudeApp = relayRoutes(() => mac.id);
const macOnline = () => isOnline(mac.id);
/** Every answer in this file runs on the test Mac unless a test names its provider. */
const onMac: MacOpts["provider"] = { instance: "claude", driver: "claude", model: "claude-opus-5-5", effort: "xhigh", device: mac.id, scope: "workspace" };
function streamMacClaude(system: string, user: string, cancel?: AbortSignal, onDelta: (t: string) => void | Promise<void> = () => {}, onUsage?: (u: MacUsage) => void, opts: MacOpts = {}) {
  return streamOnMac(system, user, cancel, onDelta, onUsage, { ...opts, provider: opts.provider ?? onMac });
}

const post = async (path: string, body: unknown = {}): Promise<Response> =>
  macClaudeApp.request(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

describe("Claude on the Mac", () => {
  it("hands a request to the waiting Mac, streams its text in order, resolves with usage", async () => {
    const wait = post("/wait"); // the Mac is polling
    await new Promise((r) => setTimeout(r, 5));
    expect(macOnline()).toBe(true);
    const seen: string[] = [];
    let usage: unknown;
    const answer = streamMacClaude("sys", "hello", undefined, async (t) => {
      await new Promise((r) => setTimeout(r, 10)); // a slow consumer keeps the order
      seen.push(t);
    }, (u) => (usage = u), { label: "Workshop" });
    const req = (await (await wait).json()) as { id: string; system: string; user: string };
    expect(req).toMatchObject({ system: "sys", user: "hello" });
    await post(`/${req.id}/text`, { text: '{"reply":"Hi' });
    await post(`/${req.id}/text`, { text: '{"reply":"Hi' }); // still thinking: no delta
    await post(`/${req.id}/text`, { text: '{"reply":"Hi there"' });
    await post(`/${req.id}/done`, { text: '{"reply":"Hi there"}', usage: { input: 10, output: 5, cache_read: 0, cache_write: 0, cost_usd: 0.25 } });
    expect(await answer).toBe('{"reply":"Hi there"}');
    expect(seen).toEqual(['{"reply":"Hi', '{"reply":"Hi there"']);
    expect(usage).toEqual({ tokens: 15, costUsd: 0.25, input: 10, cacheRead: 0, cacheWrite: 0, output: 5, model: "claude-opus-5-5" });
    expect(Object.values(await macUsageSince(Date.now() - 3_600_000))).toMatchObject([{ Workshop: { calls: 1, tokens: 15, costUsd: 0.25 } }]);
    expect((await post(`/${req.id}/text`, { text: "late" })).status).toBe(404); // gone: the Mac stops
  });

  it("a Codex job keeps its own model: another Claude named for a Claude-only read (Fable) never reaches Codex", async () => {
    const codex: MacOpts["provider"] = { instance: "codex", driver: "codex", model: "gpt-6-luna", effort: "high", device: mac.id, scope: "workspace" };
    const wait = post("/wait");
    await new Promise((r) => setTimeout(r, 5));
    const answer = streamMacClaude("sys", "read", undefined, () => {}, undefined, { provider: codex, model: "claude-fable-5-1" });
    const req = (await (await wait).json()) as { id: string; driver: string; model: string };
    expect(req).toMatchObject({ driver: "codex", model: "gpt-6-luna" });
    await post(`/${req.id}/done`, { text: "ok" });
    expect(await answer).toBe("ok");
  });

  it("a relay that keeps big files gets a hash for each and fetches it once; an old relay still gets the text", async () => {
    const book = "chapter\n".repeat(40_000);
    const run = async (body: unknown) => {
      const wait = post("/wait", body);
      await new Promise((r) => setTimeout(r, 5));
      const answer = streamMacClaude("sys", "read", undefined, () => {}, undefined, { files: { "context/book.md": book, "a.md": "small" } });
      const req = (await (await wait).json()) as { id: string; files: Record<string, string> };
      await post(`/${req.id}/done`, { text: "ok" });
      await answer;
      return req.files;
    };
    const keeps = await run({ blobs: true });
    expect(keeps["a.md"]).toBe("small");
    expect(keeps["context/book.md"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    const blob = await post(`/blob/${keeps["context/book.md"]!.slice(7)}`);
    expect(((await blob.json()) as { text: string }).text).toBe(book);
    expect((await run({}))["context/book.md"]).toBe(book);
  });

  it("a picture goes as a hash whatever its size, so a chat's pictures cost one fetch each, not one per turn", async () => {
    const pic = "base64:/9j/4AAQSkZJRg==";
    const wait = post("/wait", { blobs: true });
    await new Promise((r) => setTimeout(r, 5));
    const answer = streamMacClaude("sys", "read", undefined, () => {}, undefined, { files: { "attached/5f0c2a91/01-1.jpg": pic } });
    const req = (await (await wait).json()) as { id: string; files: Record<string, string> };
    expect(req.files["attached/5f0c2a91/01-1.jpg"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    const blob = await post(`/blob/${req.files["attached/5f0c2a91/01-1.jpg"]!.slice(7)}`);
    expect(((await blob.json()) as { text: string }).text).toBe(pic);
    await post(`/${req.id}/done`, { text: "ok" });
    await answer;
  });

  it("files for one run only (a timeline's video part) go with the request, never as a hash the Mac keeps", async () => {
    const part = "base64:AAAAIGZ0eXBpc29t";
    const wait = post("/wait", { blobs: true });
    await new Promise((r) => setTimeout(r, 5));
    const answer = streamMacClaude("sys", "watch", undefined, () => {}, undefined, { files: { "video.mp4": part }, once: true });
    const req = (await (await wait).json()) as { id: string; files: Record<string, string> };
    expect(req.files["video.mp4"]).toBe(part);
    await post(`/${req.id}/done`, { text: "ok" });
    await answer;
  });

  it("a text cut in half an emoji reaches the Mac as JSON it can read (a lone \\ud83d made it drop the whole request)", async () => {
    const cut = "Tere 😀".slice(0, 6);
    const wait = post("/wait");
    await new Promise((r) => setTimeout(r, 5));
    const answer = streamMacClaude(`sys ${cut}`, "hi", undefined, () => {}, undefined, { files: { "posts/a.md": `${cut} 😀 ok` } });
    const raw = await (await wait).text();
    expect(raw).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    const req = JSON.parse(raw) as { id: string; system: string; files: Record<string, string> };
    expect(req.system).toBe("sys Tere �");
    expect(req.files["posts/a.md"]).toBe("Tere � 😀 ok");
    await post(`/${req.id}/done`, { text: "ok" });
    await answer;
  });

  it("a Workshop folder's session goes to the Mac with its id and comes back with what became of it", async () => {
    const wait = post("/wait");
    await new Promise((r) => setTimeout(r, 5));
    const got: unknown[] = [];
    const answer = streamMacClaude("sys", "short", undefined, () => {}, undefined, {
      files: { "a.md": "1" },
      session: { key: "s-1", resume: "claude-7" },
      onSession: (s) => got.push(s),
    });
    const req = (await (await wait).json()) as Record<string, unknown>;
    expect(req).toMatchObject({ user: "short", session: "s-1", resume: "claude-7" });
    await post(`/${req.id}/done`, { text: "{}", usage: {}, session_id: "claude-7", session_state: "lost" });
    await answer;
    expect(got).toEqual([{ id: "claude-7", state: "lost" }]);
  });

  it("a cold request carries no session and reports none", async () => {
    const wait = post("/wait");
    await new Promise((r) => setTimeout(r, 5));
    const answer = streamMacClaude("sys", "cold", undefined, () => {}, undefined, { onSession: () => { throw new Error("no session"); } });
    const req = (await (await wait).json()) as Record<string, unknown>;
    expect(req).not.toHaveProperty("session");
    await post(`/${req.id}/done`, { text: "{}", usage: {}, session_id: "ignored" });
    await answer;
  });

  it("hands out what a person waits on first, and, after a person asked, one slot fewer to background requests", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const bg = [1, 2, 3, 4].map((i) => streamMacClaude("sys", `bg${i}`, undefined, () => {}, undefined, { background: true, web: true }));
    const fg = streamMacClaude("sys", "now", undefined, () => {});
    for (const p of [...bg, fg]) p.catch(() => {});
    const got = async () => (await (await post("/wait")).json()) as { id: string; user: string; web: boolean };
    const first = await got();
    expect(first.user).toBe("now");
    const a = await got();
    const b = await got();
    const b2 = await got();
    expect([a.user, b.user, b2.user]).toEqual(["bg1", "bg2", "bg3"]);
    expect(a.web).toBe(true);
    const third = post("/wait");
    expect(await Promise.race([third.then(() => "claimed"), sleep(50).then(() => "waiting")])).toBe("waiting");
    await post(`/${a.id}/fail`, { error: "x" }); // a slot frees: the waiting poll gets bg4
    const c = (await (await third).json()) as { id: string; user: string };
    expect(c.user).toBe("bg4");
    for (const r of [first, b, b2, c]) await post(`/${r.id}/fail`, { error: "x" });
    // nobody asked for five minutes, or ever: background takes every slot
    expect(backgroundRoom(mac.id)).toBe(3);
    expect(backgroundRoom(mac.id, Date.now() + 5 * 60_000 + 1)).toBe(4);
    expect(backgroundRoom("never-asked")).toBe(4);
  });

  it("rejects when the Mac fails, so the caller can fall back", async () => {
    const answer = streamMacClaude("sys", "x", undefined, () => {});
    const req = (await (await post("/wait")).json()) as { id: string };
    await post(`/${req.id}/fail`, { error: "usage limit" });
    await expect(answer).rejects.toThrow(/usage limit/);
  });

  it("a provider check on a plan at its limit passes, with the one sentence a row shows; any other failure still fails it", async () => {
    const { checkInstance } = await import("../providers");
    const inst = { id: "local-claude", driver: "claude" as const, name: "Claude Code", enabled: true, device: mac.id };
    // Claude's own words on 2026-11-10: the login is signed in and reachable, its week is used up
    const limited = checkInstance("alex", inst, null);
    await post(`/${((await (await post("/wait")).json()) as { id: string }).id}/fail`, { error: "You've hit your weekly limit · resets Nov 11 at 5pm (America/Costa_Rica)", limit: true });
    expect(await limited).toMatchObject({ ok: true, note: "Your Claude plan's weekly limit is reached; it resets Nov 11 at 5pm." });
    const broken = checkInstance("alex", inst, null);
    await post(`/${((await (await post("/wait")).json()) as { id: string }).id}/fail`, { error: "boom" });
    const result = await broken;
    expect(result).toMatchObject({ ok: false, error: "Claude on the Mac: boom" });
    expect(result).not.toHaveProperty("note");
  });

  it("says why an answer did not come: a Stop, a Claude limit, or a failure", async () => {
    const stopped = new AbortController();
    const a = streamMacClaude("sys", "a", stopped.signal, () => {}).catch((e: unknown) => e);
    stopped.abort();
    expect(await a).toMatchObject({ kind: "stopped", message: "Stopped" });

    const b = streamMacClaude("sys", "b", undefined, () => {}).catch((e: unknown) => e);
    await post(`/${((await (await post("/wait")).json()) as { id: string }).id}/fail`, { error: "Claude AI usage limit reached|1700000000", limit: true });
    expect(await b).toMatchObject({ kind: "limit" });

    const d = streamMacClaude("sys", "d", undefined, () => {}).catch((e: unknown) => e);
    await post(`/${((await (await post("/wait")).json()) as { id: string }).id}/fail`, { error: "No conversation found", gone: true });
    expect(await d).toMatchObject({ kind: "gone" });

    const c = streamMacClaude("sys", "c", undefined, () => {}).catch((e: unknown) => e);
    await post(`/${((await (await post("/wait")).json()) as { id: string }).id}/fail`, { error: "boom" });
    expect(await c).toMatchObject({ kind: "failed" });
  });

  it("gives a busy Mac three minutes", () => {
    expect(patienceMs(false, false)).toBe(15_000);
    expect(patienceMs(false, true)).toBe(180_000);
    expect(patienceMs(true, true)).toBe(600_000);
    // right after a restart the Macs' relays are backing off (their polls were cut): a request made then waits for them
    expect(patienceMs(false, false, 5_000)).toBe(45_000);
    expect(patienceMs(true, false, 5_000)).toBe(600_000);
    expect(patienceMs(false, false, 60_000)).toBe(15_000);
  });

  it("a running job keeps the Mac on: its posts count as polls", async () => {
    vi.useFakeTimers();
    try {
      const answer = streamMacClaude("sys", "long", undefined, () => {}).catch((e: unknown) => e);
      const req = (await (await post("/wait")).json()) as { id: string };
      await vi.advanceTimersByTimeAsync(45_000);
      expect(macOnline()).toBe(false); // no poll for 45 s
      await post(`/${req.id}/text`, { text: "still writing" });
      expect(macOnline()).toBe(true);
      await post(`/${req.id}/fail`, { error: "done" });
      expect(await answer).toMatchObject({ kind: "failed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a provider with no Mac runs nowhere: it is refused at once, as unclaimed", async () => {
    await expect(streamOnMac("sys", "x", undefined, () => {})).rejects.toMatchObject({ kind: "unclaimed" });
  });

  it("the 20 minutes count Claude's work, not the time a permission question waits for a person", async () => {
    vi.useFakeTimers();
    try {
      let status: "waiting" | "allowed" = "waiting";
      let settled = false;
      const answer = streamMacClaude("sys", "tidy", undefined, () => {}, undefined, { onAsk: () => status })
        .catch((e: unknown) => e)
        .finally(() => (settled = true));
      const req = (await (await post("/wait")).json()) as { id: string };
      // posts every 20 s, as the Mac does (an ask again every few seconds while it waits, text while it works)
      const run = async (minutes: number, send: () => Promise<Response>) => {
        for (let t = 0; t < minutes * 3; t++) {
          await vi.advanceTimersByTimeAsync(20_000);
          await send();
        }
      };
      const ask = () => post(`/${req.id}/ask`, { ask_id: "a1", tool: "Bash", detail: "mv a b" });
      const write = () => post(`/${req.id}/text`, { text: "working" });
      await run(15, ask); // the owner thinks it over for 15 minutes
      status = "allowed";
      await ask();
      await run(16, write); // 16 minutes of work: 31 in all, under 20 of them Claude's
      expect(settled).toBe(false);
      await run(5, write);
      expect(await answer).toMatchObject({ kind: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unclaimed request gives up after its patience, as unclaimed", async () => {
    vi.useFakeTimers();
    try {
      const p = streamMacClaude("sys", "nobody", undefined, () => {}).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await p).toMatchObject({ kind: "unclaimed" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("usage per workspace", () => {
  const since = () => Date.now() - 3_600_000;
  const linesOf = async (label: string) => (await macUsageLines(since())).filter((l) => l.label === label).map(({ hour: _hour, label: _label, ...rest }) => rest);

  it("an answer counts under the workspace its request was in, though it arrives in the computer's own request", async () => {
    const wait = post("/wait");
    const answer = workspaceScope.run({ id: "brand-one" }, () => streamMacClaude("sys", "hi", undefined, () => {}, undefined, { label: "In a workspace" }));
    const req = (await (await wait).json()) as { id: string };
    await post(`/${req.id}/done`, { text: "ok", usage: { input: 4, output: 2, cost_usd: 0.5 } });
    await answer;
    await vi.waitFor(async () => expect(await linesOf("In a workspace")).toEqual([{ key: "workspace:claude", workspace: "brand-one", model: "claude-opus-5-5", calls: 1, tokens: 6, costUsd: 0.5, input: 4, cacheRead: 0, cacheWrite: 0, output: 2 }]));
  });

  it("work outside a request names its workspace; a call in none, or with an id that is not one, counts in none; the totals hold them all", async () => {
    const u = { tokens: 10, costUsd: 1 };
    await usageIn("brand-two", () => recordUsage("Split", u, "claude", "alex"));
    await workspaceScope.run({ id: "brand-one" }, () => usageIn("brand-two", () => recordUsage("Split", u))); // the work's own wins over the request's
    await recordUsage("Split", u, "claude", "alex");
    await workspaceScope.run({ id: "../not an id" }, () => recordUsage("Split", u));
    const none = { calls: 1, tokens: 10, costUsd: 1, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }; // no split given
    expect(await linesOf("Split")).toEqual([
      { key: "alex:claude", workspace: "brand-two", ...none },
      { workspace: "brand-two", ...none },
      { key: "alex:claude", ...none },
      none,
    ]);
    expect(Object.values(await macUsageSince(since())).map((h) => h.Split).find(Boolean)).toMatchObject({ calls: 4, tokens: 40, by: { "alex:claude": { calls: 2 } } });
  });

  it("each model and its token types are a line of their own; calls recorded before models were kept stay a line with no model", async () => {
    await recordUsage("Mixed", { tokens: 10, costUsd: 1, input: 2, cacheRead: 4, cacheWrite: 0, output: 4, model: "m1" }, "claude", "alex", "brand-one");
    await recordUsage("Mixed", { tokens: 20, costUsd: 2, input: 5, output: 15, model: "m2" }, "claude", "alex", "brand-one");
    // two calls from before 2026-11-23, in the totals and their splits only (no leaf)
    const entry = Object.values(await macUsageSince(since())).map((h) => h.Mixed).find(Boolean)!;
    const old = (x: { calls: number; tokens: number; costUsd: number }) => Object.assign(x, { calls: x.calls + 2, tokens: x.tokens + 30, costUsd: x.costUsd + 3 });
    old(entry);
    old(entry.by!["alex:claude"]!);
    old(entry.ws!["brand-one"]!);
    old(entry.ws!["brand-one"]!.by!["alex:claude"]!);
    const at = { key: "alex:claude", workspace: "brand-one" };
    expect(await linesOf("Mixed")).toEqual([
      { ...at, model: "m1", calls: 1, tokens: 10, costUsd: 1, input: 2, cacheRead: 4, cacheWrite: 0, output: 4 },
      { ...at, model: "m2", calls: 1, tokens: 20, costUsd: 2, input: 5, cacheRead: 0, cacheWrite: 0, output: 15 },
      { ...at, calls: 2, tokens: 30, costUsd: 3 },
    ]);
  });

  it("a relay answer names its model: the one asked for among the answer's models, else the first", () => {
    expect(usageOf({ input: 1, output: 2, models: ["claude-haiku-5-5", "claude-opus-5-5"] }, "claude-opus-5-5")?.model).toBe("claude-opus-5-5");
    expect(usageOf({ input: 1, output: 2, models: ["gpt-5.5"] }, "")?.model).toBe("gpt-5.5");
    expect(usageOf({ input: 1, output: 2 }, "")).not.toHaveProperty("model");
  });
});
