import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Turn mechanics replayed with saved model replies: the model is the only thing mocked. No network, no keys.
const dataDir = mkdtempSync(path.join(tmpdir(), "ws-turn-"));
process.env.DATA_DIR = dataDir;
process.env.ANTHROPIC_API_KEY = "test-key";

vi.mock("./ai-complete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai-complete")>()),
  streamWithFallback: vi.fn(),
  completeWithFallback: vi.fn(),
}));
// The Mac counts as on, so an admin's turn goes to Claude on the Mac first.
vi.mock("./lib/mac-claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/mac-claude")>()),
}));
// open windows hear of a turn's saves (lib/workshop/job): watched, not sent
vi.mock("./lib/sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/sync")>()),
  announce: vi.fn(),
}));
vi.mock("./lib/devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/devices")>()),
  isOnline: () => true,
}));

const { Hono } = await import("hono");
const { workshopApp } = await import("./workshop");
const { streamWithFallback, AiProviderError } = await import("./ai-complete");
const { MacClaudeError } = await import("./lib/mac-claude");
const mocked = vi.mocked(streamWithFallback);
const heard = vi.mocked((await import("./lib/sync")).announce);
const { createUser } = await import("./users");
const { pairDevice } = await import("./lib/devices");
const { saveSettings } = await import("./lib/providers");
createUser("alex", "password1", { role: "admin" }); // the workspace's Claude runs on an admin's Mac
const mac = pairDevice("alex", "Alex's Mac").device;
await saveSettings({
  instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.id }],
  default: { instance: "claude", model: "claude-opus-5-5", effort: "xhigh" },
  jobs: {},
});

type Msg = { id: string; role: string; text: string; status?: string; error?: string; notes?: string[]; edits?: { blockIds: string[]; versionBefore?: string; versionAfter?: string; created?: boolean }; audit?: { applied?: string[] } };

const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "alex", role: "admin", cloud: true, off: [] });
  await next();
});
app.route("/api/workshop", workshopApp as never);
const call = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

let seq = 0;
const uuid = () => `aaaaaaaa-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

/** A session with one carousel; `locked` ids and any saved chat messages are written as the app would keep them. */
function seed(blocks: string[], opts: { locked?: string[]; messages?: Msg[]; title?: string } = {}) {
  const id = uuid();
  const docId = uuid();
  const sdir = path.join(dataDir, "workshop", "sessions", id);
  mkdirSync(path.join(sdir, "docs"), { recursive: true });
  writeFileSync(path.join(sdir, "meta.json"), JSON.stringify({ id, owner: "alex", title: opts.title ?? "Strength training", query: "", sources: [], drafts: [], createdAt: 1, updatedAt: 1 }));
  writeFileSync(
    path.join(sdir, "docs", `${docId}.json`),
    JSON.stringify({
      id: docId,
      sessionId: id,
      kind: "carousel",
      title: "Carousel",
      frameworkIds: [],
      versions: [],
      nextBlock: blocks.length + 1,
      nextVersion: 1,
      createdAt: 1,
      updatedAt: 2,
      blocks: blocks.map((text, i) => ({ id: `b${i + 1}`, text, author: "ai", at: 1 })),
      ...(opts.locked ? { locked: opts.locked } : {}),
    }),
  );
  // every session has a Notes document (the list route adds one when it is missing)
  writeFileSync(path.join(sdir, "docs", `${uuid()}.json`), JSON.stringify({ id: uuid(), sessionId: id, kind: "notes", title: "Notes", frameworkIds: [], versions: [], nextBlock: 1, nextVersion: 1, createdAt: 1, updatedAt: 1, blocks: [] }));
  writeFileSync(path.join(sdir, "chat.json"), JSON.stringify({ messages: opts.messages ?? [] }));
  return { id, docId };
}

const chatOf = async (id: string) => (await (await call("GET", `/api/workshop/sessions/${id}/chat`)).json()) as Msg[];
const docOf = async (id: string, docId: string) =>
  (await (await call("GET", `/api/workshop/sessions/${id}/docs/${docId}`)).json()) as { blocks: Array<{ id: string; text: string }>; caption?: { text: string }; versions: Array<{ id: string }> };

async function send(id: string, docId: string, text: string, extra: Record<string, unknown> = {}) {
  const r = await call("POST", `/api/workshop/sessions/${id}/chat`, { docId, text, ...extra });
  return { status: r.status, body: (await r.json()) as { ask?: Msg; reply?: Msg; error?: string } };
}

/** Waits for the reply to leave "thinking". */
async function settled(id: string, replyId: string): Promise<Msg> {
  for (let i = 0; i < 500; i++) {
    const m = (await chatOf(id)).find((x) => x.id === replyId);
    if (m && m.status !== "thinking") return m;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("the turn did not finish");
}

/** The model's answer, as the stream hands it over: parsed by the same parser as the real one. */
const answer = (o: object) => JSON.stringify(o);
type StreamFn = (system: string, user: string, signal: AbortSignal | undefined, parse: (t: string) => unknown) => unknown;
const once = (fn: StreamFn) => mocked.mockImplementationOnce(fn as never);
const replies = (text: string) => once(async (_s, _u, _sig, parse) => ({ result: parse(text), provider: "Claude (Mac)" }));

beforeEach(() => {
  mocked.mockReset();
});

/**
 * Resolves when open windows have been told of `topic`. The watched announce is the handle, so nothing here waits by
 * the clock: on a busy machine a turn can take longer than any fixed wait to reach the model or to end.
 */
const told = (topic: string) =>
  new Promise<void>((resolve) => {
    const is = (u: unknown, t: unknown) => u === "alex" && t === topic;
    if (heard.mock.calls.some(([u, t]) => is(u, t))) return resolve();
    heard.mockImplementation(((u: string, t: string) => {
      if (is(u, t)) resolve();
    }) as never);
  });

describe("a turn's saves reach open windows", () => {
  it("while the reply is written (its progress arrives on the Mac's own request) and when it ends", async () => {
    const { id, docId } = seed(["Slide"]);
    let hooks: { onDelta?: (t: string) => Promise<void> | void } | undefined;
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    // the turn has reached the model: said by the model's stand-in itself
    let begun!: () => void;
    const started = new Promise<void>((r) => (begun = r));
    mocked.mockImplementationOnce((async (_s: string, _u: string, _sig: unknown, parse: (t: string) => unknown, h: typeof hooks) => {
      hooks = h;
      begun();
      await gate;
      return { result: parse(answer({ reply: "Done.", edits: [] })), provider: "Claude (Mac)" };
    }) as never);
    const { body } = await send(id, docId, "Tighten it.");
    try {
      await started;
      await new Promise((r) => setTimeout(r, 1100)); // past the throttle
      heard.mockClear();
      // only this session's own page refetches while the reply is written, a throttle later at most
      const whileWritten = told(`workshop/s/${id}`);
      await hooks!.onDelta!(answer({ reply: "Half way" }).slice(0, -2)); // called here, outside the turn's own chain
      await whileWritten;
      expect(heard).not.toHaveBeenCalledWith("alex", "workshop");
      heard.mockClear();
      const atTheEnd = told("workshop"); // the end: every Workshop list
      finish();
      await settled(id, body.reply!.id);
      await atTheEnd;
    } finally {
      // whatever went wrong above, the turn ends inside its own test: left waiting, it would answer the next test's model
      finish();
      await settled(id, body.reply!.id).catch(() => {});
      heard.mockReset();
    }
  });
});

describe("a turn's edits", () => {
  it("leaves a locked slide as it is, reports it in notes and keeps the reply text clean", async () => {
    const { id, docId } = seed(["Hook for the piece", "Second slide"], { locked: ["b1"] });
    replies(answer({ reply: "Rewrote the second slide.", edits: [{ op: "replace", id: "b1", text: "Changed hook" }, { op: "replace", id: "b2", text: "Changed second slide" }] }));
    const { body } = await send(id, docId, "Make the second slide sharper.");
    const done = await settled(id, body.reply!.id);

    expect(done.status).toBe("done");
    expect(done.text).toBe("Rewrote the second slide.");
    expect(done.notes).toContain("Left slide 1 as you locked it.");
    expect((await docOf(id, docId)).blocks.map((b) => b.text)).toEqual(["Hook for the piece", "Changed second slide"]);
    expect(done.edits?.blockIds).toEqual(["b2"]);
    expect(done.edits?.versionAfter).toBeTruthy();
  });

  it("keeps set_caption as the caption of a new document and turns the replaced slide into a new slide", async () => {
    const { id, docId } = seed(["Old slide"]);
    replies(answer({ reply: "Made the carousel.", newDocument: { kind: "carousel", title: "New carousel" }, edits: [{ op: "set_caption", text: "Caption for the post." }, { op: "replace", id: "b1", text: "A fresh first slide." }] }));
    const { body } = await send(id, docId, "Write a new carousel and the post description for it.");
    const done = await settled(id, body.reply!.id);

    expect(done.edits?.created).toBe(true);
    const docs = (await (await call("GET", `/api/workshop/sessions/${id}/docs`)).json()) as Array<{ title: string; caption?: { text: string }; blocks: Array<{ text: string }> }>;
    const made = docs.find((d) => d.title === "New carousel")!;
    expect(made.caption?.text).toBe("Caption for the post.");
    expect(made.blocks.map((b) => b.text)).toEqual(["A fresh first slide."]);
    expect((await docOf(id, docId)).blocks.map((b) => b.text)).toEqual(["Old slide"]);
  });

  it("fills the empty carousel it was asked on instead of making a second carousel beside it", async () => {
    const { id, docId } = seed([]);
    replies(answer({ reply: "Added your slides.", newDocument: { kind: "carousel", title: "Mornings get easier" }, edits: [{ op: "append", text: "Slide one." }, { op: "replace", id: "b1", text: "Slide two." }] }));
    const { body } = await send(id, docId, "Audit this one properly please");
    const done = await settled(id, body.reply!.id);

    expect(done.edits?.created).toBeUndefined();
    const docs = (await (await call("GET", `/api/workshop/sessions/${id}/docs`)).json()) as Array<{ id: string; kind: string; title: string }>;
    expect(docs.filter((d) => d.kind === "carousel").map((d) => [d.id, d.title])).toEqual([[docId, "Mornings get easier"]]);
    expect((await docOf(id, docId)).blocks.map((b) => b.text)).toEqual(["Slide one.", "Slide two."]);
  });

  it("a turn's versions can be read back block by block, and the availability says whether the Mac is on", async () => {
    const { id, docId } = seed(["First", "Second slide"]);
    replies(answer({ reply: "Done.", edits: [{ op: "replace", id: "b2", text: "Changed second slide" }] }));
    const { body } = await send(id, docId, "Tighten the second slide.");
    const done = await settled(id, body.reply!.id);
    const before = done.edits!.versionBefore!;
    const after = done.edits!.versionAfter!;

    const old = (await (await call("GET", `/api/workshop/sessions/${id}/docs/${docId}/versions/${before}?blocks=b2`)).json()) as { blocks: Array<{ id: string; text: string }> };
    expect(old.blocks.map((b) => [b.id, b.text])).toEqual([["b2", "Second slide"]]);
    const now = (await (await call("GET", `/api/workshop/sessions/${id}/docs/${docId}/versions/${after}?blocks=b2`)).json()) as { blocks: Array<{ text: string }> };
    expect(now.blocks.map((b) => b.text)).toEqual(["Changed second slide"]);
    expect((await call("GET", `/api/workshop/sessions/${id}/docs/${docId}/versions/v999`)).status).toBe(404);
    const all = (await (await call("GET", `/api/workshop/sessions/${id}/docs/${docId}/versions/${before}`)).json()) as { blocks: unknown[] };
    expect(all.blocks).toHaveLength(2);

    const avail = (await (await call("GET", "/api/workshop/availability")).json()) as { mac?: boolean };
    expect(avail.mac).toBe(true);
  });
});

describe("the post a session became", () => {
  it("a pasted link marks it published; 'not this post' unlinks it and remembers the post", async () => {
    const { id } = seed(["A slide"]);
    const bad = await call("PATCH", `/api/workshop/sessions/${id}`, { posted: "https://example.com/x" });
    expect(bad.status).toBe(400);
    const linked = (await (await call("PATCH", `/api/workshop/sessions/${id}`, { posted: "https://www.instagram.com/reel/DQx1abcDEF/?igsh=1" })).json()) as { status: string; posted: { shortcode: string; by: string } };
    expect(linked.status).toBe("published");
    expect(linked.posted).toMatchObject({ shortcode: "DQx1abcDEF", by: "you" });
    const unlinked = (await (await call("PATCH", `/api/workshop/sessions/${id}`, { posted: null })).json()) as { posted?: unknown; postedNot: string[] };
    expect(unlinked.posted).toBeUndefined();
    expect(unlinked.postedNot).toEqual(["DQx1abcDEF"]);
  });
});

describe("sharing", () => {
  it("moves an idea, writing or ready session to In Production, never a published one back", async () => {
    const { id } = seed(["A slide"]);
    await call("PATCH", `/api/workshop/sessions/${id}`, { status: "ready" });
    const shared = (await (await call("POST", `/api/workshop/sessions/${id}/shares`, { all: true })).json()) as { status: string };
    expect(shared.status).toBe("production");
    await call("PATCH", `/api/workshop/sessions/${id}`, { status: "published" });
    const again = (await (await call("POST", `/api/workshop/sessions/${id}/shares`, { all: true })).json()) as { status: string };
    expect(again.status).toBe("published");
  });
});

describe("one turn at a time", () => {
  it("a retry replaces the failed pair in the same write, and a second turn is refused while one runs", async () => {
    const askOld: Msg = { id: uuid(), role: "user", text: "Make it shorter", status: "done" } as Msg;
    const replyOld: Msg = { id: uuid(), role: "assistant", text: "", status: "error", error: "Claude on the Mac did not finish this reply" } as Msg;
    const { id, docId } = seed(["Long slide"], { messages: [askOld, replyOld] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    once(async (_s, _u, _sig, parse) => {
      await gate;
      return { result: parse(answer({ reply: "Shorter now.", edits: [{ op: "replace", id: "b1", text: "Short." }] })), provider: "Claude (Mac)" };
    });

    const retry = await send(id, docId, "Make it shorter", { retryOf: [askOld.id, replyOld.id] });
    expect(retry.status).toBe(202);
    const second = await send(id, docId, "And also this");
    expect(second.status).toBe(409);
    expect((await chatOf(id)).map((m) => m.id)).toEqual([retry.body.ask!.id, retry.body.reply!.id]);

    release();
    const done = await settled(id, retry.body.reply!.id);
    expect(done.status).toBe("done");
    expect((await chatOf(id)).map((m) => m.id)).toEqual([retry.body.ask!.id, retry.body.reply!.id]);
  });
});

describe("audit fixes", () => {
  const claims = [
    { id: "c1", where: "b1", claim: "The study of 7000 adults", verdict: "partly", confidence: 0.6, evidence: "", sources: [], fix: "The study of 700 adults" },
    { id: "c2", where: "b2", claim: "Other slide", verdict: "partly", confidence: 0.6, evidence: "", sources: [], fix: "Another slide" },
  ];
  const auditMessage = (docId: string): Msg =>
    ({ id: uuid(), role: "assistant", text: "Accuracy audit", status: "done", docId, audit: { target: { type: "document", id: docId, title: "Carousel" }, depth: "quick", result: { score: 60, summary: "", claims, citations: [] } } }) as unknown as Msg;

  it("a fix on a locked slide is refused and not marked applied; the others land and the refusal is named", async () => {
    const seeded = seed(["The study of 7000 adults", "Other slide"], { locked: ["b1"] });
    const audit = auditMessage(seeded.docId);
    const messages = [audit];
    writeFileSync(path.join(dataDir, "workshop", "sessions", seeded.id, "chat.json"), JSON.stringify({ messages }));
    const { id, docId } = seeded;

    const one = await call("POST", `/api/workshop/sessions/${id}/chat/${audit.id}/apply-fix`, { claimId: "c1" });
    expect(one.status).toBe(400);
    expect(((await one.json()) as { error: string }).error).toBe("Slide 1 is locked, so its fix was not applied.");

    const all = await call("POST", `/api/workshop/sessions/${id}/chat/${audit.id}/apply-fixes`, { claimIds: ["c1", "c2"] });
    expect(all.status).toBe(200);
    const body = (await all.json()) as { applied: string[]; locked: string[] };
    expect(body.applied).toEqual(["c2"]);
    expect(body.locked).toEqual(["Slide 1"]);
    expect((await docOf(id, docId)).blocks.map((b) => b.text)).toEqual(["The study of 7000 adults", "Another slide"]);
    expect((await chatOf(id)).find((m) => m.id === audit.id)?.audit?.applied).toEqual(["c2"]);
  });

  it("when only locked slides are asked for, nothing is applied and the error says the slide is locked", async () => {
    const seeded = seed(["The study of 7000 adults"], { locked: ["b1"] });
    const audit = auditMessage(seeded.docId);
    writeFileSync(path.join(dataDir, "workshop", "sessions", seeded.id, "chat.json"), JSON.stringify({ messages: [audit] }));
    const r = await call("POST", `/api/workshop/sessions/${seeded.id}/chat/${audit.id}/apply-fixes`, { claimIds: ["c1"] });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("Slide 1 is locked, so its fix was not applied.");
  });
});

describe("stop and the Mac fallback", () => {
  it("Stop ends the running turn as Stopped, and nothing is re-run on the API key", async () => {
    const { id, docId } = seed(["Piece"]);
    let started!: () => void;
    const begun = new Promise<void>((r) => (started = r));
    mocked.mockImplementationOnce((async (_s: string, _u: string, signal: AbortSignal) => {
      started();
      return await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new MacClaudeError("Stopped", "stopped"))));
    }) as never);

    const { body } = await send(id, docId, "Rewrite everything.");
    await begun;
    const stop = await call("POST", `/api/workshop/sessions/${id}/chat/${body.reply!.id}/stop`);
    expect(stop.status).toBe(200);
    const done = await settled(id, body.reply!.id);
    expect(done.status).toBe("error");
    expect(done.error).toBe("Stopped");
    expect(mocked.mock.calls).toHaveLength(1);
    expect((await call("POST", `/api/workshop/sessions/${id}/chat/${body.reply!.id}/stop`)).status).toBe(404);
  });

  it("a turn the provider didn't finish ends with a message and runs nowhere else", async () => {
    const { id, docId } = seed(["Piece"]);
    mocked.mockImplementationOnce((async () => {
      throw new AiProviderError("Claude took over 20 minutes", "FAILED", true, new MacClaudeError("Claude took over 20 minutes", "timeout"));
    }) as never);
    const { body } = await send(id, docId, "Rewrite everything.");
    const done = await settled(id, body.reply!.id);
    expect(done.status).toBe("error");
    expect(done.error).toContain("Claude took over 20 minutes");
    expect(done.error).toContain("Retry sends it again.");
    expect(mocked.mock.calls).toHaveLength(1);
  });

  it("a turn while the Mac is off says so: no API key for an account", async () => {
    const { id, docId } = seed(["Piece"]);
    mocked.mockImplementationOnce((async () => {
      throw new AiProviderError("The Mac is off", "FAILED", true, new MacClaudeError("The Mac is off: the AI providers run on it (open the Creator Toolset Mac app on it)", "unclaimed"));
    }) as never);
    const { body } = await send(id, docId, "Rewrite everything.");
    const done = await settled(id, body.reply!.id);
    expect(done.status).toBe("error");
    expect(done.error).toContain("The Mac is off");
    expect(mocked.mock.calls).toHaveLength(1);
    expect(mocked.mock.calls[0]![5]).toMatchObject({ only: ["mac"], mac: { provider: { model: "claude-opus-5-5", effort: "xhigh" } } });
  });

  it("the finished turn's notification for the owner is written", async () => {
    const { id, docId } = seed(["Piece"]);
    replies(answer({ reply: "Done.", edits: [{ op: "replace", id: "b1", text: "Piece, rewritten." }] }));
    const { body } = await send(id, docId, "Rewrite everything.");
    const done = await settled(id, body.reply!.id);

    const inbox = path.join(dataDir, "review", "notifications", "alex.json");
    let items: Array<{ kind: string; text?: string; href: string }> = [];
    for (let i = 0; i < 200 && !items.length; i++) {
      await new Promise((r) => setTimeout(r, 10));
      try {
        items = JSON.parse(readFileSync(inbox, "utf-8"));
      } catch {
        /* not written yet */
      }
    }
    expect(items[0]).toMatchObject({ kind: "workshop", text: "Reply ready: Strength training", href: `/workshop/sessions/${id}` });
  });
});

describe("the reply's words as they arrive", () => {
  it("are pushed to the page while they're written, then the stream ends", async () => {
    const { id, docId } = seed(["A slide"]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const full = answer({ reply: "Hello there, writer.", edits: [] });
    mocked.mockImplementationOnce((async (_s: string, _u: string, _sig: AbortSignal, parse: (t: string) => unknown, hooks: { onDelta?: (t: string) => Promise<void> }) => {
      await hooks.onDelta?.('{"reply":"Hello the');
      await gate;
      await hooks.onDelta?.(full);
      return { result: parse(full), provider: "Claude (Mac)" };
    }) as never);
    const { body } = await send(id, docId, "Say hello.");
    const res = await call("GET", `/api/workshop/sessions/${id}/chat/${body.reply!.id}/live`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    let seen = "";
    const until = async (s: string) => {
      while (!seen.includes(s)) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += new TextDecoder().decode(value);
      }
    };
    await until('"text":"Hello the"');
    expect(seen).not.toContain("writer");
    release();
    await until("event: end");
    expect(seen).toContain('"text":"Hello there, writer."');
    expect(seen).toContain("event: end");
    await settled(id, body.reply!.id);
    // once it's over, there's nothing to stream: 204, and the browser doesn't reconnect
    expect((await call("GET", `/api/workshop/sessions/${id}/chat/${body.reply!.id}/live`)).status).toBe(204);
  });
});

describe("the sidebar's summary", () => {
  it("says a reply is running, then that one is waiting for you, until you've seen it", async () => {
    const { id, docId } = seed(["A slide"]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const full = answer({ reply: "Done.", edits: [] });
    mocked.mockImplementationOnce((async (_s: string, _u: string, _sig: AbortSignal, parse: (t: string) => unknown) => {
      await gate;
      return { result: parse(full), provider: "Claude (Mac)" };
    }) as never);
    const row = async () => ((await (await call("GET", "/api/workshop/sessions/summary")).json()) as Array<{ id: string; working: boolean; ready: boolean; kinds: string[] }>).find((r) => r.id === id)!;
    // a reply from before the account first saw the sidebar is not news
    const old = seed(["Old"], { messages: [{ id: uuid(), role: "assistant", text: "Old reply", status: "done", at: 1 } as Msg] });
    const oldRow = async () => ((await (await call("GET", "/api/workshop/sessions/summary")).json()) as Array<{ id: string; ready: boolean }>).find((r) => r.id === old.id)!;
    expect((await oldRow()).ready).toBe(false);
    const { body } = await send(id, docId, "Go.");
    expect(await row()).toMatchObject({ working: true, ready: false });
    release();
    await settled(id, body.reply!.id);
    expect(await row()).toMatchObject({ working: false, ready: true });
    expect((await call("POST", `/api/workshop/sessions/${id}/seen`, { messageId: body.reply!.id })).status).toBe(200);
    expect(await row()).toMatchObject({ working: false, ready: false });
  });
});

describe("an untitled session", () => {
  it("is named once the AI writes into it, with the author's other names as examples; a typed name stays", async () => {
    const { completeWithFallback } = await import("./ai-complete");
    const named = vi.mocked(completeWithFallback);
    named.mockImplementation((async (_s: string, user: string, _sig: unknown, parse: (t: string) => unknown) => {
      expect(user).toContain("- Strength training");
      return parse('"RiskyPlayForAdults"\n');
    }) as never);
    seed(["Another"]); // a named session of the author's: an example
    const { id, docId } = seed(["Old"], { title: "Untitled session" });
    replies(answer({ reply: "Wrote it.", edits: [{ op: "replace", id: "b1", text: "Let them climb the couch. Risky play teaches them where their limits are, and you are right there when they find them." }] }));
    const { body } = await send(id, docId, "Write it.");
    await settled(id, body.reply!.id);
    let title = "";
    for (let i = 0; i < 100 && title !== "RiskyPlayForAdults"; i++) {
      title = (JSON.parse(readFileSync(path.join(dataDir, "workshop", "sessions", id, "meta.json"), "utf-8")) as { title: string }).title;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(title).toBe("RiskyPlayForAdults");
  });
});

describe("attached library clips the caller can't see", () => {
  it("a turn is refused with a 404 for a clip in someone else's library, and for an external clip with no library of its own", async () => {
    const { libraryDb } = await import("./library/db");
    const d = libraryDb();
    d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_bo', 'bo', 'Bo', 'local', 0)").run();
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('ast-bo-0001', 'lib_bo', 'video', 'Bo roll', 'v-bo-0001', 'bo', 0)").run();
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('v-bo-0001', 'ast-bo-0001', 1, 'k', 1, 'h', 'ready', 'bo', 0)").run();
    const { id, docId } = seed(["Hook for the piece"]);

    const clip = await send(id, docId, "", { library: [{ assetId: "ast-bo-0001", versionId: "v-bo-0001" }] });
    expect(clip.status).toBe(404);
    expect(clip.body.error).toBe("A library clip is gone, or not in your library");

    const external = await send(id, docId, "", { library: [{ refId: "ext_0123456789abcdef" }] });
    expect(external.status).toBe(404);
    expect(external.body.error).toBe("A library clip is gone, or not in your library");
    expect(mocked).not.toHaveBeenCalled(); // refused before any model call
  });
});
