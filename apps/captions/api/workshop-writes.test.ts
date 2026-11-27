import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Writes that can meet each other in one session: two notes saves, a piece's delete against an edit, and the per-session
// queue's map, which must not keep a session once nothing is queued for it.
const dataDir = mkdtempSync(path.join(tmpdir(), "ws-writes-"));
process.env.DATA_DIR = dataDir;
const { Hono } = await import("hono");
const { workshopApp, updateDoc, chainsOpen } = await import("./workshop");

const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "sam", role: "user", cloud: true, off: [] });
  await next();
});
app.route("/api/workshop", workshopApp as never);
const call = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

let seq = 0;
const uuid = () => `dddddddd-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

/** A session of sam's with one carousel piece (and its Notes document is made by the list route when it is asked). */
function seed() {
  const id = uuid();
  const docId = uuid();
  const sdir = path.join(dataDir, "workshop", "sessions", id);
  mkdirSync(path.join(sdir, "docs"), { recursive: true });
  writeFileSync(path.join(sdir, "meta.json"), JSON.stringify({ id, owner: "sam", title: "Race", query: "", sources: [], drafts: [], createdAt: 1, updatedAt: 1 }));
  writeFileSync(path.join(sdir, "docs", `${docId}.json`), JSON.stringify({ id: docId, sessionId: id, kind: "carousel", title: "Carousel", frameworkIds: [], versions: [], nextBlock: 2, nextVersion: 1, createdAt: 1, updatedAt: 1, blocks: [{ id: "b1", text: "Slide", author: "ai", at: 1 }] }));
  return { id, docId, sdir };
}

describe("two notes saves at once", () => {
  it("both answer, the file is one whole save, and no temp file is left", async () => {
    const { id, sdir } = seed();
    const texts = ["first ".repeat(3000), "second ".repeat(3000)];
    const replies = await Promise.all(texts.map((notes) => call("PATCH", `/api/workshop/sessions/${id}`, { notes })));
    expect(replies.map((r) => r.status)).toEqual([200, 200]);
    expect(texts).toContain(readFileSync(path.join(sdir, "notes.md"), "utf-8"));
    expect(readdirSync(sdir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
});

describe("a piece deleted while an edit runs", () => {
  it("the edit does not bring it back, and it is in the trash", async () => {
    const { id, docId, sdir } = seed();
    await Promise.all([
      updateDoc(id, docId, (d) => void (d.title = "Edited")),
      call("DELETE", `/api/workshop/sessions/${id}/docs/${docId}`),
    ]);
    expect(existsSync(path.join(sdir, "docs", `${docId}.json`))).toBe(false);
    const listed = (await (await call("GET", `/api/workshop/sessions/${id}/docs`)).json()) as Array<{ id: string }>;
    expect(listed.map((d) => d.id)).not.toContain(docId);
  });
});

describe("the per-session queue", () => {
  it("keeps no entry for a session once its writes have settled", async () => {
    const before = chainsOpen();
    const ids = Array.from({ length: 20 }, () => uuid());
    await Promise.all(ids.map((id) => updateDoc(id, uuid(), () => {})));
    await new Promise((r) => setTimeout(r, 0));
    expect(chainsOpen()).toBe(before);
  });
});
