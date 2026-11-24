import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// Add from Instagram: each downloaded file goes to the library as a dropped file does, and its temporary copy is
// removed after, except while the save waits for a computer (that save still reads it).
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "ig-add-"));
process.env.DATA_DIR = dir;
const used = vi.hoisted(() => ({ waiting: false, names: [] as string[], kept: [] as string[] }));
vi.mock("../lib/instagram/session", async (real) => ({
  ...(await real<typeof import("../lib/instagram/session")>()),
  mayUseInstagram: (u: { role: string }) => u.role === "admin",
  readPost: async () => ({ username: "tinyacrobatics", code: "BA", files: [{ url: "https://cdn.test/v.mp4", kind: "video" }, { url: "https://cdn.test/p.jpg", kind: "picture" }] }),
}));
vi.mock("../assistant-files", () => ({
  keepFetched: async (_u: string, name: string) => {
    used.kept.push(name);
    return { id: name, name, mime: "video/mp4", size: 5 };
  },
  removeFile: async (_u: string, id: string) => void used.kept.splice(used.kept.indexOf(id), 1),
  useFile: async (_u: unknown, id: string) => {
    used.names.push(id);
    return used.waiting ? { to: "library", id: "save-1", name: id, href: "/library", note: "Waiting for your Mac", waiting: true } : { to: "library", id: "a1", name: id, href: "/library?asset=a1" };
  },
}));
const { instagramAddApp } = await import("./instagram-add");

const app = (role: string) => new Hono<{ Variables: { user: { username: string; role: string } } }>().use(async (c, next) => (c.set("user", { username: "owner", role }), next())).route("/", instagramAddApp as never);
const add = (role = "admin") => app(role).request("/instagram/add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: "https://www.instagram.com/p/BA/" }) });

afterEach(() => {
  vi.unstubAllGlobals();
  used.names = [];
  used.kept = [];
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Add from Instagram", () => {
  it("adds each file of the post, named by handle, code and place, and removes the temporary copies", async () => {
    used.waiting = false;
    vi.stubGlobal("fetch", async () => new Response("bytes"));
    const r = await add();
    expect(r.status).toBe(200);
    expect(((await r.json()) as { added: unknown[] }).added).toHaveLength(2);
    expect(used.names).toEqual(["tinyacrobatics BA 1.mp4", "tinyacrobatics BA 2.jpg"]);
    expect(used.kept).toEqual([]);
  });

  it("keeps the temporary copy while the save waits for a computer", async () => {
    used.waiting = true;
    vi.stubGlobal("fetch", async () => new Response("bytes"));
    await add();
    expect(used.kept).toEqual(used.names);
  });

  it("refuses an account that isn't the owner", async () => {
    expect((await add("member")).status).toBe(403);
  });
});
