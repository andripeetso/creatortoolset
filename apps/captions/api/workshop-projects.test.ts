import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Two brands in one login: a turn in one project reads none of the other's sessions, skips the
// frameworks it switched off, and records from before projects were kept apart go into the first brand. Model mocked.
const dataDir = mkdtempSync(path.join(tmpdir(), "ws-projects-"));
process.env.DATA_DIR = dataDir;
process.env.ANTHROPIC_API_KEY = "test-key";

vi.mock("./ai-complete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai-complete")>()),
  streamWithFallback: vi.fn(),
  // the knowledge reader: files every source as a two-part book
  completeWithFallback: vi.fn(async (_s: string, _u: string, _c: unknown, parse: (t: string) => unknown) =>
    parse(JSON.stringify({ kind: "book", title: "Offers", about: "A book about pricing offers.", uses: ["how to price a course"], sections: [{ title: "Pricing", from: 1, to: 2, about: "price anchors" }] })),
  ),
}));
vi.mock("./lib/mac-claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/mac-claude")>()),
}));

const { Hono } = await import("hono");
const { workshopApp } = await import("./workshop");
const { streamWithFallback } = await import("./ai-complete");
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
  api: { guests: false, demo: false, model: "claude-opus-5-5", effort: "low" },
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
const uuid = () => `dddddddd-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const ws = (...p: string[]) => path.join(dataDir, "workshop", ...p);

function project(name: string, createdAt: number) {
  const id = uuid();
  mkdirSync(ws("projects"), { recursive: true });
  writeFileSync(ws("projects", `${id}.json`), JSON.stringify({ id, owner: "alex", name, audience: "", voice: "", cta: "", notes: "", createdAt, updatedAt: createdAt }));
  return id;
}

function session(title: string, projectId?: string) {
  const id = uuid();
  const docId = uuid();
  mkdirSync(ws("sessions", id, "docs"), { recursive: true });
  writeFileSync(ws("sessions", id, "meta.json"), JSON.stringify({ id, owner: "alex", title, query: "", sources: [], drafts: [], ...(projectId ? { projectId } : {}), createdAt: 1, updatedAt: 1 }));
  writeFileSync(
    ws("sessions", id, "docs", `${docId}.json`),
    JSON.stringify({ id: docId, sessionId: id, kind: "carousel", title: "Carousel", frameworkIds: [], versions: [], nextBlock: 2, nextVersion: 1, createdAt: 1, updatedAt: 1, blocks: [{ id: "b1", text: `${title} piece`, author: "ai", at: 1 }] }),
  );
  writeFileSync(ws("sessions", id, "chat.json"), JSON.stringify({ messages: [] }));
  return { id, docId };
}

/** One turn on the Mac; returns the folder it was given. */
async function folderOf(id: string, docId: string): Promise<Record<string, string>> {
  let files: Record<string, string> | undefined;
  mocked.mockImplementationOnce((async (_s: string, _u: string, _sig: unknown, parse: (t: string) => unknown, _h: unknown, opts: { mac?: { files?: Record<string, string> } }) => {
    files = opts.mac?.files;
    return { result: parse(JSON.stringify({ reply: "ok" })), provider: "Claude (Mac)" };
  }) as never);
  const r = (await (await call("POST", `/api/workshop/sessions/${id}/chat`, { docId, text: "Go." })).json()) as { reply: { id: string } };
  for (let i = 0; i < 500 && !files; i++) {
    const chat = (await (await call("GET", `/api/workshop/sessions/${id}/chat`)).json()) as Array<{ id: string; status?: string }>;
    if (chat.find((m) => m.id === r.reply.id)?.status !== "thinking") break;
    await new Promise((res) => setTimeout(res, 10));
  }
  expect(files).toBeDefined();
  return files!;
}

describe("projects kept apart", () => {
  const tiny = project("Tiny Acrobatics", 1);
  const old = session("Old crawling reel");
  const crawl = session("Crawling tips", tiny);

  it("old records go into the first brand once a second project exists; a turn reads only its own project", async () => {
    const hh = project("Quiet Garden", 2);
    await call("GET", "/api/workshop/workspace");
    expect(JSON.parse(readFileSync(ws("sessions", old.id, "meta.json"), "utf-8")).projectId).toBe(tiny);

    const air = session("Clean air at home", hh);
    const airFolder = Object.keys(await folderOf(air.id, air.docId)).join("\n");
    expect(airFolder).toContain("clean-air-at-home");
    expect(airFolder).not.toContain("crawling");

    const tinyFolder = Object.keys(await folderOf(crawl.id, crawl.docId)).join("\n");
    expect(tinyFolder).toContain("crawling-tips");
    expect(tinyFolder).toContain("old-crawling-reel");
    expect(tinyFolder).not.toContain("clean-air");
  });

  it("a framework switched off for a project is not in its folder, and stays in the others", async () => {
    const fws = (await (await call("GET", "/api/workshop/frameworks")).json()) as Array<{ id: string; name: string }>;
    const fw = fws[0]!;
    const hh = (await (await call("GET", "/api/workshop/projects")).json() as Array<{ id: string; name: string }>).find((p) => p.name === "Quiet Garden")!;
    expect((await call("PATCH", `/api/workshop/projects/${hh.id}`, { name: "Quiet Garden", off: [fw.id] })).status).toBe(200);

    const air = session("Damp walls", hh.id);
    expect(await folderOf(air.id, air.docId).then((f) => f["frameworks/INDEX.md"])).not.toContain(fw.name);
    expect(await folderOf(crawl.id, crawl.docId).then((f) => f["frameworks/INDEX.md"])).toContain(fw.name);
  });

  it("knowledge: a project's old context files stay its own, a new source reaches every project until one switches it off", async () => {
    const tinyFile = ws("projects", `${tiny}.json`);
    writeFileSync(tinyFile, JSON.stringify({ ...JSON.parse(readFileSync(tinyFile, "utf-8")), knowledge: [{ id: uuid(), name: "offers-facts.md", text: "Offer facts", addedAt: 1 }] }));
    const before = (await (await call("GET", "/api/workshop/sources")).json()) as Array<{ name: string; projectId?: string; status: string }>;
    expect(before.find((x) => x.name === "offers-facts.md")).toMatchObject({ projectId: tiny, status: "new" });
    expect(JSON.parse(readFileSync(tinyFile, "utf-8")).knowledge).toEqual([]);

    const added = (await (await call("POST", "/api/workshop/sources", { name: "offers.txt", text: "line one\nline two\nline three" })).json()) as { id: string };
    let book: { status: string; kind?: string; sections?: unknown[] } | undefined;
    for (let i = 0; i < 100 && book?.status !== "read"; i++) {
      await new Promise((res) => setTimeout(res, 10));
      book = ((await (await call("GET", "/api/workshop/sources")).json()) as Array<{ id: string; status: string }>).find((x) => x.id === added.id);
    }
    expect(book).toMatchObject({ status: "read", kind: "book", sections: [{ title: "Pricing", from: 1, to: 2 }] });

    const hh = (await (await call("GET", "/api/workshop/projects")).json() as Array<{ id: string; name: string; off?: string[] }>).find((p) => p.name === "Quiet Garden")!;
    const air = session("Mould", hh.id);
    const airFolder = await folderOf(air.id, air.docId);
    expect(airFolder["context/offers.txt"]).toContain("line two");
    expect(airFolder["context/INDEX.md"]).toContain("A book about pricing offers.");
    expect(airFolder["context/INDEX.md"]).toContain("L1-L2 Pricing");
    expect(airFolder["context/offers-facts.md"]).toBeUndefined();
    expect((await folderOf(crawl.id, crawl.docId))["context/offers-facts.md"]).toBe("Offer facts");

    await call("PATCH", `/api/workshop/projects/${hh.id}`, { name: "Quiet Garden", off: [...(hh.off ?? []), added.id] });
    expect((await folderOf(air.id, air.docId))["context/offers.txt"]).toBeUndefined();
    expect((await folderOf(crawl.id, crawl.docId))["context/offers.txt"]).toContain("line two");
  });

  it("a scan arrives in batches, is written out by the user's AI, then filed; its pages are gone after", async () => {
    const page = "x".repeat(200);
    const first = (await (await call("POST", "/api/workshop/sources", { name: "scan.pdf", pages: [page, page], more: true })).json()) as { id: string; status: string };
    expect(first.status).toBe("new");
    expect((await call("POST", `/api/workshop/sources/${first.id}/pages`, { pages: [page], more: false })).status).toBe(200);
    let got: { status: string; chars: number } | undefined;
    for (let i = 0; i < 100 && got?.status !== "read"; i++) {
      await new Promise((res) => setTimeout(res, 10));
      got = ((await (await call("GET", "/api/workshop/sources")).json()) as Array<{ id: string; status: string; chars: number }>).find((x) => x.id === first.id);
    }
    expect(got?.status).toBe("read");
    expect(got!.chars).toBeGreaterThan(0);
    expect(existsSync(ws("sources", first.id))).toBe(false);
  });
});

