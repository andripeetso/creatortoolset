import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "ig-ideas-"));
process.env.DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const BRAND = "bbbbbbbb-0000-4000-8000-000000000001";
const POST = "aaaaaaaa-0000-4000-8000-000000000001";

// the Analyzer's AI is stood in for: it keeps what it was sent and answers one idea
const sent: string[] = [];
vi.mock("./ai-complete", async (real) => ({
  ...(await real<typeof import("./ai-complete")>()),
  anyAiConfigured: () => true,
  completeWithFallback: async (_system: string, user: string, _signal: unknown, parse: (t: string) => unknown) => {
    sent.push(user);
    return parse(JSON.stringify({ ideas: [{ title: "Rainy Day Tumbles", description: "Tumbles to do indoors.", postIds: [POST] }] }));
  },
}));
const { instagramApp } = await import("./instagram");

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "ana", role: "user", cloud: true, off: [] });
  await next();
});
app.route("/", instagramApp);

// a post in the library, as a finished pull leaves it
const url = "https://www.instagram.com/p/TINYTUMBLE1/";
mkdirSync(path.join(dataDir, "instagram", POST), { recursive: true });
writeFileSync(
  path.join(dataDir, "instagram", POST, "meta.json"),
  JSON.stringify({
    id: POST, owner: "ana", projectId: BRAND, status: "ready", progress: 1, input: url, url, shortcode: "TINYTUMBLE1", mediaId: "1", kind: "post", accountId: "aaaaaaaa-0000-4000-8000-000000000002",
    creator: { id: "1", username: "tinyacrobatics" }, takenAt: 1, caption: "Three tumbles for a rainy day",
    counts: { likes: 1, comments: 0, fetchedAt: 1 }, comments: { status: "skipped", count: 0, replies: 0 }, bytes: 0, createdAt: 1, updatedAt: 1,
    recipe: { preset: "watch", jobs: ["info", "stats", "transcript"] },
    jobs: [{ type: "info", status: "done" }, { type: "stats", status: "done" }, { type: "transcript", status: "done" }],
    slides: [{ index: 0, kind: "image", file: "", mime: "", width: 10, height: 10, bytes: 0, transcript: { status: "skipped" }, vision: { status: "skipped" } }],
    tags: [],
  }),
);

const board = async (body: object = {}) => {
  sent.length = 0;
  const r = await app.request("/ideas", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(r.status).toBe(200);
  expect(sent).toHaveLength(1);
  return sent[0]!;
};

describe("the idea board", () => {
  it("is told which brand the ideas are for; with no workspace it reads the catalog alone, as before", async () => {
    expect(await board()).toMatch(/^Catalog:\n\[aaaaaaaa-/);

    mkdirSync(path.join(dataDir, "workshop", "projects"), { recursive: true });
    const brand = { id: BRAND, owner: "ana", name: "Tiny Acrobatics", audience: "adult beginners", voice: "", cta: "", notes: "", createdAt: 1, updatedAt: 1 };
    writeFileSync(path.join(dataDir, "workshop", "projects", `${BRAND}.json`), JSON.stringify(brand));
    expect(await board({ projectId: BRAND })).toMatch(/^The workspace these ideas are for\.[^\n]*\nWorkspace: Tiny Acrobatics\nAudience: adult beginners\n\nCatalog:\n\[aaaaaaaa-/);
  });
});
