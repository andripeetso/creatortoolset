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

const { sessionCookieFor } = await import("../auth");
const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { hasMembers, mayReceive, mayServe, REFUSED_NONE, REFUSED_PROXIES, REFUSED_PROOF } = await import("./upload-gate");
const { mediaFile, serveGate } = await import("./routes");
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
  // local-first 11-18 decision 6: under none no original reaches the server, a browser or a phone's included
  it("takes a person's original under proxies and all, and refuses it under none (unset reads as none)", () => {
    for (const id of ["lib_p", "lib_all"]) expect(mayReceive("original", { id }, "person")).toEqual({ ok: true });
    for (const id of ["lib_none", "lib_unset"]) {
      expect(mayReceive("original", { id }, "person")).toEqual({ ok: false, status: 409, body: { error: REFUSED_NONE, code: "upload_refused", message: REFUSED_NONE } });
    }
  });

  it("an upload started under all is asked again at each part and at the finish: once the library says none, nothing more is taken", async () => {
    d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_flip', 'tinyacrobatics', 'F', 'local', '{\"upload\":\"all\"}', 0)").run();
    const { id } = (await (await start("lib_flip")).json()) as { id: string };
    d.prepare(`UPDATE libraries SET settings = json_set(settings, '$.upload', 'none') WHERE id = 'lib_flip'`).run();
    const part = await app.request(`/api/library/uploads/${id}`, { method: "PATCH", headers: { "upload-offset": "0", "content-length": "4" }, body: "wxyz" });
    expect(part.status).toBe(409);
    expect(await part.json()).toMatchObject({ code: "upload_refused", message: REFUSED_NONE });
    const fin = await app.request(`/api/library/uploads/${id}/finish`, { method: "POST" });
    expect(fin.status).toBe(409);
  });

  it("a person's browser upload into a none library is refused at its start (a row of the route table, A6)", async () => {
    const r = await start("lib_none");
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "upload_refused", message: REFUSED_NONE });
    expect((await start("lib_all")).status).toBe(201);
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
  it("start: a Mac's own file under none is refused with the line, and so is a browser upload", async () => {
    const r = await start("lib_none", "/Users/tiny/Movies/Handstand.mp4");
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: REFUSED_NONE, code: "upload_refused" });
    expect((await start("lib_none")).status).toBe(409);
    expect((await start("lib_all", "/Users/tiny/Movies/Handstand.mp4")).status).toBe(201);
  });

  it("the iPhone app's own file is taken under none at its start, each part and the finish; a browser's or a Mac's is not, header or no header", async () => {
    const appCookie = sessionCookieFor("tinyacrobatics", true)!;
    const browserCookie = sessionCookieFor("tinyacrobatics", false)!;
    const phone = (lib: string, cookie: string | null, from?: string) =>
      app.request(`/api/library/${lib}/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ct-origin": "phone", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ filename: "IMG 0001.MOV", size: 4, ...(from ? { fromPath: from, fromDevice: "mac-1" } : {}) }),
      });
    const r = await phone("lib_none", appCookie);
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect(d.prepare("SELECT origin FROM uploads WHERE id = ?").get(id)).toEqual({ origin: "phone" });
    expect((await app.request(`/api/library/uploads/${id}`, { method: "PATCH", headers: { "upload-offset": "0", "content-length": "4" }, body: "abcd" })).status).toBe(204);
    expect((await app.request(`/api/library/uploads/${id}/finish`, { method: "POST" })).status).toBe(200);
    // a phone's header on a file a Mac names is that Mac's file: refused under none like any computer's
    expect((await phone("lib_none", appCookie, "/Users/tiny/Movies/Handstand.mp4")).status).toBe(409);
    // no header, the browser: refused under none
    expect((await start("lib_none")).status).toBe(409);
    // a browser (or a member) that sends the phone's header is refused: the header alone is not the phone
    const before = (d.prepare("SELECT COUNT(*) AS n FROM uploads WHERE library_id = 'lib_none' AND origin = 'phone'").get() as { n: number }).n;
    const forged = await phone("lib_none", browserCookie);
    expect(forged.status).toBe(409);
    expect(await forged.json()).toMatchObject({ code: "upload_refused" });
    expect((await phone("lib_none", null)).status).toBe(409);
    expect((d.prepare("SELECT COUNT(*) AS n FROM uploads WHERE library_id = 'lib_none' AND origin = 'phone'").get() as { n: number }).n).toBe(before);
    // the marker is the server's: a cookie with the app's shape and another signature is a browser's
    const forgedMarker = `${browserCookie}.${"0".repeat(64)}`;
    expect((await phone("lib_none", forgedMarker)).status).toBe(409);
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

describe("mayServe under none: a computer takes only the iPhone's own original, until a computer holds it", () => {
  const version = (id: string, origin: string | null) => {
    d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES (?, 'lib_none', 'video', 'V', 'tinyacrobatics', 0)").run(`a_${id}`);
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, origin) VALUES (?, ?, 1, 'k', 4, 'h', 'ready', 'tinyacrobatics', 0, ?)").run(id, `a_${id}`, origin);
    return { id: `a_${id}`, versionId: id };
  };

  it("a phone's held original goes to the owner's computer; any other original is refused, and so is a served one", async () => {
    const phone = version("v_phone_held", "phone");
    const browser = version("v_browser", null);
    expect((await mayServe(phone, "original", { toComputer: true })).ok).toBe(true);
    expect((await mayServe(browser, "original", { toComputer: true })).ok).toBe(false);
    expect((await mayServe(browser, "original")).ok).toBe(false);
    expect((await mayServe(version("v_phone_plain", "phone"), "original")).ok).toBe(false);
    // a computer holds the phone's file: the server stops handing it out
    const held = version("v_phone_got", "phone");
    d.prepare("INSERT INTO version_places (version_id, device, path, confirmed_at, state) VALUES (?, 'mac-1', '/Users/tiny/Movies/IMG 0001.MOV', 0, 'verified')").run(held.versionId);
    expect((await mayServe(held, "original", { toComputer: true })).ok).toBe(false);
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
  "apps/captions/api/review.ts": "PASS: Review uploads are the server's to take under every Upload setting (R2: reviews are served); not gated by mayReceive",
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

describe("A11: nothing streams an original under none (decision 5, R2)", () => {
  // one version per library: uploadFor reads the setting from the version's own library
  const addVersion = (id: string, lib: string) => {
    d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES (?, ?, 'video', 'Srv', 'tinyacrobatics', 0)").run(`a_${id}`, lib);
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, created_by, created_at, state) VALUES (?, ?, 1, 'k', 900, 'x', 'tinyacrobatics', 0, 'ready')").run(id, `a_${id}`);
  };
  it("mayServe: an original only under all; a proxy under proxies and all, and under none only in a team library", async () => {
    addVersion("vs_none", "lib_none");
    addVersion("vs_team", "lib_team");
    addVersion("vs_p", "lib_p");
    addVersion("vs_all", "lib_all");
    const serve = (lib: string, versionId: string, what: "original" | "proxy") => mayServe({ id: lib, versionId }, what);
    expect((await serve("lib_none", "vs_none", "original")).ok).toBe(false);
    expect((await serve("lib_none", "vs_none", "proxy")).ok).toBe(false);
    expect((await serve("lib_team", "vs_team", "proxy")).ok).toBe(true);
    expect((await serve("lib_team", "vs_team", "original")).ok).toBe(false);
    expect((await serve("lib_p", "vs_p", "original")).ok).toBe(false);
    expect((await serve("lib_p", "vs_p", "proxy")).ok).toBe(true);
    expect((await serve("lib_all", "vs_all", "original")).ok).toBe(true);
    // a final in a none library is served: the Finals setting (all when unset)
    addVersion("vs_fin", "lib_none");
    d.prepare("INSERT INTO collection_items (collection_id, asset_id, position, added_by) VALUES ('col_fin', 'a_vs_fin', 0, 'local')").run();
    expect((await serve("lib_none", "vs_fin", "original")).ok).toBe(true);
  });

  // the play route itself needs a registered source policy (canSee); usage.test.ts covers the route end to end
  it("an original held on the server (no computer has it yet) goes to the owner's computer under none, and to no viewer; once a computer holds it, to nobody", async () => {
    const v = { id: "lib_none", versionId: "ver_held" };
    // the phone's own file: the only original a computer may take while no computer holds it
    d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('a_held', 'lib_none', 'video', 'V', 'tinyacrobatics', 0)").run();
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, origin) VALUES ('ver_held', 'a_held', 1, 'k', 4, 'h', 'ready', 'tinyacrobatics', 0, 'phone')").run();
    expect(await mayServe(v, "original")).toMatchObject({ ok: false, status: 409, body: { code: "upload_refused" } });
    expect(await mayServe(v, "original", { toComputer: true })).toEqual({ ok: true });
    expect(await mayServe(v, "proxy", { toComputer: true })).toMatchObject({ ok: false });
    d.prepare("INSERT INTO version_places (version_id, device, path, confirmed_at, state, kind) VALUES ('ver_held', 'mac-held', '/Users/tiny/Movies/held.mov', ?, 'verified', 'original')").run(Date.now());
    expect(await mayServe(v, "original", { toComputer: true })).toMatchObject({ ok: false });
  });

  it("the serve gate: under none the original is refused, pictures pass; On This Mac serves its own", async () => {
    expect(await serveGate("vs_none", "play", { key: "k", what: "original" })).toMatchObject({ ok: false, status: 409, body: { code: "upload_refused", message: REFUSED_NONE } });
    expect(await serveGate("vs_none", "source", { key: "k", what: "original" })).toMatchObject({ ok: false, status: 409 });
    expect((await serveGate("vs_none", "thumb", { key: "thumb-key" })).ok).toBe(true);
    process.env.CT_LOCAL = "1";
    try {
      expect((await mayServe({ id: "lib_none", versionId: "vs_none" }, "original")).ok).toBe(true);
    } finally {
      delete process.env.CT_LOCAL;
    }
  });

  // a proxy whose key is the source's (a proxies library that dropped its original) is the proxy, not the original
  it("a proxy under the source's key is served as the proxy: by its library's setting, not refused as an original", async () => {
    const sharedVersion = (id: string, lib: string) => {
      d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES (?, ?, 'video', 'Shared', 'tinyacrobatics', 0)").run(`a_${id}`, lib);
      d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, created_by, created_at, state) VALUES (?, ?, 1, 'pk', 900, 'x', 'tinyacrobatics', 0, 'ready')").run(id, `a_${id}`);
      d.prepare("INSERT INTO derivatives (version_id, kind, storage_key) VALUES (?, 'proxy', 'pk')").run(id);
    };
    sharedVersion("vs_shared_p", "lib_p");
    sharedVersion("vs_shared_none", "lib_none");
    const play = mediaFile("vs_shared_p", "play");
    expect(play).toMatchObject({ key: "pk", what: "proxy" });
    expect((await serveGate("vs_shared_p", "play", play!)).ok).toBe(true);
    expect((await serveGate("vs_shared_none", "play", mediaFile("vs_shared_none", "play")!)).ok).toBe(false);
    expect((await serveGate("vs_shared_p", "source", { key: "pk", what: "original" })).ok).toBe(false);
  });

  // the prevention test: a route that reads a clip's file from the server must ask mayServe, or be named here with its reason
  it("every file that streams or reads a server copy of a clip asks mayServe, or is named with its reason (PASS, OPEN)", () => {
    const streams = filesMatching("apps/captions/api", /mediaFile\(|serveBlob\(|localCopy\(|blobs\.locate\(/, /\.ts$/);
    expect(streams).toEqual(Object.keys(STREAMS).sort());
    for (const [f, why] of Object.entries(STREAMS)) if (why.startsWith("mayServe")) expect(readFileSync(path.join(repo, f), "utf8"), f).toMatch(/mayServe\(|serveGate\(/);
  });
});

// every file that touches a server copy: mayServe-gated (a viewer's route), PASS (not a viewer's stream: a picture,
// an adapter, a computer's own job, an upload being taken), or OPEN (a server job on a held copy: P3 gates it)
const STREAMS: Record<string, string> = {
  "apps/captions/api/library/routes.ts": "mayServe: GET /media/:versionId/:kind (serveGate); finishDirect hashes an upload just taken; serveBlob is asked by its callers",
  "apps/captions/api/library/shares.ts": "mayServe: a shared link's media route (serveGate)",
  "apps/captions/api/library/bulk.ts": "mayServe: the library's zip of originals (skips any the Upload refuses)",
  "apps/captions/api/library/collections.ts": "mayServe: pieces zip (Save all). PASS: the cover frame and cover picture are pictures",
  "apps/captions/api/editor/media.ts": "mayServe: an export's originals (mediaPaths refuses them, 409)",
  "apps/captions/api/devices.ts": "PASS: a computer's own job reads (its footage copy, its transcript proxy, its copy file), not a viewer",
  "apps/captions/api/work/library-package.ts": "PASS: a computer's own job reads (the light proxy, the original for its proxy), not a viewer",
  "apps/captions/api/review.ts": "PASS: Review's own videos are served under every Upload setting (R2); its uploads are assembled, not served",
  "apps/captions/api/library/pictures.ts": "PASS: a card's picture (a derivative; pictures pass under none)",
  "apps/captions/api/library/attach.ts": "PASS: a thumbnail (a derivative)",
  "apps/captions/api/library/smart.ts": "PASS: a picture the AI reads (pictures pass under none)",
  "apps/captions/api/library/shots.ts": "PASS: kept sheets (derivatives)",
  "apps/captions/api/work/pictures.ts": "PASS: a picture's thumbnail for a computer's work",
  "apps/captions/api/library/db.ts": "PASS: the blob adapter wiring, no route",
  "apps/captions/api/library/storage/types.ts": "PASS: the adapter interface",
  "apps/captions/api/library/storage/local.ts": "PASS: the local adapter",
  "apps/captions/api/library/storage/s3.ts": "PASS: the bucket adapter",
  "apps/captions/api/library/storage/bunny.ts": "PASS: the bunny adapter",
  "apps/captions/api/library/storage/blob-contract.ts": "PASS: the adapter contract test helper",
  "apps/captions/api/library/access.ts": "OPEN P3a: versionSource hands a held copy to Caption Studio's open (search.ts) and its clip cache: server processing",
  "apps/captions/api/library/locate.ts": "OPEN P3: the server's own backfill of a copy it holds (processing, not a viewer's stream)",
  "apps/captions/api/library/worker.ts": "OPEN P3: the server's derivative workers read a held original (processing)",
  "apps/captions/api/library/media/probe.ts": "OPEN P3: the server probes a held file (processing)",
  "apps/captions/api/designs.ts": "OPEN P3: a design's video frame cut on the server (processing)",
  "apps/captions/api/editor/preview.ts": "OPEN P3d: the editor's preview and measure read a held copy on the server (processing)",
};
