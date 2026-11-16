import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";

// Jev says yes to a clip whose words say phone, for the question about the Mobile folder
vi.mock("../lib/jev", async (orig) => ({
  ...(await orig<typeof import("../lib/jev")>()),
  ask: vi.fn(async (_key: string, state: { clip: string }, questions: Record<string, { question?: string; prompt?: string }>) =>
    Object.fromEntries(
      Object.entries(questions).map(([k, q]) => {
        const about = JSON.stringify(q);
        const phone = /phone/i.test(state.clip.match(/Description: .*/)?.[0] ?? "");
        return [k, { noul: about.includes('\\"Mobile\\"') === phone ? 0.9 : 0.1 }];
      }),
    ),
  ),
}));
vi.mock("../my-keys", async (orig) => ({
  ...(await orig<typeof import("../my-keys")>()),
  keyFor: () => ({ key: "jev-test" }),
}));

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-smart-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { collectionApp } = await import("./collections");
const { indexAsset } = await import("./query");
const { clipText, fileSmart, isSorting, parseWays } = await import("./smart");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "member" } as never);
  return next();
});
app.route("/api/library", libraryApp);
app.route("/api/library", collectionApp);
const call = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { "x-user": "owner-s", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const data = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const inFolder = (cid: string) =>
  (libraryDb().prepare("SELECT asset_id, by_ai FROM collection_items WHERE collection_id = ? ORDER BY asset_id").all(cid) as { asset_id: string; by_ai: number }[]).map(
    (r) => `${r.asset_id}${r.by_ai ? "*" : ""}`,
  );
const sorted = (cid: string) => vi.waitFor(() => expect(isSorting(cid)).toBe(false));

let n = 0;
function seed(id: string, description: string) {
  const d = libraryDb();
  const at = 3_000_000 + ++n * 1000;
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_s', 'video', ?, ?, 'owner-s', ?)").run(id, id, `${id}-v1`, at);
  d.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, probe) VALUES (?, ?, 1, 'k', 1, ?, 'ready', 'owner-s', ?, '{"duration":60,"width":2400,"height":1080}')`,
  ).run(`${id}-v1`, id, `h-${id}`, at);
  d.prepare("INSERT INTO descriptions (version_id, source, text, provider, created_at) VALUES (?, 'ai', ?, 'test', 0)").run(`${id}-v1`, description);
  indexAsset(d, id);
}

beforeAll(() => {
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_s', 'owner-s', 'S', 'local', 0)").run();
  seed("m1", "A phone screen recording of gameplay.");
  seed("m2", "A phone screen recording in a castle.");
  seed("d1", "A desktop screen recording of gameplay.");
});

describe("smart folders", () => {
  it("a rule files the clips that fit; a clip taken out stays out, one put in stays in; stopping takes back only the AI's", async () => {
    const mobile = await data(call("POST", "/api/library/lib_s/collections", { name: "Mobile", rule: "Gameplay recorded on a phone" }));
    expect(mobile.rule).toBe("Gameplay recorded on a phone");
    await sorted(mobile.id);
    expect(inFolder(mobile.id)).toEqual(["m1*", "m2*"]);
    // filed in a folder: off the top level
    const top = await data(call("GET", "/api/library/lib_s/assets?unfiled=1"));
    expect(top.items.map((i: any) => i.id)).toEqual(["d1"]);

    await call("DELETE", `/api/library/lib_s/collections/${mobile.id}/items`, { assetIds: ["m2"] });
    await call("POST", `/api/library/lib_s/collections/${mobile.id}/items`, { assetIds: ["d1"] });
    await call("PATCH", `/api/library/lib_s/collections/${mobile.id}`, { rule: "Gameplay on a phone, any game" });
    await sorted(mobile.id);
    expect(inFolder(mobile.id)).toEqual(["d1", "m1*"]);

    await call("PATCH", `/api/library/lib_s/collections/${mobile.id}`, { rule: null });
    await sorted(mobile.id);
    expect(inFolder(mobile.id)).toEqual(["d1"]);
    expect((await data(call("GET", "/api/library/lib_s/collections"))).collections.find((c: any) => c.id === mobile.id).rule).toBeUndefined();
  });

  it("a clip described later goes in each smart folder it fits", async () => {
    const desk = await data(call("POST", "/api/library/lib_s/collections", { name: "Desktop", rule: "Gameplay recorded on a computer" }));
    await sorted(desk.id);
    seed("d2", "A desktop recording of a boss fight.");
    expect(await fileSmart(libraryDb(), "d2-v1", { username: "owner-s", role: "member" } as never, "")).toBe(1);
    expect(inFolder(desk.id)).toContain("d2*");
  });

  it("a saved search can't take a rule", async () => {
    const s = await data(call("POST", "/api/library/lib_s/collections", { name: "Search", kind: "smart", query: { q: "x" } }));
    expect((await call("PATCH", `/api/library/lib_s/collections/${s.id}`, { rule: "anything" })).status).toBe(409);
  });

  it("Reorganize keeps only ways with two folders that have a name and a rule, never Finals", () => {
    const ways = parseWays(
      JSON.stringify({
        ways: [
          { name: "By device", folders: [{ name: "Mobile", rule: "phone" }, { name: "Desktop", rule: "computer" }, { name: "Finals", rule: "x" }] },
          { name: "Too few", folders: [{ name: "One", rule: "only" }] },
          { name: "No rules", folders: [{ name: "A" }, { name: "B", rule: "" }] },
        ],
      }),
    );
    expect(ways).toEqual([{ name: "By device", folders: [{ name: "Mobile", rule: "phone" }, { name: "Desktop", rule: "computer" }] }]);
    expect(() => parseWays("{}")).toThrow();
  });

  it("the judge reads the picture as it is watched: a clip turned on its side is portrait", () => {
    const c = { id: "x", title: "x", kind: "video", what: null, description: null, tags: null, duration: 10, width: 1920, height: 1080, rotation: 90, turn: null };
    expect(clipText(c)).toContain("1080×1920 (1:1.78, portrait");
  });
});
