// Generate draft (POST /api/workshop/sessions/:id/generate) through the real route, with only the Mac relay stood in:
// the request it sends to the session's AI, the draft it keeps, and its files. Pinned before Compare (a plug-in) took
// the same request, so the hash below is what Generate draft sent on main.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "ws-generate-"));
process.env.DATA_DIR = dataDir;

const relay = vi.hoisted(() => ({ calls: [] as Array<{ system: string; user: string; provider?: { instance: string; driver: string; model: string } }> }));
vi.mock("./lib/mac-claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/mac-claude")>()),
  streamMacClaude: vi.fn(async (system: string, user: string, _sig: unknown, _d: unknown, _usage: unknown, opts: { provider?: { instance: string; driver: string; model: string } }) => {
    relay.calls.push({ system, user, provider: opts.provider });
    return JSON.stringify({ title: "Three reasons to stretch", markdown: "Stretch in the morning.\n\nStretch after lifting." });
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

createUser("nico", "password1");
const mac = pairDevice("nico", "Nico's Mac").device;
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.id }], default: { instance: "claude", model: "opus", effort: "high" } }, "nico");

const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "nico", role: "member", cloud: true, off: [] });
  await next();
});
app.route("/api/workshop", workshopApp as never);
const call = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

const SESSION = "cccccccc-0000-4000-8000-000000000001";
const sdir = path.join(dataDir, "workshop", "sessions", SESSION);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

beforeAll(() => {
  mkdirSync(sdir, { recursive: true });
  writeFileSync(path.join(sdir, "meta.json"), JSON.stringify({ id: SESSION, owner: "nico", title: "Stretching", query: "", sources: [], drafts: [], createdAt: 1, updatedAt: 1 }));
  writeFileSync(path.join(sdir, "notes.md"), "Tiny Acrobatics: keep it short.");
});

describe("Generate draft", () => {
  it("sends the session's AI the request it sent on main and keeps a ready draft with its files", async () => {
    const r = await call("POST", `/api/workshop/sessions/${SESSION}/generate`, { kind: "free", prompt: "Three reasons to stretch" });
    expect(r.status).toBe(202);
    const { draft } = (await r.json()) as { draft: { id: string; status: string } };
    expect(draft.status).toBe("generating");
    let drafts: Array<{ id: string; status: string; title: string; chars: number }> = [];
    for (let i = 0; i < 500 && drafts[0]?.status !== "ready"; i++) {
      drafts = (await (await call("GET", `/api/workshop/sessions/${SESSION}/drafts`)).json()) as typeof drafts;
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ id: draft.id, status: "ready", title: "Three reasons to stretch" });
    expect(relay.calls).toHaveLength(1);
    expect(relay.calls[0]!.provider).toMatchObject({ instance: "claude", driver: "claude", model: "opus" });
    expect(relay.calls[0]!.user).toContain("Three reasons to stretch");
    expect(relay.calls[0]!.user).toContain("Tiny Acrobatics: keep it short.");
    expect({ system: sha(relay.calls[0]!.system), user: sha(relay.calls[0]!.user) }).toEqual(PINNED);
    const md = readFileSync(path.join(sdir, "drafts", `${draft.id}.md`), "utf8");
    expect(md).toContain("Stretch after lifting.");
    expect(drafts[0]!.chars).toBe(md.length);
    expect(JSON.parse(readFileSync(path.join(sdir, "drafts", `${draft.id}.json`), "utf8"))).toMatchObject({ kind: "free", plan: { title: "Three reasons to stretch" } });
  });
});

// read from this test on main 83cae003, before Generate draft's request moved into draftRequest
const PINNED = { system: "f934698a7a418a3ede9bf33be64ac54bcf2f6cedb619ec4d66a7ff43093a7ddd", user: "9d1b2df342a7c208aa126f94e538a0a4128aa1fa1c4623895a0176fe9bb4cbdc" };
