import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";
import { filesMatching, repo } from "../lib/scan-source";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "upload-gate-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_DISK_RESERVE_GB = "0";

const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { mayReceive, REFUSED_NONE } = await import("./upload-gate");

afterAll(() => {
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  delete process.env.CT_LOCAL;
  rmSync(dir, { recursive: true, force: true });
});

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: "tinyacrobatics", role: "user" } as never);
  return next();
});
app.route("/api/library", libraryApp);

const d = libraryDb();
for (const [id, upload] of [["lib_none", '"none"'], ["lib_unset", "null"], ["lib_p", '"proxies"'], ["lib_all", '"all"']] as const) {
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'tinyacrobatics', 'L', 'local', ?, 0)").run(
    id,
    `{"upload":${upload},"proxy":false,"describe":false,"embed":false}`,
  );
}
d.prepare("INSERT INTO collections (id, library_id, name, kind, created_at) VALUES ('col_fin', 'lib_none', 'Finals', 'manual', 0)").run();

const start = (lib: string, from?: string) =>
  app.request(`/api/library/${lib}/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename: "Handstand.mp4", size: 4, ...(from ? { fromPath: from, fromDevice: "mac-1" } : {}) }),
  });

describe("mayReceive: original bytes only where somebody chose to send them", () => {
  it("takes a person's upload under every setting", () => {
    for (const id of ["lib_none", "lib_unset", "lib_p", "lib_all"]) expect(mayReceive("original", { id }, "person")).toEqual({ ok: true });
  });

  it("refuses a computer's own original under none (unset reads as none), takes it under proxies and all", () => {
    for (const id of ["lib_none", "lib_unset"]) {
      expect(mayReceive("original", { id }, "computer")).toEqual({ ok: false, status: 409, body: { error: REFUSED_NONE, code: "upload_refused", message: REFUSED_NONE } });
    }
    expect(mayReceive("original", { id: "lib_p" }, "computer").ok).toBe(true);
    expect(mayReceive("original", { id: "lib_all" }, "computer").ok).toBe(true);
  });

  it("a final follows the Finals setting (all when unset); derivatives and served bytes always pass; This Mac takes its own", () => {
    expect(mayReceive("original", { id: "lib_none", collectionId: "col_fin" }, "computer").ok).toBe(true);
    for (const k of ["proxy", "derivative", "serving"] as const) expect(mayReceive(k, { id: "lib_none" }, "computer").ok).toBe(true);
    process.env.CT_LOCAL = "1";
    try {
      expect(mayReceive("original", { id: "lib_none" }, "computer").ok).toBe(true);
    } finally {
      delete process.env.CT_LOCAL;
    }
  });
});

describe("the library upload routes ask it", () => {
  it("start: a Mac's own file under none is refused with the line; a browser upload is taken", async () => {
    const r = await start("lib_none", "/Users/tiny/Movies/Handstand.mp4");
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: REFUSED_NONE, code: "upload_refused" });
    expect((await start("lib_none")).status).toBe(201);
    expect((await start("lib_all", "/Users/tiny/Movies/Handstand.mp4")).status).toBe(201);
  });

  it("a part and the finish ask again: switched to none mid-upload, they are refused and what arrived stays", async () => {
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.upload', 'all') WHERE id = 'lib_p'`).run();
    const { id } = (await (await start("lib_p", "/Users/tiny/Movies/Handstand.mp4")).json()) as { id: string };
    const part = (body: string, offset: number) =>
      app.request(`/api/library/uploads/${id}`, { method: "PATCH", headers: { "upload-offset": String(offset), "content-length": String(body.length) }, body });
    expect((await part("ab", 0)).status).toBe(204);
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.upload', 'none') WHERE id = 'lib_p'`).run();
    expect((await part("cd", 2)).status).toBe(409);
    expect((await app.request(`/api/library/uploads/${id}/finish`, { method: "POST" })).status).toBe(409);
    expect((d.prepare("SELECT state, received FROM uploads WHERE id = ?").get(id) as { state: string; received: number })).toEqual({ state: "open", received: 2 });
  });
});

/**
 * Every route that reads a request body into this server (the D5 table of the local-first plan), by file. P0: gated now,
 * the file calls mayReceive. PASS: not a file's original from a computer, with the reason. OPEN: a named exception and the
 * phase that gates it. A body-reading file missing here fails the test, and so does a row whose file no longer reads one.
 */
const ROUTES: Record<string, string> = {
  "apps/captions/api/library/routes.ts": "P0: startUpload, PATCH /uploads/:id and finish call mayReceive",
  "apps/captions/api/library/derived.ts": "P2: the send branch (sendLater, runs only under proxies or all) and a phone's made proxy (parseMade) get the proxy proof",
  "apps/captions/api/lib/uploads.ts": "PASS: the helpers (appendBody, writeBody, receivePart); gated by their callers",
  "apps/captions/api/lib/incoming.ts": "PASS: requestBodyStream, a helper; gated by its callers",
  "apps/captions/api/review.ts": "PASS: a person's own upload into a review (decision 1); Review is serving (decision 5)",
  "apps/captions/api/projects.ts": "P3a: POST /, POST /:id/clips and every /:id/clips/:clipId/original route call mayReceive (takesOriginal): a person's upload is taken, a computer's own file (?fromPath=) by the clip's library, none off This Mac without one",
  "apps/captions/api/clips.ts": "OPEN P3d: Video Notes recordings stay on the recorder's computer (decision 19)",
  "apps/captions/api/transcribe.ts": "OPEN P3f: speech for transcription",
  "apps/captions/api/lib/device-transcribe.ts": "OPEN P3f: the server speech model",
  "apps/captions/api/lib/device-embed.ts": "OPEN P3f: the server's search-by-meaning model",
  "apps/captions/api/assistant-files.ts": "OPEN decision 16: the chat dock sends on Send only; the upload link is reviewed in P2",
  "apps/captions/api/devices.ts": "OPEN P3d-P3e: relay job outputs (cards, cutouts)",
  "apps/captions/api/enhance.ts": "OPEN P3d: enhancement runs on the computer",
  "apps/captions/api/work/library-package.ts": "PASS: acceptLibraryFile takes an original only under upload all; /hear is P3f",
  "apps/captions/api/work/library.ts": "PASS: reads the server's own held copy, not a client upload",
  "apps/captions/api/work/result.ts": "OPEN P3b-P3f: work results (serving allowed; processing output text only after P3)",
  "apps/captions/api/work/tasks.ts": "PASS: a computer task's made files for a task it holds (processing output), never a person's original",
  "apps/captions/api/work/routes.ts": "OPEN P3b-P3f: work results (acceptUpload)",
  "apps/captions/api/workshop.ts": "PASS: deliveries and knowledge files are serving and text",
  "apps/captions/api/documents.ts": "PASS: JSON text",
  "apps/captions/api/sign-in.ts": "PASS: forms",
  "apps/captions/api/oauth.ts": "PASS: forms",
  "apps/captions/api/hfproxy.ts": "PASS: a model file downloaded to disk, not media",
  "apps/captions/api/lib/instagram/download.ts": "PASS: the person's own posts from Instagram, not a client upload",
  "apps/captions/api/library/storage/bunny.ts": "PASS: the server's own stored blob",
  "apps/captions/api/library/storage/cache.ts": "PASS: the server's own stored blob",
  "apps/captions/api/media-store.ts": "PASS: the server's own stored blob",
  "apps/captions/api/editor/animation-styles.ts": "PASS: a picture a person gives a style, not footage",
};

const BODY = /parseBody|req\.arrayBuffer|req\.raw\.body|Readable\.fromWeb|pipeline\(|writeBody\(|appendBody\(|receivePart\(|uploadFile\(|startUpload|uploadInit|sendLater|parseMade|acceptLibraryFile|acceptUpload/;
describe("the route table", () => {
  it("every file that reads a request body has its row, and every row still reads one", () => {
    const hits = [...filesMatching("apps/captions/api", BODY, /\.ts$/), ...filesMatching("apps/ios", BODY, /\.swift$/)];
    expect(hits).toEqual(Object.keys(ROUTES).sort());
  });

  it("a row marked P0 calls mayReceive", () => {
    for (const [f, why] of Object.entries(ROUTES)) if (why.startsWith("P0")) expect(readFileSync(path.join(repo, f), "utf8"), f).toContain("mayReceive(");
  });
});
