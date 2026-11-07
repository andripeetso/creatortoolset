import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Packs in the Workshop: an installed pack's workshop.write instruction reaches the system prompt of a turn, after the
// app's own text. Only the model is mocked; the turn runs on Claude on the account's paired Mac.
const dataDir = mkdtempSync(path.join(tmpdir(), "ws-packs-"));
process.env.DATA_DIR = dataDir;

vi.mock("./ai-complete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai-complete")>()),
  streamWithFallback: vi.fn(),
  completeWithFallback: vi.fn(),
}));
vi.mock("./lib/devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/devices")>()),
  isOnline: () => true,
}));

const { Hono } = await import("hono");
const { workshopApp } = await import("./workshop");
const { installPack } = await import("./lib/packs");
const { streamWithFallback } = await import("./ai-complete");
const mocked = vi.mocked(streamWithFallback);
const { createUser } = await import("./users");
const { pairDevice } = await import("./lib/devices");
const { saveSettings } = await import("./lib/providers");
createUser("tinyacrobatics", "password1", { role: "admin" });
const mac = pairDevice("tinyacrobatics", "Studio Mac").device;
await saveSettings({
  instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.id }],
  default: { instance: "claude", model: "claude-opus-5-5", effort: "xhigh" },
  jobs: {},
  api: { guests: false, demo: false, model: "claude-opus-5-5", effort: "low" },
});

const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "tinyacrobatics", role: "admin", cloud: true, off: [] });
  await next();
});
app.route("/api/workshop", workshopApp as never);
const call = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

let seq = 0;
const uuid = () => `eeeeeeee-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const ws = (...p: string[]) => path.join(dataDir, "workshop", ...p);

function session(title: string) {
  const id = uuid();
  const docId = uuid();
  mkdirSync(ws("sessions", id, "docs"), { recursive: true });
  writeFileSync(ws("sessions", id, "meta.json"), JSON.stringify({ id, owner: "tinyacrobatics", title, query: "", sources: [], drafts: [], createdAt: 1, updatedAt: 1 }));
  writeFileSync(
    ws("sessions", id, "docs", `${docId}.json`),
    JSON.stringify({ id: docId, sessionId: id, kind: "carousel", title: "Carousel", frameworkIds: [], versions: [], nextBlock: 2, nextVersion: 1, createdAt: 1, updatedAt: 1, blocks: [{ id: "b1", text: `${title} piece`, author: "ai", at: 1 }] }),
  );
  writeFileSync(ws("sessions", id, "chat.json"), JSON.stringify({ messages: [] }));
  return { id, docId };
}

/** One turn; returns the system prompt the model was given. */
async function systemOf(id: string, docId: string): Promise<string> {
  const systems: string[] = [];
  mocked.mockImplementation((async (s: string, _u: string, _sig: unknown, parse: (t: string) => unknown) => {
    systems.push(s);
    return { result: parse(JSON.stringify({ reply: "ok" })), provider: "Claude" };
  }) as never);
  const res = await call("POST", `/api/workshop/sessions/${id}/chat`, { docId, text: "Go." });
  const r = (await res.json()) as { reply: { id: string } };
  if (!r.reply) throw new Error(`chat POST ${res.status}: ${JSON.stringify(r)}`);
  // until the reply is saved, not just until the model was called: the next turn on this session would get 409
  for (let i = 0; i < 500; i++) {
    const chat = (await (await call("GET", `/api/workshop/sessions/${id}/chat`)).json()) as Array<{ id: string; status?: string }>;
    if (chat.find((m) => m.id === r.reply.id)?.status !== "thinking") break;
    await new Promise((res) => setTimeout(res, 10));
  }
  expect(systems.length).toBeGreaterThan(0);
  return systems[0]!;
}

describe("packs in the Workshop turn", () => {
  it("an installed pack's workshop.write instruction reaches the turn's system prompt, after the app's own text", async () => {
    const s = session("Hooks");
    const before = await systemOf(s.id, s.docId);
    expect(before).not.toContain("Tiny Acrobatics pack line");

    await installPack("tinyacrobatics", {
      format: 1, id: "tiny-hooks", name: "Tiny Hooks", version: "1.0.0", author: "Tiny Acrobatics", license: "CC-BY-4.0",
      description: "Hook habits.", instructions: { "workshop.write": "Tiny Acrobatics pack line: open on the result." },
    }, 0);

    const after = await systemOf(s.id, s.docId);
    expect(after).toContain("Tiny Acrobatics pack line: open on the result.");
    expect(after.indexOf("How this works:")).toBeLessThan(after.indexOf("Tiny Acrobatics pack line"));
  });
});
