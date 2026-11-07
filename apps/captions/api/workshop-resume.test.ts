import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A Workshop session's Claude session on the Mac: kept after a folder turn, resumed next turn, dropped when it should be. The model is mocked.
const dataDir = mkdtempSync(path.join(tmpdir(), "ws-resume-"));
process.env.DATA_DIR = dataDir;
process.env.ANTHROPIC_API_KEY = "test-key";

vi.mock("./ai-complete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai-complete")>()),
  streamWithFallback: vi.fn(),
}));
// The Mac counts as on, so an admin's turn goes to Claude on the Mac first.
vi.mock("./lib/mac-claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/mac-claude")>()),
}));

const { Hono } = await import("hono");
const { workshopApp } = await import("./workshop");
const { streamWithFallback, AiProviderError } = await import("./ai-complete");
const { MacClaudeError } = await import("./lib/mac-claude");
const mocked = vi.mocked(streamWithFallback);
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

type Opts = { mac?: { session?: { key: string; resume?: string }; onSession?: (s: { id: string; state: "new" | "resumed" | "lost" }) => void } };
const calls: Array<{ user: string; opts: Opts }> = [];

const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "alex", role: "admin", cloud: true, off: [] });
  await next();
});
app.route("/api/workshop", workshopApp as never);
const call = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

let seq = 0;
const uuid = () => `cccccccc-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

/** A session with one carousel, written as the app would keep it. */
function seed(blocks: string[]) {
  const id = uuid();
  const docId = uuid();
  const sdir = path.join(dataDir, "workshop", "sessions", id);
  mkdirSync(path.join(sdir, "docs"), { recursive: true });
  writeFileSync(path.join(sdir, "meta.json"), JSON.stringify({ id, owner: "alex", title: "Kids strength", query: "", sources: [], drafts: [], createdAt: 1, updatedAt: 1 }));
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
    }),
  );
  writeFileSync(path.join(sdir, "docs", `${uuid()}.json`), JSON.stringify({ id: uuid(), sessionId: id, kind: "notes", title: "Notes", frameworkIds: [], versions: [], nextBlock: 1, nextVersion: 1, createdAt: 1, updatedAt: 1, blocks: [] }));
  writeFileSync(path.join(sdir, "chat.json"), JSON.stringify({ messages: [] }));
  return { id, docId };
}

const metaPath = (id: string) => path.join(dataDir, "workshop", "sessions", id, "meta.json");
const metaOf = (id: string) => JSON.parse(readFileSync(metaPath(id), "utf-8")) as { claudeSession?: { id: string; after: string; sources: string[]; context: string } };
/** Edits the stored session the way a later step would find it. */
const editMeta = (id: string, fn: (m: NonNullable<ReturnType<typeof metaOf>["claudeSession"]>) => void) => {
  const m = metaOf(id);
  fn(m.claudeSession!);
  writeFileSync(metaPath(id), JSON.stringify(m));
};

async function send(id: string, docId: string, text: string) {
  const r = await call("POST", `/api/workshop/sessions/${id}/chat`, { docId, text });
  return { status: r.status, body: (await r.json()) as { ask?: { id: string }; reply?: { id: string }; error?: string } };
}

/** Waits for the reply to leave "thinking". */
async function settled(id: string, replyId: string) {
  for (let i = 0; i < 500; i++) {
    const chat = (await (await call("GET", `/api/workshop/sessions/${id}/chat`)).json()) as Array<{ id: string; status?: string; notes?: string[] }>;
    const m = chat.find((x) => x.id === replyId);
    if (m && m.status !== "thinking") return m;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("the turn did not finish");
}

/** The Mac answers with this reply, and says what its Claude session became. */
function macReply(reply: string, state?: "new" | "resumed" | "lost", id = "c-1") {
  mocked.mockImplementationOnce((async (_s: string, user: string, _sig: unknown, parse: (t: string) => unknown, _h: unknown, opts: Opts) => {
    calls.push({ user, opts });
    if (state) opts.mac?.onSession?.({ id, state });
    return { result: parse(JSON.stringify({ reply })), provider: "Claude (Mac)" };
  }) as never);
}

beforeEach(() => {
  mocked.mockReset();
  calls.length = 0;
});

describe("a Workshop session's Claude session on the Mac", () => {
  it("the first folder turn keeps its session; the next one resumes it and carries only what is new", async () => {
    const { id, docId } = seed(["Piece"]);
    macReply("First.", "new", "c-1");
    const first = await send(id, docId, "Make it punchy.");
    const reply1 = await settled(id, first.body.reply!.id);
    expect(reply1.status).toBe("done");
    expect(calls[0]!.opts.mac!.session).toEqual({ key: id, resume: undefined });
    expect(metaOf(id).claudeSession).toMatchObject({ id: "c-1", after: reply1.id, sources: [] });

    macReply("Second.", "resumed", "c-1");
    const second = await send(id, docId, "Shorter, please.");
    expect((await settled(id, second.body.reply!.id)).status).toBe("done");
    const mac = calls[1]!.opts.mac!.session!;
    expect(mac).toMatchObject({ key: id, resume: "c-1" });
    expect(calls[1]!.user).not.toContain("Conversation so far");
    expect(calls[1]!.user).toContain("CHANGED since your last turn: no edits by the author, no new sources.");
    expect(calls[1]!.user).toContain("Author now: Shorter, please.");
  });

  it("when the CLI no longer has the session, the turn runs again as a new session and the reply says so", async () => {
    const { id, docId } = seed(["Piece"]);
    macReply("First.", "new", "c-1");
    const first = await send(id, docId, "Make it punchy.");
    await settled(id, first.body.reply!.id);
    mocked.mockImplementationOnce((async (_s: string, user: string, _sig: unknown, _p: unknown, _h: unknown, opts: Opts) => {
      calls.push({ user, opts });
      throw new MacClaudeError("Claude on the Mac: No conversation found", "gone");
    }) as never);
    macReply("Second.", "new", "c-2");
    const second = await send(id, docId, "Shorter, please.");
    const done = await settled(id, second.body.reply!.id);
    expect(done.status).toBe("done");
    expect(done.notes).toEqual(["Claude's earlier session for this conversation was gone, so this reply read the whole conversation again."]);
    expect(calls[1]!.opts.mac!.session!.resume).toBe("c-1");
    expect(calls[2]!.opts.mac!.session!.resume).toBeUndefined();
    expect(calls[2]!.user).toContain("Conversation so far");
    expect(metaOf(id).claudeSession?.id).toBe("c-2");
  });

  it("a turn the Mac timed out on drops its Claude session, so the next turn starts over", async () => {
    const { id, docId } = seed(["Piece"]);
    macReply("First.", "new", "c-1");
    const first = await send(id, docId, "Make it punchy.");
    await settled(id, first.body.reply!.id);
    mocked.mockImplementationOnce((async () => {
      throw new AiProviderError("Claude took over 20 minutes", "FAILED", true, new MacClaudeError("Claude took over 20 minutes", "timeout"));
    }) as never);
    const second = await send(id, docId, "Shorter, please.");
    const failed = await settled(id, second.body.reply!.id);
    expect(failed.status).toBe("error");
    expect(metaOf(id).claudeSession).toBeUndefined();
  });

  it("a session starts over when the reply before the message is not the one it ended on, or a source it saw is gone", async () => {
    const { id, docId } = seed(["Piece"]);
    macReply("First.", "new", "c-1");
    const first = await send(id, docId, "Make it punchy.");
    await settled(id, first.body.reply!.id);

    editMeta(id, (cs) => (cs.after = "an API reply in between"));
    macReply("Second.", "new", "c-2");
    const second = await send(id, docId, "Shorter, please.");
    await settled(id, second.body.reply!.id);
    expect(calls[1]!.opts.mac!.session!.resume).toBeUndefined();

    editMeta(id, (cs) => (cs.sources = ["a-post-that-was-removed"]));
    macReply("Third.", "new", "c-3");
    const third = await send(id, docId, "Once more.");
    await settled(id, third.body.reply!.id);
    expect(calls[2]!.opts.mac!.session!.resume).toBeUndefined();
  });

  it("picking another AI mid-chat hands over: the new one starts fresh with the conversation, never resumes the old one's session", async () => {
    const { id, docId } = seed(["Piece"]);
    macReply("First.", "new", "c-1");
    const first = await send(id, docId, "Make it punchy.");
    await settled(id, first.body.reply!.id);

    const picked = await call("PATCH", `/api/workshop/sessions/${id}`, { ai: { instance: "claude", model: "claude-sonnet-5-5", effort: "high" } });
    expect(picked.status).toBe(200);
    macReply("Second.", "new", "c-2");
    const second = await send(id, docId, "Shorter, please.");
    await settled(id, second.body.reply!.id);
    expect(calls[1]!.opts.mac!.session!.resume).toBeUndefined();
    expect(calls[1]!.user).toContain("Make it punchy.");
  });
});
