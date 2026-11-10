// A follower's read for a member whose only AI is Codex on their Mac: the reply is named for the CLI that read it.
// The Mac relay is the only thing mocked; the review's own code runs as it does on the server.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "ws-review-codex-"));
process.env.DATA_DIR = dataDir;

const relay = vi.hoisted(() => ({ calls: [] as Array<{ provider?: { driver: string; model: string } }> }));
vi.mock("./lib/mac-claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/mac-claude")>()),
  streamMacClaude: vi.fn(async (_s: string, _u: string, _sig: unknown, _d: unknown, _usage: unknown, opts: { provider?: { driver: string; model: string } }) => {
    relay.calls.push(opts);
    return "A short read.";
  }),
}));
vi.mock("./lib/devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/devices")>()),
  isOnline: () => true,
}));

const { Hono } = await import("hono");
const { workshopApp } = await import("./workshop");
const { createUser } = await import("./users");
const { pairDevice } = await import("./lib/devices");
const { saveSettings } = await import("./lib/providers");
const { DEFAULT_SETTINGS } = await import("../contracts/providers");

createUser("nico", "password1"); // a member: no workspace AI, only their own
const mac = pairDevice("nico", "Nico's Mac").device;
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "codex", driver: "codex", name: "Codex", enabled: true, device: mac.id }], default: { instance: "codex", model: "gpt-6-luna", effort: "high" } }, "nico");

const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "nico", role: "member", cloud: true, off: [] });
  await next();
});
app.route("/api/workshop", workshopApp as never);
const call = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

const SESSION = "bbbbbbbb-0000-4000-8000-000000000001";
const DOC = "bbbbbbbb-0000-4000-8000-000000000002";

beforeAll(() => {
  const sdir = path.join(dataDir, "workshop", "sessions", SESSION);
  mkdirSync(path.join(sdir, "docs"), { recursive: true });
  writeFileSync(path.join(sdir, "meta.json"), JSON.stringify({ id: SESSION, owner: "nico", title: "Lifting", query: "", sources: [], drafts: [], createdAt: 1, updatedAt: 1 }));
  writeFileSync(path.join(sdir, "docs", `${DOC}.json`), JSON.stringify({ id: DOC, sessionId: SESSION, kind: "carousel", title: "Carousel", frameworkIds: [], versions: [], nextBlock: 2, nextVersion: 1, createdAt: 1, updatedAt: 2, blocks: [{ id: "b1", text: "Lift twice a week.", author: "ai", at: 1 }] }));
  writeFileSync(path.join(sdir, "chat.json"), JSON.stringify({ messages: [] }));
});

describe("a follower's read for a Codex-only member", () => {
  it("is named for Codex from the waiting hint on, and runs Codex's own model, never Fable", async () => {
    const r = await call("POST", `/api/workshop/sessions/${SESSION}/reviews`, { docId: DOC });
    expect(r.status).toBe(202);
    const { reply } = (await r.json()) as { reply: { id: string; provider: string } };
    expect(reply.provider).toBe("Codex (Mac)");
    let done: { status?: string; provider?: string } | undefined;
    for (let i = 0; i < 500 && done?.status !== "done" && done?.status !== "error"; i++) {
      done = ((await (await call("GET", `/api/workshop/sessions/${SESSION}/chat`)).json()) as Array<{ id: string; status?: string; provider?: string }>).find((m) => m.id === reply.id);
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(done).toMatchObject({ status: "done", provider: "Codex (Mac)" });
    expect(relay.calls.at(-1)?.provider).toMatchObject({ driver: "codex", model: "gpt-6-luna" });
  });

  it("an approved web search is never sent to Codex, whose sandbox has no network", async () => {
    const before = relay.calls.length;
    const r = await call("POST", `/api/workshop/sessions/${SESSION}/chat`, { docId: DOC, text: "What do studies say about lifting twice a week?", web: "lifting twice a week studies" });
    expect(r.status).toBe(202);
    for (let i = 0; i < 500 && relay.calls.length === before; i++) await new Promise((res) => setTimeout(res, 10));
    expect(relay.calls.length).toBeGreaterThan(before);
    const sent = relay.calls.at(-1) as { provider?: { driver: string }; web?: unknown } | undefined;
    expect(sent?.provider?.driver).toBe("codex");
    expect(sent?.web).toBeFalsy();
  });
});
