import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The session menu's routes (pin, shelve, regenerate title, mark unread, duplicate). The model is the only thing mocked.
const dataDir = mkdtempSync(path.join(tmpdir(), "ws-menu-"));
process.env.DATA_DIR = dataDir;
process.env.ANTHROPIC_API_KEY = "test-key";

vi.mock("./ai-complete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai-complete")>()),
  streamWithFallback: vi.fn(),
  completeWithFallback: vi.fn(),
}));
vi.mock("./lib/mac-claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/mac-claude")>()),
}));
vi.mock("./lib/devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/devices")>()),
  isOnline: () => true,
}));

const { Hono } = await import("hono");
const { workshopApp } = await import("./workshop");
const { completeWithFallback } = await import("./ai-complete");
const named = vi.mocked(completeWithFallback);
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

const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "alex", role: "admin", cloud: true, off: [] });
  await next();
});
app.route("/api/workshop", workshopApp as never);
const call = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

let seq = 0;
const uuid = () => `bbbbbbbb-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

/** A session written the way the app keeps it: meta, one carousel with `blocks`, Notes, and the chat `messages`. */
function seed(opts: { title?: string; blocks?: string[]; status?: string; messages?: unknown[]; notes?: string } = {}) {
  const id = uuid();
  const docId = uuid();
  const sdir = path.join(dataDir, "workshop", "sessions", id);
  mkdirSync(path.join(sdir, "docs"), { recursive: true });
  writeFileSync(
    path.join(sdir, "meta.json"),
    JSON.stringify({ id, owner: "alex", title: opts.title ?? "Kids strength", query: "", status: opts.status, sources: [], drafts: [], createdAt: 1, updatedAt: 1 }),
  );
  writeFileSync(
    path.join(sdir, "docs", `${docId}.json`),
    JSON.stringify({
      id: docId,
      sessionId: id,
      kind: "carousel",
      title: "Carousel",
      frameworkIds: [],
      versions: [],
      nextBlock: (opts.blocks?.length ?? 0) + 1,
      nextVersion: 1,
      createdAt: 1,
      updatedAt: 2,
      blocks: (opts.blocks ?? []).map((text, i) => ({ id: `b${i + 1}`, text, author: "ai", at: 1 })),
    }),
  );
  writeFileSync(path.join(sdir, "docs", `${uuid()}.json`), JSON.stringify({ id: uuid(), sessionId: id, kind: "notes", title: "Notes", frameworkIds: [], versions: [], nextBlock: 1, nextVersion: 1, createdAt: 1, updatedAt: 1, blocks: [] }));
  writeFileSync(path.join(sdir, "chat.json"), JSON.stringify({ messages: opts.messages ?? [] }));
  if (opts.notes) writeFileSync(path.join(sdir, "notes.md"), opts.notes);
  return { id, docId };
}

const summaryOf = async (id: string) => {
  const rows = (await (await call("GET", "/api/workshop/sessions/summary")).json()) as Array<Record<string, unknown>>;
  return rows.find((r) => r.id === id)!;
};

beforeEach(() => {
  named.mockReset();
});

describe("pin", () => {
  it("pins and unpins a session; the summary carries it; a non-boolean is refused", async () => {
    const { id } = seed();
    expect((await call("PATCH", `/api/workshop/sessions/${id}`, { pinned: true })).status).toBe(200);
    expect(await summaryOf(id)).toMatchObject({ pinned: true });
    expect((await call("PATCH", `/api/workshop/sessions/${id}`, { pinned: "yes" })).status).toBe(400);
    expect((await call("PATCH", `/api/workshop/sessions/${id}`, { pinned: false })).status).toBe(200);
    expect(await summaryOf(id)).not.toHaveProperty("pinned");
  });
});

describe("shelved", () => {
  it("is an accepted status, and sharing a shelved session leaves it shelved", async () => {
    const { id } = seed({ blocks: ["Some words for the piece"] });
    expect((await call("PATCH", `/api/workshop/sessions/${id}`, { status: "shelved" })).status).toBe(200);
    expect(await summaryOf(id)).toMatchObject({ status: "shelved" });
    const shared = (await (await call("POST", `/api/workshop/sessions/${id}/shares`, { all: true })).json()) as { status: string };
    expect(shared.status).toBe("shelved");
    expect(await summaryOf(id)).toMatchObject({ status: "shelved" });
    expect((await call("PATCH", `/api/workshop/sessions/${id}`, { status: "nope" })).status).toBe(400);
  });
});

describe("regenerate title", () => {
  it("names a session that already has a title, from its main piece, and returns the name", async () => {
    named.mockImplementation((async (_s: string, _u: string, _sig: unknown, parse: (t: string) => unknown) => parse("Shelf names\n")) as never);
    const { id } = seed({ title: "Old name", blocks: ["Let them climb the couch and find their limits with you right there beside them."] });
    const res = await call("POST", `/api/workshop/sessions/${id}/name`);
    expect(await res.json()).toEqual({ title: "Shelf names" });
    const meta = JSON.parse(readFileSync(path.join(dataDir, "workshop", "sessions", id, "meta.json"), "utf-8")) as { title: string };
    expect(meta.title).toBe("Shelf names");
  });

  it("refuses a session with no written piece", async () => {
    const { id } = seed({ blocks: [] });
    expect((await call("POST", `/api/workshop/sessions/${id}/name`)).status).toBe(400);
    expect(named).not.toHaveBeenCalled();
  });
});

describe("mark unread", () => {
  it("brings the Done dot back after the reader has seen the reply, and seen again marks it read", async () => {
    const reply = { id: "reply-menu-0001", role: "assistant", text: "Here.", status: "done", at: Date.now() + 60_000 };
    const { id } = seed({ messages: [reply] });
    expect(await summaryOf(id)).toMatchObject({ ready: true });
    expect((await call("POST", `/api/workshop/sessions/${id}/seen`, { messageId: reply.id })).status).toBe(200);
    expect(await summaryOf(id)).toMatchObject({ ready: false });
    expect((await call("DELETE", `/api/workshop/sessions/${id}/seen`)).status).toBe(200);
    expect(await summaryOf(id)).toMatchObject({ ready: true });
  });
});

describe("no dot for finished stages", () => {
  it("a reply the author hasn't read gives no dot once the session is Ready to post, Published or Shelved", async () => {
    const reply = { id: "reply-quiet-0001", role: "assistant", text: "Done.", status: "done", at: Date.now() + 60_000 };
    for (const status of ["toPost", "published", "shelved"]) {
      const { id } = seed({ status, messages: [reply] });
      expect(await summaryOf(id)).toMatchObject({ ready: false });
    }
    const { id } = seed({ status: "editing", messages: [reply] });
    expect(await summaryOf(id)).toMatchObject({ ready: true });
  });
});

describe("duplicate", () => {
  it("copies the pieces, the notes, the sources and the chat under a new id, not the post it became", async () => {
    const { id } = seed({
      title: "Kids strength",
      blocks: ["First slide text here"],
      notes: "My notes",
      status: "published",
      messages: [{ id: "msg-old-0001", role: "user", text: "hi", status: "done", at: 1 }],
    });
    const res = await call("POST", `/api/workshop/sessions/${id}/duplicate`);
    expect(res.status).toBe(201);
    const copy = (await res.json()) as { id: string; title: string; status: string; notes: string; posted?: unknown; docs?: unknown };
    expect(copy.id).not.toBe(id);
    expect(copy.title).toBe("Kids strength copy");
    expect(copy.status).toBe("writing");
    expect(copy.notes).toBe("My notes");
    expect(copy.posted).toBeUndefined();
    const docs = (await (await call("GET", `/api/workshop/sessions/${copy.id}/docs`)).json()) as Array<{ kind: string; sessionId: string; blocks: Array<{ text: string }> }>;
    const carousel = docs.find((d) => d.kind === "carousel")!;
    expect(carousel.sessionId).toBe(copy.id);
    expect(carousel.blocks.map((b) => b.text)).toEqual(["First slide text here"]);
    const chat = (await (await call("GET", `/api/workshop/sessions/${copy.id}/chat`)).json()) as Array<{ id: string; text: string }>;
    expect(chat.map((m) => m.text)).toEqual(["hi"]);
    expect(await summaryOf(id)).toMatchObject({ status: "published" });
  });
});

describe("exporting", () => {
  it("moves the session to In Production like a share; a published one stays published", async () => {
    const writing = seed({ blocks: ["A slide with words."], status: "writing" });
    const res = await call("GET", `/api/workshop/sessions/${writing.id}/export.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Session-Status")).toBe("production");
    const meta = JSON.parse(readFileSync(path.join(dataDir, "workshop", "sessions", writing.id, "meta.json"), "utf-8")) as { status: string };
    expect(meta.status).toBe("production");
    const published = seed({ blocks: ["Posted words."], status: "published" });
    expect((await call("GET", `/api/workshop/sessions/${published.id}/export.md`)).headers.get("X-Session-Status")).toBe("published");
  });
});

describe("list order", () => {
  it("opening a session (its search box), a status, a pin or a rename leave it where it was; new sources move it up", async () => {
    const { id } = seed();
    const at = async () => (await summaryOf(id)).updatedAt;
    const before = await at();
    for (const body of [{ query: "kids" }, { status: "ready" }, { pinned: true }, { title: "Renamed" }]) {
      expect((await call("PATCH", `/api/workshop/sessions/${id}`, body)).status).toBe(200);
    }
    expect(await at()).toBe(before);
    await call("PATCH", `/api/workshop/sessions/${id}`, { sources: [{ postId: "aaaaaaaa-0000-4000-8000-000000000001", addedAt: 5 }] });
    expect(await at()).toBeGreaterThan(before as number);
  });
});
