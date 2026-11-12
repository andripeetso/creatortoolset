import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it } from "vitest";
import type { AuthVars } from "./auth";
import type { KeptView } from "../contracts/storage";

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "kept-"));
process.env.DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const at = (rel: string) => path.join(dataDir, rel);
const put = (rel: string, data: string | number) => {
  mkdirSync(path.dirname(at(rel)), { recursive: true });
  writeFileSync(at(rel), typeof data === "number" ? Buffer.alloc(data, 1) : data);
};
const has = (rel: string) => existsSync(at(rel));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// chat pictures: one each for two accounts
put("assistant/images/tiny/a.png", 5);
put("assistant/images/other/b.png", 3);
// chat videos: one of its own, one still uploading, one that Review also has (the same file under a second name)
put(`assistant/files/tiny/${id(1)}/file`, 1000);
put(`assistant/files/tiny/${id(2)}/parts/1`, 400);
put(`review/${id(10)}/meta.json`, JSON.stringify({ id: id(10), owner: "tiny", versions: [] }));
put(`review/${id(10)}/v1/source`, 2000);
mkdirSync(at(`assistant/files/tiny/${id(3)}`), { recursive: true });
linkSync(at(`review/${id(10)}/v1/source`), at(`assistant/files/tiny/${id(3)}/file`));
put(`review/${id(11)}/meta.json`, JSON.stringify({ id: id(11), owner: "other", versions: [] }));
// the trash of both tools
put(`review/trash/${id(12)}/meta.json`, JSON.stringify({ id: id(12), name: "old", owner: "tiny", versions: [], approval: { status: "none" }, deletedAt: Date.now() }));
put(`review/trash/${id(12)}/v1/source`, 3000);
put(`review/trash/${id(13)}/meta.json`, JSON.stringify({ id: id(13), name: "theirs", owner: "other", versions: [], approval: { status: "none" }, deletedAt: Date.now() }));
const project = (pid: string, deletedAt?: number) => {
  put(`projects/${pid}/meta.json`, JSON.stringify({ id: pid, name: pid, owner: "tiny", createdAt: 0, updatedAt: 0, duration: 0, deletedAt, clips: [{ id: "clip-01", name: "a", duration: 0, createdAt: 0 }] }));
  put(`projects/${pid}/clips/clip-01/original`, 700);
};
project("live-one");
project("binned", Date.now());
// a finished render, and one on its way to Finals
const render = (n: number, finals?: { status: string }) => {
  put(`exports/${id(n)}/job.json`, JSON.stringify({ id: id(n), owner: "tiny", status: "done", kind: "burn", format: "mp4", filename: "out.mp4", params: {}, createdAt: Date.now(), finishedAt: Date.now(), engine: "wysiwyg", finals }));
  put(`exports/${id(n)}/out.mp4`, 900);
};
render(20);
render(21, { status: "sending" });
// posts made before accounts have no owner; a Workshop source with its text
put("instagram/p1/meta.json", JSON.stringify({}));
put("workshop/sources/s1.json", JSON.stringify({ owner: "tiny" }));
put("workshop/sources/s1.txt", 50);

const { keptView, emptyKept } = await import("./kept");
const { storageApp } = await import("./devices-storage");
const tiny = { username: "tiny", role: "user" } as Parameters<typeof keptView>[0];
const admin = { username: "boss", role: "admin" } as Parameters<typeof keptView>[0];
const row = async (u: typeof tiny, kind: string) => (await keptView(u)).rows.find((r) => r.kind === kind)!;

it("counts only the account's own files, and owner-less ones for an admin", async () => {
  expect(await row(tiny, "chat-pictures")).toMatchObject({ items: 1, bytes: 5 });
  expect(await row(tiny, "analyzer")).toMatchObject({ items: 0 });
  expect(await row(admin, "analyzer")).toMatchObject({ items: 1 });
  expect((await row(tiny, "workshop")).bytes).toBeGreaterThanOrEqual(50);
  expect(await row(tiny, "captions")).toMatchObject({ items: 1 });
});

it("a chat video Review also has counts once, as Review's; one still uploading is not counted", async () => {
  expect((await row(tiny, "review")).bytes).toBeGreaterThanOrEqual(2000);
  const chat = await row(tiny, "chat-videos");
  expect(chat).toMatchObject({ items: 1, keepDays: 7 });
  expect(chat.bytes).toBe(1000);
});

it("the trash has its own rows, and a render going to Finals is not counted", async () => {
  expect(await row(tiny, "review-trash")).toMatchObject({ items: 1, keepDays: 30 });
  expect((await row(tiny, "review-trash")).bytes).toBeGreaterThanOrEqual(3000);
  expect(await row(tiny, "captions-trash")).toMatchObject({ items: 1, keepDays: 5 });
  expect(await row(tiny, "exports")).toMatchObject({ items: 1 });
});

it("Empty deletes what the row counts and nothing else", async () => {
  for (const kind of ["chat-pictures", "chat-videos", "review-trash", "captions-trash", "exports"] as const) await emptyKept(kind, tiny);
  expect(has("assistant/images/tiny/a.png")).toBe(false);
  expect(has("assistant/images/other/b.png")).toBe(true);
  expect(has(`assistant/files/tiny/${id(1)}`)).toBe(false);
  expect(has(`assistant/files/tiny/${id(2)}/parts/1`)).toBe(true); // still uploading
  expect(has(`assistant/files/tiny/${id(3)}/file`)).toBe(true); // Review's file: deleting it would free nothing
  expect(has(`review/${id(10)}/v1/source`)).toBe(true);
  expect(has(`review/trash/${id(12)}`)).toBe(false);
  expect(has(`review/trash/${id(13)}`)).toBe(true); // another account's
  expect(has("projects/binned")).toBe(false);
  expect(has("projects/live-one")).toBe(true);
  expect(has(`exports/${id(20)}`)).toBe(false);
  expect(has(`exports/${id(21)}`)).toBe(true); // on its way to Finals
});

it("through the route: a member reads their own, only the short-lived kinds can be emptied, a guest gets nothing", async () => {
  const as = (user: object) => {
    const app = new Hono<{ Variables: AuthVars }>();
    app.use(async (c, next) => {
      c.set("user", user as never);
      return next();
    });
    app.route("/api/devices/storage", storageApp);
    return app;
  };
  const member = as(tiny);
  const got = await member.request("/api/devices/storage/kept");
  expect(got.status).toBe(200);
  expect(((await got.json()) as KeptView).rows.find((r) => r.kind === "review")).toMatchObject({ items: 1 });
  expect((await member.request("/api/devices/storage/kept/review/empty", { method: "POST" })).status).toBe(400);
  expect(has(`review/${id(10)}/v1/source`)).toBe(true);
  expect((await member.request("/api/devices/storage/kept/chat-pictures/empty", { method: "POST" })).status).toBe(200);
  expect((await as({ username: "guest", role: "visitor" }).request("/api/devices/storage/kept")).status).toBe(403);
});
