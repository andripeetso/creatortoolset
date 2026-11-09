import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Sharing the author's own post back from the phone: the sessions it could be, closest words first. Only the post lookup is mocked.
const dataDir = mkdtempSync(path.join(tmpdir(), "ws-own-"));
process.env.DATA_DIR = dataDir;

vi.mock("./instagram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./instagram")>()),
  findOwnPost: vi.fn(async (_u: unknown, shortcode: string) =>
    shortcode === "OWN123"
      ? { handle: "tinyacrobatics", post: { item: { shortcode, caption: "Puppies hanging upside down build grip and calm", takenAt: Date.now() } } }
      : null,
  ),
}));

const { Hono } = await import("hono");
const { workshopApp } = await import("./workshop");
const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "alex", role: "admin", cloud: true, off: [] });
  await next();
});
app.route("/api/workshop", workshopApp as never);
const post = (text: string) => app.request("/api/workshop/own-post", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });

let n = 0;
function seed(title: string, status: string, words: string) {
  const id = `cccccccc-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const sdir = path.join(dataDir, "workshop", "sessions", id);
  mkdirSync(path.join(sdir, "docs"), { recursive: true });
  writeFileSync(path.join(sdir, "meta.json"), JSON.stringify({ id, owner: "alex", title, query: "", status, sources: [], drafts: [], createdAt: 1, updatedAt: n }));
  writeFileSync(path.join(sdir, "docs", `${id}.json`), JSON.stringify({ id, sessionId: id, kind: "reel", title: "Reel", frameworkIds: [], versions: [], nextBlock: 2, nextVersion: 1, createdAt: 1, updatedAt: 1, blocks: [{ id: "b1", text: words, author: "user", at: 1 }] }));
  return id;
}

describe("own post shared back", () => {
  it("lists the sessions closest in words first, skips shelved ones; someone else's post is not own", async () => {
    const hanging = seed("HangingPuppies", "toPost", "Hanging upside down builds grip and calm in puppies");
    seed("Teeth", "editing", "Naps and mood in puppies");
    seed("Old", "shelved", "Hanging upside down puppies grip");
    const res = (await (await post("look https://www.instagram.com/reel/OWN123/?igsh=x")).json()) as { own: boolean; url: string; candidates: Array<{ id: string; title: string }> };
    expect(res.own).toBe(true);
    expect(res.url).toBe("https://www.instagram.com/p/OWN123/");
    expect(res.candidates[0]!.id).toBe(hanging);
    expect(res.candidates.map((c) => c.title)).not.toContain("Old");
    expect(await (await post("https://www.instagram.com/p/SOMEONE1/")).json()).toEqual({ own: false });
    expect(await (await post("no link here")).json()).toEqual({ own: false });
  });
});
