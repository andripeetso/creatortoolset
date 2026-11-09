import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// the Obsidian link: the plugin's note sync (PUT/GET /notes) and the account's custom exports (lib/workshop/notes.ts)
const dataDir = mkdtempSync(path.join(tmpdir(), "ws-notes-"));
process.env.DATA_DIR = dataDir;
const { Hono } = await import("hono");
const { workshopApp } = await import("./workshop");
const { OBSIDIAN_TEMPLATE } = await import("../src/lib/workshop-markdown");
const { installTestPlugin } = await import("./lib/workshop/export-test-plugin");

// the vault's status values and format come from a plug-in (the public default is generic)
beforeAll(() => installTestPlugin());

const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  const username = c.req.header("x-user") ?? "sam";
  c.set("user", { username, role: "user", cloud: true, off: [] });
  await next();
});
app.route("/api/workshop", workshopApp as never);

const call = async (method: string, url: string, body?: unknown, user = "sam") =>
  app.request(url, {
    method,
    headers: { "Content-Type": "application/json", "x-user": user },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const json = async <T>(r: Response) => (await r.json()) as T;

type Linked = { id: string | null; status?: string; statusAt?: number | null; url: string | null };
type Session = { id: string; title: string; status: string; statusAt?: number; note?: { path: string; mtime: number } };
type Doc = { kind: string; blocks: Array<{ text: string }>; hooks?: Array<{ text: string }>; caption?: unknown };

const put = (body: Record<string, unknown>, user?: string) => call("PUT", "/api/workshop/notes", body, user).then((r) => json<Linked>(r));
const getSession = (id: string, user?: string) => call("GET", `/api/workshop/sessions/${id}`, undefined, user).then((r) => json<Session>(r));
const docsOf = (id: string) => call("GET", `/api/workshop/sessions/${id}/docs`).then((r) => json<Doc[]>(r));
const pieceOf = async (id: string, kind: string) => (await docsOf(id)).find((d) => d.kind === kind)!;

const T0 = Date.now();
const reelNote = (script: string, hooks: string[] = []) =>
  `---\nchange: 2026-11-06\ndetails:\nselector.Status: 👍 Ready\nselector.Media: 🎞️ Reel\n---\n${hooks.map((h) => `// ${h}`).join("\n")}${hooks.length ? "\n\n" : ""}${script}\n`;

describe("Obsidian note sync", () => {
  it("creates a session for a synced status or on send, and nothing else", async () => {
    const published = await put({ path: "Scripts/Old.md", title: "Old", status: "✅ Published", mtime: T0, markdown: reelNote("Old script"), media: "🎞️ Reel" });
    expect(published.id).toBeNull();
    expect((await json<Array<{ path: string }>>(await call("GET", "/api/workshop/notes?since=0"))).map((s) => s.path)).toEqual([]);

    const sent = await put({ path: "Scripts/Old.md", title: "Old", status: "✅ Published", mtime: T0, markdown: reelNote("Old script"), media: "🎞️ Reel", create: "send" });
    expect(sent.id).toBeTruthy();
    expect(sent.status).toBe("published");
    expect(sent.url).toBe(`/workshop/sessions/${sent.id}`);

    const ready = await put({ path: "Scripts/B.md", title: "B", status: "👍 Ready", mtime: T0, markdown: reelNote("Body"), media: "🎞️ Reel" });
    expect(ready.status).toBe("ready");
  });

  it("makes the note's body the first piece: reel with hook lines, carousel by slides, else free", async () => {
    const reel = await put({ path: "Scripts/Hooked.md", title: "Hooked", status: "🎥 Filming", mtime: T0, markdown: reelNote("Para one\n\nPara two", ["First hook", "Second hook"]), media: "🎞️ Reel" });
    const r = await docsOf(reel.id!);
    const piece = r.find((d) => d.kind === "reel")!;
    expect(piece.hooks?.map((h) => h.text)).toEqual(["First hook", "Second hook"]);
    expect(piece.blocks.map((b) => b.text)).toEqual(["Para one\n\nPara two"]);
    expect(r.some((d) => d.kind === "notes")).toBe(true);

    const carousel = await put({ path: "Scripts/Slides.md", title: "Slides", status: "👍 Ready", mtime: T0, markdown: "---\ndetails: CAROUSEL\n---\nSlide one\n\n---\n\nSlide two", media: "🎪 Carousel" });
    expect((await pieceOf(carousel.id!, "carousel")).blocks.map((b) => b.text)).toEqual(["Slide one", "Slide two"]);

    const free = await put({ path: "Scripts/Plain.md", title: "Plain", status: "👍 Ready", mtime: T0, markdown: "One paragraph\n\nAnother", media: "" });
    expect((await pieceOf(free.id!, "free")).blocks.map((b) => b.text)).toEqual(["One paragraph", "Another"]);
  });

  it("syncs status by time both ways and never overwrites the Workshop's text", async () => {
    const made = (await put({ path: "Scripts/Sync.md", title: "Sync", status: "👍 Ready", mtime: T0, markdown: reelNote("Written in the Workshop"), media: "🎞️ Reel" })).id!;
    const statusAt0 = (await getSession(made)).statusAt!;

    // an older note does not move the session
    await put({ path: "Scripts/Sync.md", status: "🎥 Filming", mtime: statusAt0 - 5000, markdown: "older", media: "🎞️ Reel" });
    expect((await getSession(made)).status).toBe("ready");

    // the Workshop changes it: the plugin is handed the new status
    await call("PATCH", `/api/workshop/sessions/${made}`, { status: "editing" });
    const workshopAt = (await getSession(made)).statusAt!;
    expect(workshopAt).toBeGreaterThanOrEqual(statusAt0);
    const handed = await json<Array<{ id: string; path: string; status: string; statusAt: number }>>(await call("GET", `/api/workshop/notes?since=${statusAt0 - 1}`));
    expect(handed.find((h) => h.id === made)).toEqual({ id: made, path: "Scripts/Sync.md", status: "✂️ Editing", statusAt: workshopAt });

    // a note edited before that change loses; one edited after it wins, and the text stays the Workshop's
    await put({ path: "Scripts/Sync.md", title: "Renamed", status: "🎥 Filming", mtime: workshopAt - 1000, markdown: "stale", media: "🎞️ Reel" });
    expect((await getSession(made)).status).toBe("editing");
    const after = await put({ path: "Scripts/Sync.md", title: "Renamed", status: "📤 Ready to post", mtime: workshopAt + 1000, markdown: "changed in Obsidian", media: "🎞️ Reel" });
    expect(after.status).toBe("toPost");
    const session = await getSession(made);
    expect(session.status).toBe("toPost");
    expect(session.title).toBe("Sync");
    expect((await pieceOf(made, "reel")).blocks.map((b) => b.text)).toEqual(["Written in the Workshop"]);

    // since= lists only what changed after it
    const later = await json<unknown[]>(await call("GET", `/api/workshop/notes?since=${workshopAt + 1000}`));
    expect(later).toEqual([]);
  });

  it("links a session the Workshop already has by its name instead of making a second one", async () => {
    const made = await json<{ id: string }>(await call("POST", "/api/workshop/sessions", { title: "Tiny Paper Boats" }));
    const linked = await put({ path: "Scripts/TinyPaperBoats.md", title: "TinyPaperBoats", status: "🎥 Filming", mtime: Date.now() + 1000, markdown: reelNote("Boats"), media: "🎞️ Reel" });
    expect(linked.id).toBe(made.id);
    expect((await getSession(made.id)).note?.path).toBe("Scripts/TinyPaperBoats.md");
    expect((await put({ path: "Scripts/TinyPaperBoats.md", title: "TinyPaperBoats", status: "🎥 Filming", mtime: Date.now() + 2000, markdown: reelNote("Boats") })).id).toBe(made.id);
  });

  it("keeps each account's notes to itself", async () => {
    const mine = (await put({ path: "Scripts/Private.md", title: "Private", status: "🎥 Filming", mtime: T0, markdown: reelNote("Mine"), media: "🎞️ Reel" })).id!;
    // another account's note at the same path is its own session; mine is not touched
    const theirs = await put({ path: "Scripts/Private.md", title: "Theirs", status: "📁 Shelved", mtime: T0 + 99999, markdown: "x", media: "🎞️ Reel", create: "send" }, "riley");
    expect(theirs.id).toBeTruthy();
    expect(theirs.id).not.toBe(mine);
    expect((await getSession(mine)).status).toBe("production");
    expect((await json<unknown[]>(await call("GET", "/api/workshop/notes?since=0", undefined, "riley"))).length).toBe(1);
    expect((await call("GET", `/api/workshop/sessions/${mine}`, undefined, "riley")).status).toBe(404);
    expect((await call("POST", `/api/workshop/sessions/${mine}/export/obsidian`, undefined, "riley")).status).toBe(404);
  });

  it("refuses a note without a path or mtime", async () => {
    expect((await call("PUT", "/api/workshop/notes", { status: "👍 Ready", mtime: 1 })).status).toBe(400);
    expect((await call("PUT", "/api/workshop/notes", { path: "x.md", status: "👍 Ready" })).status).toBe(400);
  });
});

describe("Custom exports", () => {
  it("keeps the built-in first, stores the account's own, and checks them", async () => {
    const start = await json<Array<{ id: string; target: string }>>(await call("GET", "/api/workshop/exports"));
    expect(start.map((e) => e.id)).toEqual(["obsidian"]);

    const saved = await json<Array<{ id: string; name: string; target: string; folder: string; template: string }>>(
      await call("PUT", "/api/workshop/exports", [
        { id: "obsidian", name: "ignored", target: "download" },
        { name: "Vault", target: "plugin", folder: "/Tiny Acrobatics/Scripts/", filename: "{{title}}.md", template: "" },
        { name: "Plain", target: "download", folder: "", filename: "{{title}}.md", template: "{{body}}" },
      ]),
    );
    expect(saved.map((e) => e.name)).toEqual(["Obsidian Markdown", "Vault", "Plain"]);
    expect(saved[1]!.folder).toBe("Tiny Acrobatics/Scripts");
    expect(saved[1]!.template).toBe(OBSIDIAN_TEMPLATE);
    expect(await json<unknown[]>(await call("GET", "/api/workshop/exports"))).toHaveLength(3);
    expect(await json<unknown[]>(await call("GET", "/api/workshop/exports", undefined, "riley"))).toHaveLength(1);

    expect((await call("PUT", "/api/workshop/exports", [{ name: "Up", target: "plugin", folder: "../outside" }])).status).toBe(400);
    expect((await call("PUT", "/api/workshop/exports", [{ name: "Mail", target: "email" }])).status).toBe(400);
    expect((await call("PUT", "/api/workshop/exports", [{ name: "Nested", target: "plugin", filename: "a/b.md" }])).status).toBe(400);
    expect((await call("PUT", "/api/workshop/exports", [{ name: "", target: "plugin" }])).status).toBe(400);
  });

  it("queues a plugin export, links the session to its note, and drops it when the plugin says done", async () => {
    const id = (await put({ path: "Scripts/Queued.md", title: "Queued", status: "👍 Ready", mtime: T0, markdown: reelNote("Queued script"), media: "🎞️ Reel" })).id!;
    const vault = (await json<Array<{ id: string; target: string }>>(await call("GET", "/api/workshop/exports"))).find((e) => e.target === "plugin")!;

    const queued = await call("POST", `/api/workshop/sessions/${id}/export/${vault.id}?day=2026-11-06`, undefined);
    expect(queued.status).toBe(200);
    expect(await json<{ queued: number; path: string }>(queued)).toEqual({ queued: 1, path: "Tiny Acrobatics/Scripts/Queued.md" });
    expect((await getSession(id)).note?.path).toBe("Tiny Acrobatics/Scripts/Queued.md");

    const pending = await json<Array<{ id: string; exportId: string; path: string; markdown: string; sessionId: string }>>(await call("GET", "/api/workshop/exports/pending"));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.sessionId).toBe(id);
    expect(pending[0]!.markdown).toContain("change: 2026-11-06");
    expect(pending[0]!.markdown).toContain("selector.Media: 🎞️ Reel");
    expect(pending[0]!.markdown).toContain("Queued script");

    expect((await call("GET", "/api/workshop/exports/pending", undefined, "riley")).status).toBe(200);
    expect(await json<unknown[]>(await call("GET", "/api/workshop/exports/pending", undefined, "riley"))).toEqual([]);
    expect((await call("POST", `/api/workshop/exports/pending/${pending[0]!.id}/done`, undefined, "riley")).status).toBe(404);
    expect((await call("POST", `/api/workshop/exports/pending/${pending[0]!.id}/done`)).status).toBe(200);
    expect(await json<unknown[]>(await call("GET", "/api/workshop/exports/pending"))).toEqual([]);
    expect((await call("POST", `/api/workshop/exports/pending/${pending[0]!.id}/done`)).status).toBe(404);
  });

  it("downloads a custom export with its template, and refuses a session with no words", async () => {
    const plain = (await json<Array<{ id: string; name: string }>>(await call("GET", "/api/workshop/exports"))).find((e) => e.name === "Plain")!;
    const id = (await put({ path: "Scripts/Dl.md", title: "Dl", status: "👍 Ready", mtime: T0, markdown: reelNote("Downloaded words"), media: "🎞️ Reel" })).id!;
    const file = await call("POST", `/api/workshop/sessions/${id}/export/${plain.id}`, undefined);
    expect(file.headers.get("Content-Disposition")).toContain("Dl.md");
    expect(await file.text()).toBe("Downloaded words\n");

    const empty = (await put({ path: "Scripts/Empty.md", title: "Empty", status: "👍 Ready", mtime: T0, markdown: "", media: "🎞️ Reel" })).id!;
    expect((await call("POST", `/api/workshop/sessions/${empty}/export/${plain.id}`, undefined)).status).toBe(400);
    expect((await call("POST", `/api/workshop/sessions/${id}/export/nope`, undefined)).status).toBe(404);
  });
});
