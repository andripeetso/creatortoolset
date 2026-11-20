import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
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
const { callerOf } = await import("../auth-clients");
const { createGrant, issueSession } = await import("../lib/clients");
const { oauthTokenApp } = await import("../auth-clients");
const { jwkThumbprint, tokenHash } = await import("../lib/dpop");

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
  // a client session's token, read as the account gate in boot.ts reads it
  const k = callerOf(c);
  if (k.kind === "error") return c.json({ code: k.code }, 401);
  if (k.kind === "token") c.set("clientSession", k.row.id);
  return next();
});
app.route("/api/library", libraryApp);
app.route("/", oauthTokenApp);

const d = libraryDb();
for (const [id, upload] of [["lib_none", '"none"'], ["lib_unset", "null"], ["lib_p", '"proxies"'], ["lib_orig", '"originals"'], ["lib_all", '"all"']] as const) {
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
  // replaced (UNIFIED-PRD §4.2, Media Library CEO 11-18): a person's own original is taken under proxies too
  it("takes a person's original under originals, all and proxies, refuses it under none (unset reads as none)", () => {
    for (const id of ["lib_orig", "lib_all", "lib_p"]) expect(mayReceive("original", { id }, "person")).toEqual({ ok: true });
    for (const id of ["lib_none", "lib_unset"]) {
      expect(mayReceive("original", { id }, "person")).toEqual({ ok: false, status: 409, body: { error: REFUSED_NONE, code: "upload_refused", message: REFUSED_NONE } });
    }
  });

  it("the refusal under none says exactly what to do (Amendment c)", () => {
    expect(REFUSED_NONE).toBe("Upload is off for this workspace. Add footage in the Mac app, or turn on Originals in Settings → Media Library.");
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

  it("refuses a computer's own original under none (unset reads as none) and under proxies, takes it under originals and all", () => {
    for (const id of ["lib_none", "lib_unset"]) {
      expect(mayReceive("original", { id }, "computer")).toEqual({ ok: false, status: 409, body: { error: REFUSED_NONE, code: "upload_refused", message: REFUSED_NONE } });
    }
    // R-A2 + U2: a computer that proves its proxies, or not, its original is refused under proxies
    expect(mayReceive("original", { id: "lib_p" }, "computer", { sender: null }).ok).toBe(false);
    expect(mayReceive("original", { id: "lib_orig" }, "computer").ok).toBe(true);
    expect(mayReceive("original", { id: "lib_all" }, "computer").ok).toBe(true);
  });

  it("a final follows the Finals setting (all when unset); derivatives and served bytes always pass; This Mac takes its own", () => {
    expect(mayReceive("original", { id: "lib_none", collectionId: "col_fin" }, "computer").ok).toBe(true);
    for (const k of ["derivative", "serving"] as const) expect(mayReceive(k, { id: "lib_none" }, "computer").ok).toBe(true);
    // P2 + U2: a computer's proxy is taken only where Hosted proxies are on (originals hosts none)
    expect(mayReceive("proxy", { id: "lib_none" }, "computer").ok).toBe(false);
    expect(mayReceive("proxy", { id: "lib_orig" }, "computer").ok).toBe(false);
    expect(mayReceive("proxy", { id: "lib_p" }, "computer").ok).toBe(true);
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

  // UNIFIED-PRD §4.2 (CEO 11-18): under proxies only a computer's original is refused; a browser's own file is taken
  it("under proxies a Mac's original is refused at its start, a browser's is taken (UNIFIED-PRD §4.2)", async () => {
    const r = await start("lib_p", "/Users/tiny/Movies/Handstand.mp4");
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: REFUSED_PROXIES, code: "upload_refused" });
    expect((await start("lib_p")).status).toBe(201);
  });

  it("a browser's made proxy is refused under none and originals at its start, filed under proxies; the iPhone app's 720p copy is taken under every setting", async () => {
    const probe = { duration: 3, width: 1280, height: 720, fps: 30, rotation: 0, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" };
    const made = (lib: string, cookie?: string) =>
      app.request(`/api/library/${lib}/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie, "x-ct-origin": "phone" } : {}) },
        body: JSON.stringify({ filename: "Cartwheel.mov", size: 4, quick: hex("q"), proxy: { size: 9000, probe, sha256: hex("abcd") } }),
      });
    expect(await (await made("lib_none")).json()).toMatchObject({ code: "upload_refused", message: REFUSED_NONE });
    expect((await made("lib_orig")).status).toBe(409);
    expect((await made("lib_p")).status).toBe(201);
    const appCookie = sessionCookieFor("tinyacrobatics", true)!;
    for (const lib of ["lib_none", "lib_orig", "lib_p", "lib_all"]) expect((await made(lib, appCookie)).status, lib).toBe(201);
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

  it("a client session's token counts as the iPhone app only when it was paired as a phone; a Mac's, a tablet's or a bot's is refused under none", async () => {
    const url = "http://localhost/api/library/lib_none/uploads";
    const send = (headers: Record<string, string>) =>
      app.request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ filename: "IMG 0002.MOV", size: 4 }) });
    const bearer = (deviceType: "desktop" | "mobile" | "tablet" | "bot" | "unknown") =>
      `Bearer ${issueSession({ subject: "tinyacrobatics", scopes: ["read", "write"], client: { deviceType } }).token}`;
    // the phone's own DPoP session: its key signs each request
    const k = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const j = k.publicKey.export({ format: "jwk" }) as { kty: "EC"; crv: "P-256"; x: string; y: string };
    const jwk = { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
    const { token } = issueSession({ subject: "tinyacrobatics", scopes: ["read", "write"], jkt: jwkThumbprint(jwk), client: { deviceType: "mobile", label: "Tiny's iPhone" } });
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const proof = () => {
      const h = b64({ typ: "dpop+jwt", alg: "ES256", jwk });
      const p = b64({ iat: Math.floor(Date.now() / 1000), jti: randomUUID(), htm: "POST", htu: url, ath: tokenHash(token) });
      return `${h}.${p}.${sign("sha256", Buffer.from(`${h}.${p}`), { key: k.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    };
    const dpopPhone = await send({ authorization: `DPoP ${token}`, dpop: proof(), "x-ct-origin": "phone" });
    expect(dpopPhone.status).toBe(201);
    const { id } = (await dpopPhone.json()) as { id: string };
    expect(d.prepare("SELECT origin FROM uploads WHERE id = ?").get(id)).toEqual({ origin: "phone" });
    expect((await send({ authorization: bearer("mobile"), "x-ct-origin": "phone" })).status).toBe(201);
    // the iPhone app on an iPad is the phone too
    expect((await send({ authorization: bearer("tablet"), "x-ct-origin": "phone" })).status).toBe(201);
    // every other kind of device, header or not
    for (const kind of ["desktop", "bot", "unknown"] as const) {
      const r = await send({ authorization: bearer(kind), "x-ct-origin": "phone" });
      expect(r.status, kind).toBe(409);
      expect(await r.json()).toMatchObject({ error: REFUSED_NONE, code: "upload_refused" });
    }
    // a Mac's token decides alone: the iPhone app's cookie beside it does not make it the phone
    expect((await send({ authorization: bearer("desktop"), cookie: sessionCookieFor("tinyacrobatics", true)!, "x-ct-origin": "phone" })).status).toBe(409);
    // the header still names the phone's own send: a phone's token without it is a person's upload, refused under none
    expect((await send({ authorization: bearer("mobile") })).status).toBe(409);
    // a browser's cookie with the header stays refused, and the app's own cookie is still taken
    expect((await send({ cookie: sessionCookieFor("tinyacrobatics", false)!, "x-ct-origin": "phone" })).status).toBe(409);
    expect((await send({ cookie: sessionCookieFor("tinyacrobatics", true)!, "x-ct-origin": "phone" })).status).toBe(201);
  });

  it("the kind comes from the link: a link made for a Mac stays a Mac's though the device says phone, and a phone's link is the phone", async () => {
    const redeem = async (deviceType: "desktop" | "mobile") => {
      const { credential } = createGrant({ kind: "pairing", subject: "tinyacrobatics", scopes: ["read", "write"], deviceType });
      const r = await app.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: credential,
          subject_token_type: "urn:creatortoolset:params:oauth:token-type:server-bootstrap",
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          client_device_type: "mobile",
        }).toString(),
      });
      expect(r.status).toBe(200);
      return ((await r.json()) as { access_token: string }).access_token;
    };
    const send = (token: string) =>
      app.request("/api/library/lib_none/uploads", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-ct-origin": "phone" },
        body: JSON.stringify({ filename: "IMG 0003.MOV", size: 4 }),
      });
    const mac = await send(await redeem("desktop"));
    expect(mac.status).toBe(409);
    expect(await mac.json()).toMatchObject({ error: REFUSED_NONE, code: "upload_refused" });
    expect((await send(await redeem("mobile"))).status).toBe(201);
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

  // U2 (UNIFIED-PRD §4.2): under proxies an original is refused whether or not the computer proves its proxies
  it("an original from a computer is refused under proxies, proving or not; under originals and all it is taken", () => {
    for (const sender of [proving, older, undefined]) {
      expect(mayReceive("original", { id: "lib_p" }, "computer", { sender })).toEqual({
        ok: false,
        status: 409,
        body: { error: REFUSED_PROXIES, code: "upload_refused", message: REFUSED_PROXIES },
      });
    }
    expect(mayReceive("original", { id: "lib_all" }, "computer", { sender: proving }).ok).toBe(true);
  });

  it("a proxy with a matching proof is taken under proxies and all; under none it is refused, even in a library shared with members", async () => {
    const proof = { sha256: hex("proxy"), got: hex("proxy"), bytes: 5, original: 500 };
    for (const id of ["lib_p", "lib_all"]) expect(mayReceive("proxy", { id }, "computer", { sender: proving, proof }).ok, id).toBe(true);
    // R-A2 (team proxies under none) is replaced by this row: Hosted proxies off is off, members or not (UNIFIED-PRD §4.2)
    expect(await hasMembers("lib_team")).toBe(true);
    expect(mayReceive("proxy", { id: "lib_team" }, "computer", { sender: proving, proof }).ok).toBe(false);
    expect(mayReceive("proxy", { id: "lib_none" }, "computer", { sender: proving, proof }).ok).toBe(false);
  });

  it("a proxy no smaller than its original fails the proof, whether the same size or bigger (UNIFIED-PRD §4.1 rule 4)", () => {
    const bad = (proof: object) => mayReceive("proxy", { id: "lib_p" }, "computer", { sender: proving, proof });
    expect(bad({ sha256: hex("proxy"), got: hex("proxy"), bytes: 600, original: 500 })).toMatchObject({ ok: false, body: { message: REFUSED_PROOF } });
    expect(bad({ sha256: hex("proxy"), got: hex("proxy"), bytes: 499, original: 500 }).ok).toBe(true);
  });

  it("an original labelled proxy fails the proof: other bytes than declared, or the original's own size", () => {
    const bad = (proof: object) => mayReceive("proxy", { id: "lib_p" }, "computer", { sender: proving, proof });
    expect(bad({ sha256: hex("proxy"), got: hex("original"), bytes: 5, original: 500 })).toMatchObject({ ok: false, body: { message: REFUSED_PROOF } });
    expect(bad({ sha256: hex("original"), got: hex("original"), bytes: 500, original: 500 })).toMatchObject({ ok: false, body: { message: REFUSED_PROOF } });
    expect(bad({ sha256: "not-a-hash" })).toMatchObject({ ok: false });
  });

  it("the size rule holds for every sender, a computer without the proof and a person's copy included", () => {
    const sized = { bytes: 500, original: 500 };
    expect(mayReceive("proxy", { id: "lib_p" }, "computer", { sender: older, proof: sized })).toMatchObject({ ok: false, body: { message: REFUSED_PROOF } });
    expect(mayReceive("proxy", { id: "lib_p" }, "person", { proof: sized })).toMatchObject({ ok: false, body: { message: REFUSED_PROOF } });
    expect(mayReceive("proxy", { id: "lib_p" }, "person", { proof: { bytes: 499, original: 500 } }).ok).toBe(true);
  });

  it("a computer's proxy job: declared and matching is filed; other bytes are refused and nothing of them stays", async () => {
    const { device } = pairDevice("tinyacrobatics", "Tiny Mac");
    setDeviceWork(device.id, proving.work);
    d.prepare(`INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('a_team', 'lib_p', 'video', 'Handstand', 'tinyacrobatics', 0)`).run();
    d.prepare(
      `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, created_by, created_at, state) VALUES ('v_team', 'a_team', 1, 'mac:v_team', 500, 'mac:x', 'tinyacrobatics', 0, 'ready')`,
    ).run();
    const job = () =>
      Number(d.prepare(`INSERT INTO jobs (library_id, version_id, kind, state, actor, held_by) VALUES ('lib_p', 'v_team', 'proxy', 'running', 'tinyacrobatics', ?) RETURNING id`).get(device.id)!.id);
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

  it("a computer's proxy of a file the server holds (a phone's, held under none too) is kept only if smaller than the original", async () => {
    const { device } = pairDevice("tinyacrobatics", "Tiny Mac");
    setDeviceWork(device.id, proving.work);
    d.prepare(`INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('a_phone_proxy', 'lib_none', 'video', 'Flip', 'tinyacrobatics', 0)`).run();
    d.prepare(
      `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, created_by, created_at, state) VALUES ('v_phone_proxy', 'a_phone_proxy', 1, 'phone:v_phone_proxy', 500, 'phone:y', 'tinyacrobatics', 0, 'ready')`,
    ).run();
    const job = Number(d.prepare(`INSERT INTO jobs (library_id, version_id, kind, state, actor, held_by) VALUES ('lib_none', 'v_phone_proxy', 'proxy', 'running', 'tinyacrobatics', ?) RETURNING id`).get(device.id)!.id);
    expect(await acceptLibraryFile(job, device.id, "proxy", Readable.from([Buffer.alloc(500, 1)]))).toMatchObject({ ok: false, status: 409, body: { message: REFUSED_PROOF } });
    const inc = path.join(dir, "library", "incoming", String(job));
    expect(existsSync(inc) ? readdirSync(inc) : []).toEqual([]);
    expect(await acceptLibraryFile(job, device.id, "proxy", Readable.from([Buffer.alloc(499, 1)]))).toBe(true);
    d.prepare("DELETE FROM jobs WHERE id = ?").run(job); // the R-A2 test counts the proxy jobs of none
  });

  it("R-A2 replaced: the team-proxy queue is gone, so a library under none never gets a proxy job from a computer's report", async () => {
    const report = await import("./report");
    expect(report).not.toHaveProperty("teamProxies");
    const { device } = pairDevice("tinyacrobatics", "Tiny Studio");
    d.prepare(`INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('a_t2', 'lib_team', 'video', 'Flip', 'tinyacrobatics', 0), ('a_n2', 'lib_none', 'video', 'Flip', 'tinyacrobatics', 0)`).run();
    expect(d.prepare("SELECT COUNT(*) AS n FROM jobs WHERE library_id IN ('lib_team', 'lib_none') AND kind = 'proxy'").get()).toEqual({ n: 0 });
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
  "apps/captions/api/editor/luts.ts": "PASS: a .cube LUT file (text, under 48 MB), not footage",
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
  it("mayServe: an original only under originals and all; a proxy only under proxies and all, never under none (team or not)", async () => {
    addVersion("vs_none", "lib_none");
    addVersion("vs_team", "lib_team");
    addVersion("vs_p", "lib_p");
    addVersion("vs_all", "lib_all");
    addVersion("vs_orig", "lib_orig");
    const serve = (lib: string, versionId: string, what: "original" | "proxy") => mayServe({ id: lib, versionId }, what);
    expect((await serve("lib_none", "vs_none", "original")).ok).toBe(false);
    expect((await serve("lib_none", "vs_none", "proxy")).ok).toBe(false);
    expect((await serve("lib_team", "vs_team", "proxy")).ok).toBe(false);
    expect((await serve("lib_team", "vs_team", "original")).ok).toBe(false);
    expect((await serve("lib_p", "vs_p", "original")).ok).toBe(false);
    expect((await serve("lib_p", "vs_p", "proxy")).ok).toBe(true);
    expect((await serve("lib_all", "vs_all", "original")).ok).toBe(true);
    expect((await serve("lib_orig", "vs_orig", "original")).ok).toBe(true);
    expect((await serve("lib_orig", "vs_orig", "proxy")).ok).toBe(false);
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

describe("U2 §4.6 library migration: set up what has clips; a shared library keeps the team's proxies", () => {
  it("a dry run lists every change and writes none; a real run writes them; a second run changes nothing", async () => {
    const { migrateLibraries } = await import("./migrate");
    d.prepare(`INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES
      ('lib_mig_team', 'tinyacrobatics', 'T', 'local', '{"upload":"none","projectId":"ws_team"}', 0),
      ('lib_mig_solo', 'tinyacrobatics', 'S', 'local', '{"upload":"none"}', 0),
      ('lib_mig_empty', 'tinyacrobatics', 'E', 'local', '{}', 0),
      ('lib_mig_set', 'tinyacrobatics', 'K', 'local', '{"upload":"all","setupAt":"2026-01-01T00:00:00.000Z"}', 0)`).run();
    d.prepare(`INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES
      ('a_mig_team', 'lib_mig_team', 'video', 'V', 'tinyacrobatics', 0), ('a_mig_solo', 'lib_mig_solo', 'video', 'V', 'tinyacrobatics', 0),
      ('a_mig_set', 'lib_mig_set', 'video', 'V', 'tinyacrobatics', 0)`).run();
    const mine = (c: { libraryId: string }) => c.libraryId.startsWith("lib_mig_");
    const dry = (await migrateLibraries({ dryRun: true, now: "2026-11-18T00:00:00.000Z" })).filter(mine);
    expect(dry).toEqual([
      { libraryId: "lib_mig_team", field: "setupAt", from: null, to: "2026-11-18T00:00:00.000Z" },
      { libraryId: "lib_mig_team", field: "upload", from: "none", to: "proxies" },
      { libraryId: "lib_mig_solo", field: "setupAt", from: null, to: "2026-11-18T00:00:00.000Z" },
    ]);
    expect(JSON.parse((d.prepare("SELECT settings FROM libraries WHERE id = 'lib_mig_team'").get() as { settings: string }).settings)).not.toHaveProperty("setupAt");
    await migrateLibraries({ now: "2026-11-18T00:00:00.000Z" });
    const team = JSON.parse((d.prepare("SELECT settings FROM libraries WHERE id = 'lib_mig_team'").get() as { settings: string }).settings);
    expect(team).toMatchObject({ upload: "proxies", setupAt: "2026-11-18T00:00:00.000Z" });
    expect((await migrateLibraries()).filter(mine)).toEqual([]);
    const kept = JSON.parse((d.prepare("SELECT settings FROM libraries WHERE id = 'lib_mig_set'").get() as { settings: string }).settings);
    expect(kept).toMatchObject({ upload: "all", setupAt: "2026-01-01T00:00:00.000Z" });
  });

  it("a legacy upload false reads as none, so a shared library with no Hosted media takes the team's proxies", async () => {
    const { migrateLibraries } = await import("./migrate");
    d.prepare(`INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_mig_false', 'tinyacrobatics', 'F', 'local', '{"upload":false,"projectId":"ws_team"}', 0)`).run();
    const changes = (await migrateLibraries({ dryRun: true })).filter((c) => c.libraryId === "lib_mig_false");
    expect(changes).toEqual([{ libraryId: "lib_mig_false", field: "upload", from: 0, to: "proxies" }]);
    await migrateLibraries();
    expect(JSON.parse((d.prepare("SELECT settings FROM libraries WHERE id = 'lib_mig_false'").get() as { settings: string }).settings)).toMatchObject({ upload: "proxies" });
  });
});
