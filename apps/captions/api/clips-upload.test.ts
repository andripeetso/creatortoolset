import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "./auth";

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "clips-upload-"));
process.env.DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const { clipsApp } = await import("./clips");

// the signed-in account comes from x-as, so a test can act as a second person
const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  const name = c.req.header("x-as") ?? "ana";
  c.set("user", { username: name, role: "user", cloud: false, off: [] });
  await next();
});
app.route("/api/clips", clipsApp);

const PART = 16 * 1024 * 1024;
const size = PART + 10;

const init = async () => (await app.request("/api/clips/init", json({ name: "Walk.webm", mime: "video/webm", size }))).json() as Promise<{ id: string; partSize: number }>;
const json = (body: unknown, as?: string) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(as ? { "x-as": as } : {}) },
  body: JSON.stringify(body),
});
const sendPart = (id: string, n: number, bytes: Buffer, as?: string) =>
  app.request(`/api/clips/${id}/parts/${n}`, {
    method: "POST",
    headers: {
      "upload-length": String(size),
      "upload-part-size": String(PART),
      "content-length": String(bytes.length),
      "content-type": "application/octet-stream",
      ...(as ? { "x-as": as } : {}),
    },
    body: bytes,
  });
const parts = (id: string, as?: string) =>
  app.request(`/api/clips/${id}/parts`, as ? { headers: { "x-as": as } } : {});

describe("resumable clip uploads", () => {
  it("an interrupted upload reports its last part, so the browser sends only the rest", async () => {
    const up = await init();
    // the connection drops after part 1
    expect((await sendPart(up.id, 1, Buffer.alloc(PART, 1))).status).toBe(200);
    expect(await (await parts(up.id)).json()).toEqual({ partSize: PART, parts: [1] });
    // finishing too early is refused: part 2 is still missing
    const early = await app.request(`/api/clips/${up.id}/complete`, { method: "POST" });
    expect(early.status).toBe(400);
    // the browser resumes with part 2 only
    expect((await sendPart(up.id, 2, Buffer.alloc(10, 2))).status).toBe(200);
    expect(await (await parts(up.id)).json()).toEqual({ partSize: PART, parts: [1, 2] });
  });

  it("refuses to tell anyone else which parts are there, or anything for a bad id", async () => {
    const up = await init();
    await sendPart(up.id, 1, Buffer.alloc(PART, 1));
    expect((await parts(up.id, "nico")).status).toBe(404);
    expect((await parts("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await parts("NOT AN ID")).status).toBe(404);
  });
});

describe("a clip's stored type", () => {
  it("plays as footage only: a type the uploader named (text/html) goes as a download that never runs as a page", async () => {
    const page = Buffer.from("<script>alert(document.cookie)</script>");
    const res = await app.request("/api/clips?name=x&mime=text/html", { method: "POST", headers: { "content-length": String(page.length) }, body: page });
    const { id } = (await res.json()) as { id: string };
    const play = await app.request(`/api/clips/${id}/play`);
    expect(play.headers.get("content-type")).toBe("application/octet-stream");
    expect(play.headers.get("x-content-type-options")).toBe("nosniff");
    expect(play.headers.get("content-security-policy")).toBe("sandbox");
    const down = await app.request(`/api/clips/${id}/download`);
    expect(down.headers.get("content-type")).toBe("application/octet-stream");
    expect(down.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("Video Notes under Blur faces", () => {
  // the account's Media Library with Blur faces on: a recording is not known to be blurred (upload-gate.ts mayLeave)
  it("takes no recording while it is on, in parts or whole; with it off it does", async () => {
    const { libraryDb } = await import("./library/db");
    const { REFUSED_BLUR } = await import("./library/upload-gate");
    libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_bea', 'bea', 'Library', 'local', ?, 0)").run(JSON.stringify({ upload: "none", blurFaces: true }));
    const start = await app.request("/api/clips/init", json({ name: "Handstand.webm", mime: "video/webm", size }, "bea"));
    expect(start.status).toBe(409);
    expect(((await start.json()) as { message: string }).message).toBe(REFUSED_BLUR);
    const whole = await app.request("/api/clips?name=Handstand.webm&mime=video/webm", { method: "POST", headers: { "x-as": "bea", "content-type": "video/webm" }, body: "webm-bytes" });
    expect(whole.status).toBe(409);
    libraryDb().prepare("UPDATE libraries SET settings = json_set(settings, '$.blurFaces', json('false')) WHERE id = 'lib_bea'").run();
    const again = await app.request("/api/clips/init", json({ name: "Handstand.webm", mime: "video/webm", size }, "bea"));
    expect(again.status).toBe(200);
  });
});
