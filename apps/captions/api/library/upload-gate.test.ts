import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";
import { filesMatching, repo } from "../lib/scan-source";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "upload-gate-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_DISK_RESERVE_GB = "0";

// written before anything reads it (lib/workspaces.ts caches it). A team: the owner shares the workspace "ws_team" with one member (Settings → Team)
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({
    workspaces: [
      {
        id: "tinyacrobatics",
        name: "Tiny Acrobatics",
        plan: "team",
        createdAt: 0,
        members: [
          { username: "tinyacrobatics", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 },
          { username: "sam", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0, workspaces: ["ws_team"] },
        ],
      },
    ],
    invites: [],
    spend: {},
  }),
);

const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { hasMembers, mayReceive, REFUSED_NONE, REFUSED_PROXIES, REFUSED_PROOF } = await import("./upload-gate");
const { acceptLibraryFile } = await import("../work/library-package");
const { pairDevice, setDeviceWork } = await import("../lib/devices");
const { createUser } = await import("../users");
const { Readable } = await import("node:stream");

createUser("tinyacrobatics", "secret-tiny-acrobatics");
createUser("sam", "secret-sam-acrobatics");

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
d.prepare(
  `INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_team', 'tinyacrobatics', 'L', 'local', '{"upload":"none","projectId":"ws_team"}', 0)`,
).run();

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
    for (const k of ["derivative", "serving"] as const) expect(mayReceive(k, { id: "lib_none" }, "computer").ok).toBe(true);
    // P2: a computer's proxy under none only in a library shared with members (team proxies)
    expect(mayReceive("proxy", { id: "lib_none" }, "computer").ok).toBe(false);
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

const hex = (s: string) => createHash("sha256").update(s).digest("hex");
const proving = { work: { v: 1, steps: [], library: true as const, proof: true as const } };
const older = { work: { v: 1, steps: [], library: true as const } };

describe("P2: proxies and the proxy proof", () => {
  beforeAll(() => void d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.upload', 'proxies') WHERE id = 'lib_p'`).run());

  it("an original from a computer that makes its proxies is refused under proxies; an older computer's is still taken", () => {
    expect(mayReceive("original", { id: "lib_p" }, "computer", { sender: proving })).toEqual({
      ok: false,
      status: 409,
      body: { error: REFUSED_PROXIES, code: "upload_refused", message: REFUSED_PROXIES },
    });
    expect(mayReceive("original", { id: "lib_p" }, "computer", { sender: older }).ok).toBe(true);
    expect(mayReceive("original", { id: "lib_all" }, "computer", { sender: proving }).ok).toBe(true);
  });

  it("a proxy with a matching proof is taken under proxies and all; under none only in a library shared with members", async () => {
    const proof = { sha256: hex("proxy"), got: hex("proxy"), bytes: 5, original: 500 };
    for (const id of ["lib_p", "lib_all"]) expect(mayReceive("proxy", { id }, "computer", { sender: proving, proof }).ok, id).toBe(true);
    expect(await hasMembers("lib_team")).toBe(true);
    expect(await hasMembers("lib_none")).toBe(false);
    expect(mayReceive("proxy", { id: "lib_team" }, "computer", { sender: proving, proof, team: true }).ok).toBe(true);
    expect(mayReceive("proxy", { id: "lib_none" }, "computer", { sender: proving, proof, team: false }).ok).toBe(false);
  });

  it("an original labelled proxy fails the proof: other bytes than declared, or the original's own size", () => {
    const bad = (proof: object) => mayReceive("proxy", { id: "lib_p" }, "computer", { sender: proving, proof });
    expect(bad({ sha256: hex("proxy"), got: hex("original"), bytes: 5, original: 500 })).toMatchObject({ ok: false, body: { message: REFUSED_PROOF } });
    expect(bad({ sha256: hex("original"), got: hex("original"), bytes: 500, original: 500 })).toMatchObject({ ok: false, body: { message: REFUSED_PROOF } });
    expect(bad({ sha256: "not-a-hash" })).toMatchObject({ ok: false });
  });

  it("a computer's proxy job: declared and matching is filed; other bytes are refused and nothing of them stays", async () => {
    const { device } = pairDevice("tinyacrobatics", "Tiny Mac");
    setDeviceWork(device.id, proving.work);
    d.prepare(`INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('a_team', 'lib_team', 'video', 'Handstand', 'tinyacrobatics', 0)`).run();
    d.prepare(
      `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, created_by, created_at, state) VALUES ('v_team', 'a_team', 1, 'mac:v_team', 500, 'mac:x', 'tinyacrobatics', 0, 'ready')`,
    ).run();
    const job = () =>
      Number(d.prepare(`INSERT INTO jobs (library_id, version_id, kind, state, actor, held_by) VALUES ('lib_team', 'v_team', 'proxy', 'running', 'tinyacrobatics', ?) RETURNING id`).get(device.id)!.id);
    let id = job();
    const ok = await acceptLibraryFile(id, device.id, "proxy", Readable.from([Buffer.from("proxy")]), undefined, hex("proxy"));
    expect(ok).toBe(true);
    d.prepare("DELETE FROM jobs WHERE id = ?").run(id);
    id = job();
    const refused = await acceptLibraryFile(id, device.id, "proxy", Readable.from([Buffer.from("other")]), undefined, hex("proxy"));
    expect(refused).toMatchObject({ ok: false, status: 409, body: { message: REFUSED_PROOF } });
    const inc = path.join(dir, "library", "incoming", String(id));
    expect(existsSync(inc) ? readdirSync(inc) : []).toEqual([]);
    // undeclared from a computer that declares: refused before a byte is read
    expect(await acceptLibraryFile(id, device.id, "proxy", Readable.from([Buffer.from("proxy")]))).toMatchObject({ ok: false });
  });

  it("team proxies: a video the computer holds in a library shared with members gets one proxy job, once; a library without members none", async () => {
    const { teamProxies } = await import("./report");
    const { device } = pairDevice("tinyacrobatics", "Tiny Studio");
    d.prepare(`INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('a_t2', 'lib_team', 'video', 'Flip', 'tinyacrobatics', 0), ('a_n2', 'lib_none', 'video', 'Flip', 'tinyacrobatics', 0)`).run();
    for (const [v, a] of [["v_t2", "a_t2"], ["v_n2", "a_n2"]]) {
      d.prepare(`INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, created_by, created_at, state) VALUES (?, ?, 1, ?, 900, 'mac:y', 'tinyacrobatics', 0, 'ready')`).run(v, a, `mac:${v}`);
      d.prepare(`INSERT INTO version_places (version_id, device, kind, folder_id, path, state) VALUES (?, ?, 'original', 'f1', '/Users/tiny/Movies/Flip.mov', 'verified')`).run(v, device.id);
    }
    expect(await teamProxies("lib_team", device)).toBe(1);
    expect(await teamProxies("lib_team", device)).toBe(0);
    expect(await teamProxies("lib_none", device)).toBe(0);
    expect(d.prepare("SELECT kind, state, actor FROM jobs WHERE version_id = 'v_t2'").all()).toEqual([{ kind: "proxy", state: "queued", actor: "tinyacrobatics" }]);
  });

  it("the phone's 720p copy: the finish checks the bytes against the declared SHA-256 and keeps nothing that differs", async () => {
    const probe = { duration: 3, width: 1280, height: 720, fps: 30, rotation: 0, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" };
    const startMade = (sha256: string) =>
      app.request(`/api/library/lib_p/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "Cartwheel.mov", size: 4, quick: hex("q"), proxy: { size: 9000, probe, sha256 } }),
      });
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.upload', 'proxies') WHERE id = 'lib_p'`).run();
    const r = await startMade(hex("abcd"));
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect((await app.request(`/api/library/uploads/${id}`, { method: "PATCH", headers: { "upload-offset": "0", "content-length": "4" }, body: "wxyz" })).status).toBe(204);
    const fin = await app.request(`/api/library/uploads/${id}/finish`, { method: "POST" });
    expect(fin.status).toBe(409);
    expect(await fin.json()).toMatchObject({ code: "upload_refused", message: REFUSED_PROOF });
    const row = d.prepare("SELECT state, staging_path FROM uploads WHERE id = ?").get(id) as { state: string; staging_path: string };
    expect(row.state).toBe("failed");
    expect(existsSync(row.staging_path)).toBe(false);
    // the same, declared right: filed
    const good = (await (await startMade(hex("wxyz"))).json()) as { id: string };
    await app.request(`/api/library/uploads/${good.id}`, { method: "PATCH", headers: { "upload-offset": "0", "content-length": "4" }, body: "wxyz" });
    expect((await app.request(`/api/library/uploads/${good.id}/finish`, { method: "POST" })).status).toBe(200);
  });
});

/**
 * Every route that reads a request body into this server (the D5 table of the local-first plan), by file. P0: gated now,
 * the file calls mayReceive. PASS: not a file's original from a computer, with the reason. OPEN: a named exception and the
 * phase that gates it. A body-reading file missing here fails the test, and so does a row whose file no longer reads one.
 */
const ROUTES: Record<string, string> = {
  "apps/captions/api/library/routes.ts": "P0: startUpload, PATCH /uploads/:id and finish call mayReceive",
  "apps/captions/api/library/derived.ts": "P2: the send branch reads the gate's setting (uploadFor); a phone's made proxy (parseMade) carries its SHA-256, checked by mayReceive in routes.ts",
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
  "apps/captions/api/work/library-package.ts": "P2: acceptLibraryFile asks mayReceive (an original under all; a proxy with its proof); /hear is P3f",
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

  it("a row marked P0 or P2 asks the gate", () => {
    for (const [f, why] of Object.entries(ROUTES)) if (/^P[02]/.test(why)) expect(readFileSync(path.join(repo, f), "utf8"), f).toMatch(/mayReceive\(|uploadFor\(/);
  });
});
