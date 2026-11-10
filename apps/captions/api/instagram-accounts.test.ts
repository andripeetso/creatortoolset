import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";

const dataDir = mkdtempSync(path.join(tmpdir(), "ig-accounts-"));
process.env.DATA_DIR = dataDir;
// a pull started here must not reach the network
vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));

const accountDir = (id: string) => path.join(dataDir, "instagram", "accounts", id);
const projectFile = (id: string) => path.join(dataDir, "workshop", "projects", `${id}.json`);
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf-8"));

function account(username: string, owner = "test", extra: Record<string, unknown> = {}): string {
  const id = randomUUID();
  mkdirSync(accountDir(id), { recursive: true });
  writeFileSync(
    path.join(accountDir(id), "meta.json"),
    JSON.stringify({ id, igUserId: "", username, owner, tags: [], counts: { fetchedAt: 0 }, status: "ready", progress: 1, createdAt: 1, updatedAt: 1, ...extra }),
  );
  return id;
}

function project(name: string, accountId: string): string {
  const id = randomUUID();
  mkdirSync(path.dirname(projectFile(id)), { recursive: true });
  writeFileSync(projectFile(id), JSON.stringify({ id, owner: "test", name, accountId, createdAt: 1, updatedAt: 1 }));
  return id;
}

// two brands, each project with its own account; neither record carries the stored "mine" flag
const acrobatics = account("tinyacrobatics");
const homes = account("tinyhomes");
const tinyProject = project("Tiny Acrobatics", acrobatics);
const homesProject = project("Tiny Homes", homes);
// in the library already, linked by no project
const fresh = account("tinyfresh");
// another person's copy of a handle this user does not have
const theirs = account("tinyother", "someone-else");

// an Apify key on file, so an add can start its pull at once (the pull itself fails on the stubbed network)
mkdirSync(path.join(dataDir, "instagram", "users", "test"), { recursive: true });
writeFileSync(
  path.join(dataDir, "instagram", "users", "test", "apify.json"),
  JSON.stringify({ token: "test-token", savedAt: 1, savedBy: "test", valid: true, source: "file" }),
);

const { instagramApp } = await import("./instagram");

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "test", role: "admin", cloud: true, off: [] });
  await next();
});
app.route("/", instagramApp);

type Row = { id: string; username: string; owner: string; mine?: boolean; own?: boolean };
const listed = async (projectId: string) => (await (await app.request(`/accounts?projectId=${projectId}`)).json()) as Row[];
const post = (url: string, body: unknown, method = "POST") =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("my account", () => {
  it("is the account its project links, in each project, without being told", async () => {
    expect((await listed(tinyProject)).filter((a) => a.own).map((a) => a.username)).toEqual(["tinyacrobatics"]);
    expect((await listed(homesProject)).filter((a) => a.own).map((a) => a.username)).toEqual(["tinyhomes"]);
    // the stored flag, which decides how an account is pulled, is not handed out with it
    expect((await listed(homesProject)).some((a) => a.mine)).toBe(false);
  });

  it("is set by typing the handle, in that one request, and the pull it starts keeps it", async () => {
    const res = await post("/accounts", { username: "@tinyfresh", mine: true, run: "now" });
    const body = (await res.json()) as Row;
    expect(body.id).toBe(fresh);
    expect(body).toMatchObject({ mine: true, own: true });
    // the pull saves the record it was handed: it must be the flagged one
    const stored = () => readJson(path.join(accountDir(fresh), "meta.json"));
    await vi.waitFor(() => expect(stored().status).toBe("processing"), { timeout: 10_000 });
    expect(stored().mine).toBe(true);
    await app.request(`/accounts/${fresh}`, { method: "DELETE" }); // ends the pull
  }, 15_000);

  it("is the user's own record, never another person's copy of the handle", async () => {
    const body = (await (await post("/accounts", { username: "@tinyother", mine: true, run: "later" })).json()) as Row;
    expect(body.owner).toBe("test");
    expect(body.id).not.toBe(theirs);
    expect(body).toMatchObject({ mine: true, own: true });
    expect(readJson(path.join(accountDir(theirs), "meta.json")).mine).toBeUndefined();
  });

  it("'not mine' takes the account off the project that had it", async () => {
    const body = (await (await post(`/accounts/${homes}`, { mine: false }, "PATCH")).json()) as Row;
    expect(body.own).toBeFalsy();
    expect(readJson(projectFile(homesProject)).accountId).toBeUndefined();
    // the other brand is untouched
    expect(readJson(projectFile(tinyProject)).accountId).toBe(acrobatics);
  });
});

describe("opening an account", () => {
  it("sends no Graph records or full captions, and has a small status to poll", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      shortcode: `TINY${i}`,
      url: `https://www.instagram.com/p/TINY${i}/`,
      kind: "reel",
      takenAt: 1_700_000_000_000 + i,
      captionPreview: `Sample ${i}`,
      caption: `Sample ${i} ${"about rolling and crawling ".repeat(40)}`,
      graph: { mediaUrl: `https://scontent.cdninstagram.com/v/${"x".repeat(900)}` },
      counts: { likes: i, plays: i * 10 },
    }));
    writeFileSync(path.join(accountDir(acrobatics), "catalog.json"), JSON.stringify(rows));

    const full = (await (await app.request(`/accounts/${acrobatics}`)).json()) as { own?: boolean; catalog: Array<Record<string, unknown>> };
    expect(full.own).toBe(true);
    expect(full.catalog).toHaveLength(40);
    expect(full.catalog.some((r) => "graph" in r || "caption" in r)).toBe(false);
    expect(full.catalog.find((r) => r.shortcode === "TINY0")?.captionPreview).toBe("Sample 0");
    // the stored catalog keeps both: the Workshop and the next pull read them
    expect(readJson(path.join(accountDir(acrobatics), "catalog.json"))[0].graph).toBeDefined();

    const status = await app.request(`/accounts/${acrobatics}/status`);
    expect(status.status).toBe(200);
    const text = await status.text();
    expect(text.length).toBeLessThan(2000);
    expect(JSON.parse(text)).toMatchObject({ id: acrobatics, status: "ready", own: true });
    expect(JSON.parse(text).catalog).toBeUndefined();
  });
});
