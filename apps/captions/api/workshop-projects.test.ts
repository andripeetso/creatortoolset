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

const { Hono } = await import("hono");
const { workshopApp } = await import("./workshop");
const { workspaceScope } = await import("./lib/workshop/workspace");
const { completeWithFallback, streamWithFallback } = await import("./ai-complete");
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

function session(title: string, projectId?: string, owner = "alex") {
  const id = uuid();
  const docId = uuid();
  mkdirSync(ws("sessions", id, "docs"), { recursive: true });
  writeFileSync(ws("sessions", id, "meta.json"), JSON.stringify({ id, owner, title, query: "", sources: [], drafts: [], ...(projectId ? { projectId } : {}), createdAt: 1, updatedAt: 1 }));
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
    type Row = { name: string; projectId?: string; status: string };
    const before = (await (await workspaceScope.run({ id: tiny }, () => call("GET", "/api/workshop/sources"))).json()) as Row[];
    expect(before.find((x) => x.name === "offers-facts.md")).toMatchObject({ projectId: tiny, status: "new" });
    // the Knowledge tab in another workspace does not list it
    const quiet = (await (await call("GET", "/api/workshop/projects")).json() as Array<{ id: string; name: string }>).find((p) => p.name === "Quiet Garden")!;
    const there = (await (await workspaceScope.run({ id: quiet.id }, () => call("GET", "/api/workshop/sources"))).json()) as Row[];
    expect(there.some((x) => x.name === "offers-facts.md")).toBe(false);
    expect(JSON.parse(readFileSync(tinyFile, "utf-8")).knowledge).toEqual([]);

    const added = (await (await call("POST", "/api/workshop/sources", { name: "offers.txt", text: "line one\nline two\nline three", projectId: null })).json()) as { id: string };
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
  it("a dropped folder: Write it for me reads its files whole and files them; saving keeps each as its own source of the project", async () => {
    const files = [
      { name: "kit/README.md", text: "Read the rules first." },
      { name: "kit/rules/copy.md", text: "Say 1x.\nUse the shop's own coin name." },
      { name: "kit/privacy.md", text: "We keep your email." },
    ];
    let asked: { user: string; files?: Record<string, string> } | undefined;
    vi.mocked(completeWithFallback).mockImplementationOnce(async (_system, user, _c, parse, opts) => {
      asked = { user, files: (opts as { mac?: { files?: Record<string, string> } }).mac?.files };
      // the model names a file by the folder it read it in: still that file
      return parse(JSON.stringify({ notes: "Read kit/rules/copy.md before writing anything public.", files: [
        { file: "kit/README.md", keep: true, kind: "notes", about: "Where to start." },
        { file: "material/kit/rules/copy.md", keep: true, kind: "notes", about: "The copy rules." },
        { file: "kit/privacy.md", keep: false, why: "a privacy policy" },
      ] }));
    });
    const res = await call("POST", "/api/workshop/projects/draft-notes", { name: "Tiny", text: "", files });
    expect(res.status).toBe(200);
    const draft = JSON.parse(await res.text()) as { notes: string; files: Array<{ file: string; keep: boolean; about?: string }> };
    expect(draft.notes).toContain("kit/rules/copy.md");
    expect(draft.files.map((f) => [f.file, f.keep])).toEqual([["kit/README.md", true], ["kit/rules/copy.md", true], ["kit/privacy.md", false]]);
    // on the Mac the files go whole, as files
    expect(asked!.files?.["material/kit/rules/copy.md"]).toBe("Say 1x.\nUse the shop's own coin name.");
    expect(asked!.user).toContain("- kit/privacy.md");

    const kept = draft.files.filter((f) => f.keep).map((f) => ({ ...files.find((x) => x.name === f.file)!, about: f.about }));
    const made = (await (await call("POST", "/api/workshop/sources", { name: "kit", files: kept, projectId: tiny })).json()) as Array<Record<string, unknown>>;
    // each file its own source, by its path; filed by the draft: no second read
    expect(made).toMatchObject([
      { name: "kit/README.md", status: "read", projectId: tiny, about: "Where to start." },
      { name: "kit/rules/copy.md", status: "read", projectId: tiny, about: "The copy rules." },
    ]);
    const t = session("Launch", tiny);
    const folder = await folderOf(t.id, t.docId);
    // each kept file at its own path in the writer's folder, as the instructions name it
    expect(folder["context/kit/rules/copy.md"]).toBe("Say 1x.\nUse the shop's own coin name.");
    expect(folder["context/kit/privacy.md"]).toBeUndefined();
    expect(folder["context/kit"]).toBeUndefined();
    expect(folder["context/INDEX.md"]).toMatch(/## context\/kit\/rules\/copy\.md\n.*\nThe copy rules\./);
    // another brand never reads it
    const hh = (await (await call("GET", "/api/workshop/projects")).json() as Array<{ id: string; name: string }>).find((p) => p.name === "Quiet Garden")!;
    const other = session("Elsewhere", hh.id);
    expect((await folderOf(other.id, other.docId))["context/kit/rules/copy.md"]).toBeUndefined();
  });

  it("Write it for me on a saved workspace: its saved context files are read too and never filed again; the box is its instructions so far", async () => {
    expect((await call("PATCH", `/api/workshop/projects/${tiny}`, { notes: "Sold in shops." })).status).toBe(200);
    type Asked = { user: string; files?: Record<string, string> };
    let asked: Asked | undefined;
    const answer = (reply: unknown) =>
      vi.mocked(completeWithFallback).mockImplementationOnce(async (_system, user, _c, parse, opts) => {
        asked = { user, files: (opts as { mac?: { files?: Record<string, string> } }).mac?.files };
        return parse(JSON.stringify(reply));
      });
    // two lines kept in Memory from earlier chats: one for this workspace, one about the person
    mkdirSync(path.join(dataDir, "memory"), { recursive: true });
    writeFileSync(path.join(dataDir, "memory", "alex.json"), JSON.stringify({ facts: [
      { id: "m1", text: "Never show faces.", said: "we never show faces", at: 1, from: "c1", project: tiny },
      { id: "m2", text: "Films on a phone.", at: 2, from: "c1" },
      { id: "m3", text: "Posts at noon.", at: 3, from: "c1", project: "another-workspace" },
    ] }));
    answer({
      notes: "Sold in shops.\nOpens 1 Dec 2026.",
      files: [{ file: "kit/README.md", keep: false }, { file: "launch.md", keep: true, about: "The launch date." }],
      unsure: ["kit/README.md says 1 Dec, launch.md says 2 Dec."],
    });
    const res = await call("POST", "/api/workshop/projects/draft-notes", { name: "Tiny", text: "Sold in shops.", projectId: tiny, files: [{ name: "launch.md", text: "Opens 1 Dec." }] });
    const draft = JSON.parse(await res.text()) as { notes: string; files: unknown[]; unsure: string[] };
    // the saved files go to the AI whole, beside the one given now
    expect(asked!.files?.["material/kit/rules/copy.md"]).toBe("Say 1x.\nUse the shop's own coin name.");
    expect(asked!.files?.["material/launch.md"]).toBe("Opens 1 Dec.");
    expect(asked!.user).toContain("The workspace's instructions as they stand:\nSold in shops.");
    expect(asked!.user).toMatch(/^Today: \d{4}-\d\d-\d\d$/m);
    // the kept lines: this workspace's with the person's own words, the person's own, never another workspace's
    expect(asked!.user).toContain('Kept in Memory for this workspace:\n- Never show faces. ("we never show faces")\n\n');
    expect(asked!.user).toContain("Kept in Memory about the person, in every workspace:\n- Films on a phone.\n\n");
    expect(asked!.user).not.toContain("Posts at noon.");
    const saved = asked!.user.split("filed already")[1]!;
    expect(saved).toContain("- kit/rules/copy.md");
    expect(saved).not.toContain("- launch.md");
    // only the file given now is filed: a saved one the answer names is not
    expect(draft.files).toEqual([{ file: "launch.md", keep: true, about: "The launch date." }]);
    expect(draft.unsure).toEqual(["kit/README.md says 1 Dec, launch.md says 2 Dec."]);

    // an empty box and nothing dropped: the saved files are enough to write from
    answer({ notes: "From the files." });
    expect((await call("POST", "/api/workshop/projects/draft-notes", { name: "Tiny", text: "", projectId: tiny })).status).toBe(200);
    expect(asked!.files?.["material/kit/README.md"]).toBe("Read the rules first.");
    // from a chat: the saved instructions with what was said now, each named as what it is
    answer({ notes: "Sold in shops. Opens 5 Dec." });
    expect((await call("POST", "/api/workshop/projects/draft-notes", { name: "Tiny", text: "Sold in shops.", said: "The launch moved to 5 Dec.", projectId: tiny })).status).toBe(200);
    expect(asked!.user).toContain("The workspace's instructions as they stand:\nSold in shops.\n\nWhat they said about it now:\nThe launch moved to 5 Dec.");
    // a new workspace: the box holds what they wrote, and no other workspace's file is read
    answer({ notes: "A shop." });
    expect((await call("POST", "/api/workshop/projects/draft-notes", { name: "New", text: "A shop." })).status).toBe(200);
    expect(asked!.user).toContain("What they wrote:\nA shop.");
    expect(asked!.files).toBeUndefined();
    expect(asked!.user).not.toContain("Kept in Memory");
    expect((await call("PATCH", `/api/workshop/projects/${tiny}`, { notes: "" })).status).toBe(200);
  });

  it("a folder kept as one source splits into its files; a limit leaves one waiting, no error; the inbox hears when all are read", async () => {
    const id = uuid();
    const text = "# brandkit/a.md\n\nalpha\n\n# brandkit/b.md\n\nbeta";
    writeFileSync(ws("sources", `${id}.json`), JSON.stringify({ id, owner: "alex", name: "brandkit", chars: text.length, status: "failed", error: "API Error: Request rejected (429)", createdAt: 5, updatedAt: 5 }));
    writeFileSync(ws("sources", `${id}.txt`), text);
    const ai = vi.mocked(completeWithFallback);
    ai.mockImplementationOnce(async () => {
      throw new Error("Claude on the Mac: Claude: API Error: Request rejected (429) · rate_limit_error (reset after 2h25m50s)");
    });
    type Row = { id: string; name: string; status: string; waitUntil?: number; error?: string };
    const rows = async () => ((await (await call("GET", "/api/workshop/sources")).json()) as Row[]).filter((x) => x.name.startsWith("brandkit"));
    let got: Row[] = [];
    for (let i = 0; i < 100 && !got.some((x) => x.waitUntil); i++) {
      got = await rows();
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(got.map((x) => x.name)).toEqual(["brandkit/a.md", "brandkit/b.md"]);
    expect(existsSync(ws("sources", `${id}.txt`))).toBe(false);
    const waiting = got.find((x) => x.waitUntil)!;
    expect(waiting).toMatchObject({ status: "queued" });
    expect(waiting.error).toBeUndefined();
    expect(waiting.waitUntil! - Date.now()).toBeGreaterThan(2 * 3600_000);
    // Read again after the reset (here: by hand): both read, one note
    for (const r of got) await call("POST", `/api/workshop/sources/${r.id}/read`);
    for (let i = 0; i < 100 && !got.every((x) => x.status === "read"); i++) {
      await new Promise((res) => setTimeout(res, 10));
      got = await rows();
    }
    expect(got.every((x) => x.status === "read")).toBe(true);
  });
});

describe("the workspace a session is in, carried to what is asked about one piece", () => {
  const ember = project("Ember Realm", 30);
  const file = ws("projects", `${ember}.json`);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf-8")), notes: "A free online fantasy RPG server." }));
  const guide = session("Frost Peak guide", ember);
  const TOLD = /Workspace: Ember Realm\nInstructions:\nA free online fantasy RPG server\./;

  it("rewrite and ask-about are told it", async () => {
    const ai = vi.mocked(completeWithFallback);
    const reader = ai.getMockImplementation()!;
    const sent: string[] = [];
    // only these two calls are answered here; a source still being read in the background keeps its own reader
    ai.mockImplementation((async (system: string, user: string, c: unknown, parse: (t: string) => unknown, opts: unknown) => {
      if (!system.startsWith("The author ")) return reader(system, user, c as never, parse as never, opts as never);
      sent.push(user);
      return parse(system.includes('"options"') ? '{"options":["a","b","c"]}' : "Clear enough.");
    }) as never);
    const text = "Frost Peak guide piece";
    const at = `/api/workshop/sessions/${guide.id}/docs/${guide.docId}`;
    expect((await call("POST", `${at}/lines`, { blockId: "b1", text, start: 0, end: 10 })).status).toBe(200);
    expect((await call("POST", `${at}/ask`, { blockId: "b1", text, question: "Is this clear?" })).status).toBe(200);
    ai.mockImplementation(reader);
    expect(sent).toHaveLength(2);
    for (const prompt of sent) expect(prompt).toMatch(new RegExp(`^The workspace this piece belongs to\\.[^\\n]*\\n${TOLD.source}\\n\\n`));
  });

  it("an admin's turn in someone else's session reads the project owner's context files, never the admin's own", async () => {
    // bea's project and her file; alex, the admin, keeps offers.txt for every project of his own
    const beas = uuid();
    writeFileSync(ws("projects", `${beas}.json`), JSON.stringify({ id: beas, owner: "bea", name: "Bea's Bakery", audience: "", voice: "", cta: "", notes: "", createdAt: 40, updatedAt: 40 }));
    writeFileSync(ws("sources", "s-bread1.json"), JSON.stringify({ id: "s-bread1", owner: "bea", name: "bread.md", chars: 9, status: "new", createdAt: 1, updatedAt: 1 }));
    writeFileSync(ws("sources", "s-bread1.txt"), "Sourdough");
    const hers = session("Morning loaves", beas, "bea");
    const folder = await folderOf(hers.id, hers.docId);
    expect(folder["context/bread.md"]).toBe("Sourdough");
    expect(folder["context/offers.txt"]).toBeUndefined();
  });
});
