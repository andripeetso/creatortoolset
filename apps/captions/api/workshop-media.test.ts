import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "ws-media-"));
process.env.DATA_DIR = dataDir;
const { Hono } = await import("hono");
const { workshopApp } = await import("./workshop");
const { installTestPlugin } = await import("./lib/workshop/export-test-plugin");

// the vault's status values and format come from a plug-in (the public default is generic)
beforeAll(() => installTestPlugin());

const session = "aaaaaaaa-0000-4000-8000-000000000002";
const sdir = path.join(dataDir, "workshop", "sessions", session);
mkdirSync(path.join(sdir, "docs"), { recursive: true });
writeFileSync(path.join(sdir, "meta.json"), JSON.stringify({ id: session, owner: "alex", title: "Strength training", query: "", sources: [], drafts: [], createdAt: 1, updatedAt: 1 }));
const reelId = "cccccccc-0000-4000-8000-000000000011";
const plainId = "cccccccc-0000-4000-8000-000000000012";
const picId = "dddddddd-0000-4000-8000-000000000001";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]).toString("base64");
mkdirSync(path.join(sdir, "images"), { recursive: true });
writeFileSync(path.join(sdir, "images", `${picId}.png`), Buffer.from(PNG, "base64"));
const doc = (id: string, title: string, text: string) =>
  writeFileSync(
    path.join(sdir, "docs", `${id}.json`),
    JSON.stringify({ id, sessionId: session, kind: "reel", title, frameworkIds: [], versions: [], nextBlock: 2, nextVersion: 1, createdAt: 1, updatedAt: 2, blocks: [{ id: "b1", text, author: "user", at: 1 }] }),
  );
doc(reelId, "Reel script", `So she sends this:\n\n![Morgan's message](pic:${picId})\n\nAnd then?`);
doc(plainId, "Plain reel", "Just words, no picture.");

const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "alex", role: "admin", cloud: true, off: [] });
  await next();
});
app.route("/api/workshop", workshopApp as never);
const call = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

describe("Workshop piece pictures", () => {
  it("refuses anything that is not a picture", async () => {
    const text = Buffer.from("this is a text file, not a picture").toString("base64");
    const asJpeg = await call("POST", `/api/workshop/sessions/${session}/media`, { name: "note.jpg", type: "image/jpeg", data: text });
    expect(asJpeg.status).toBe(400);
    expect(((await asJpeg.json()) as { error: string }).error).toBe("That file is not a picture");
    expect((await call("POST", `/api/workshop/sessions/${session}/media`, { name: "a.gif", type: "image/gif", data: PNG })).status).toBe(400);
    expect((await call("POST", `/api/workshop/sessions/${session}/media`, { name: "a.png", type: "image/png" })).status).toBe(400);
  });

  it("stores a picture and serves it at the session's image route", async () => {
    const made = await call("POST", `/api/workshop/sessions/${session}/media`, { name: "Morgan's message.png", type: "image/png", data: PNG });
    expect(made.status).toBe(201);
    const ref = (await made.json()) as { id: string; type: string };
    expect(ref.type).toBe("image/png");
    const shown = await call("GET", `/api/workshop/sessions/${session}/images/${ref.id}`);
    expect(shown.status).toBe(200);
    expect(shown.headers.get("Content-Type")).toBe("image/png");
  });

  it("exports the note with pictures as a zip of one folder: the note and each picture, the embed where the token stood", async () => {
    const res = await call("GET", `/api/workshop/sessions/${session}/obsidian.md?day=2026-11-05`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toContain("Strength training.zip");
    const zip = Buffer.from(await res.arrayBuffer()).toString("latin1");
    expect(zip).toContain("Strength training/Strength training.md");
    expect(zip).toContain("Strength training/Strength training 1.png");
  });

  it("keeps a plain export a plain .md when the reel has no pictures", async () => {
    const plainSession = "aaaaaaaa-0000-4000-8000-000000000003";
    const dir = path.join(dataDir, "workshop", "sessions", plainSession);
    mkdirSync(path.join(dir, "docs"), { recursive: true });
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id: plainSession, owner: "alex", title: "Plain", query: "", sources: [], drafts: [], createdAt: 1, updatedAt: 1, status: "ready" }));
    writeFileSync(
      path.join(dir, "docs", `${plainId}.json`),
      JSON.stringify({ id: plainId, sessionId: plainSession, kind: "reel", title: "Plain reel", frameworkIds: [], versions: [], nextBlock: 2, nextVersion: 1, createdAt: 1, updatedAt: 2, blocks: [{ id: "b1", text: "Just words, no picture.", author: "user", at: 1 }] }),
    );
    const res = await call("GET", `/api/workshop/sessions/${plainSession}/obsidian.md?day=2026-11-05`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toContain('filename="Plain.md"');
    expect(await res.text()).toBe("---\nchange: 2026-11-05\ndetails:\nselector.Status: 🎥 Filming\nselector.Media: 🎞️ Reel\n---\nJust words, no picture.\n");
  });
});
