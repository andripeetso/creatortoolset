import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "documents-"));
process.env.DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

// the writer is stood in for: it keeps what it was sent and answers a document or a guide's plan
const sent: { system: string; user: string }[] = [];
// held: the writer answers only when its Stop aborts it
let hold = false;
vi.mock("./ai-complete", async (real) => ({
  ...(await real<typeof import("./ai-complete")>()),
  anyAiConfigured: () => true,
  completeWithFallback: async (system: string, user: string, signal: AbortSignal | undefined, parse: (t: string) => unknown) => {
    sent.push({ system, user });
    if (hold) await new Promise((_, no) => signal?.addEventListener("abort", () => no(signal.reason)));
    return parse(system.startsWith("You turn a narrated") ? '{"title":"Open the shop","purpose":"Open it.","steps":[{"title":"Open the shop","instruction":"Press B.","startSec":0,"endSec":1,"atSec":0.5}]}' : "# The shop\n\nPress B.");
  },
}));
const { documentsApp, guidesWork } = await import("./documents");

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "ana", role: "user", cloud: true, off: [] });
  await next();
});
app.route("/api/documents", documentsApp);

// a Video Note of ana's, ready, with its words
const CLIP = "cccccccc-0000-4000-8000-000000000001";
mkdirSync(path.join(dataDir, "clips", CLIP), { recursive: true });
writeFileSync(path.join(dataDir, "clips", CLIP, "meta.json"), JSON.stringify({ id: CLIP, name: "Shop tour", owner: "ana", duration: 2, bytes: 1, mime: "video/mp4", status: "ready", progress: 1, createdAt: 1, updatedAt: 1 }));
writeFileSync(path.join(dataDir, "clips", CLIP, "transcript.json"), JSON.stringify({ words: [{ text: "Press", start: 0, end: 0.4 }, { text: "B.", start: 0.4, end: 1 }] }));

const write = async (kind: "brief" | "guide") => {
  sent.length = 0;
  const r = await app.request("/api/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, prompt: "For new players.", sources: [{ type: "clip", id: CLIP, name: "Shop tour" }] }) });
  expect(r.status).toBe(200);
  expect(sent).toHaveLength(1);
  return sent[0]!.user;
};

describe("a document or a guide written from the person's recordings", () => {
  it("is told the workspace it is written in; in no workspace it reads what it always did", async () => {
    // no workspace: the brief comes first, as before
    expect(await write("brief")).toMatch(/^Author brief:\nFor new players\.\n\nSource 1 /);
    expect(await write("guide")).toMatch(/^Author brief:\nFor new players\.\n\nTitle: Shop tour\n\n/);

    mkdirSync(path.join(dataDir, "workshop", "projects"), { recursive: true });
    const ember = { id: "p-ember", owner: "ana", name: "Ember Realm", audience: "", voice: "", cta: "", notes: "A free online fantasy RPG server.", createdAt: 1, updatedAt: 1 };
    writeFileSync(path.join(dataDir, "workshop", "projects", "p-ember.json"), JSON.stringify(ember));
    const TOLD = "Workspace: Ember Realm\\nInstructions:\\nA free online fantasy RPG server\\.\\n\\nAuthor brief:\\nFor new players\\.\\n\\n";
    expect(await write("brief")).toMatch(new RegExp(`^The workspace this document belongs to\\.[^\\n]*\\n${TOLD}Source 1 `));
    expect(await write("guide")).toMatch(new RegExp(`^The workspace this guide belongs to\\.[^\\n]*\\n${TOLD}Title: Shop tour\\n\\n`));
  });
});

describe("Stop", () => {
  it("ends a guide being written as Stopped and leaves its recording; another account gets 404", async () => {
    hold = true;
    const going = app.request("/api/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "guide", prompt: "", sources: [{ type: "clip", id: CLIP, name: "Shop tour" }] }) });
    await vi.waitFor(() => expect(guidesWork("ana")).toHaveLength(1));
    const { id } = guidesWork("ana")[0]!;
    const bo = new Hono<{ Variables: AuthVars }>();
    bo.use("*", async (c, next) => (c.set("user", { username: "bo", role: "user", cloud: true, off: [] }), next()));
    bo.route("/api/documents", documentsApp);
    expect((await bo.request(`/api/documents/${id}/stop`, { method: "POST" })).status).toBe(404);
    expect(await (await app.request(`/api/documents/${id}/stop`, { method: "POST" })).json()).toEqual({ ok: true });
    expect(await (await going).json()).toMatchObject({ id, status: "error", error: "Stopped" });
    expect(guidesWork("ana")).toEqual([]);
    expect(existsSync(path.join(dataDir, "clips", CLIP, "meta.json"))).toBe(true);
    hold = false;
    // nothing running: still ok
    expect((await app.request(`/api/documents/${id}/stop`, { method: "POST" })).status).toBe(200);
  });
});
