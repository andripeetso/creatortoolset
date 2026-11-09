import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// A session's postings: several Instagram posts, each optionally naming the version it is, and one post description per version
// of a document. Pasted links are stored as given; no network read happens here.
const dataDir = mkdtempSync(path.join(tmpdir(), "ws-postings-"));
process.env.DATA_DIR = dataDir;

const { Hono } = await import("hono");
const { workshopApp } = await import("./workshop");
const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "tiny", role: "admin", cloud: true, off: [] });
  await next();
});
app.route("/api/workshop", workshopApp as never);

const SESSION = "dddddddd-0000-4000-8000-000000000001";
const DOC = "dddddddd-0000-4000-8000-000000000002";
function seed(meta: Record<string, unknown> = {}) {
  const sdir = path.join(dataDir, "workshop", "sessions", SESSION);
  mkdirSync(path.join(sdir, "docs"), { recursive: true });
  writeFileSync(path.join(sdir, "meta.json"), JSON.stringify({ id: SESSION, owner: "tiny", title: "TinyStory", query: "", status: "editing", sources: [], drafts: [], createdAt: 1, updatedAt: 1, ...meta }));
  writeFileSync(
    path.join(sdir, "docs", `${DOC}.json`),
    JSON.stringify({ id: DOC, sessionId: SESSION, kind: "reel", title: "Reel", frameworkIds: [], versions: [], nextBlock: 2, nextVersion: 1, createdAt: 1, updatedAt: 1, blocks: [{ id: "b1", text: "Words", author: "user", at: 1 }] }),
  );
}
const patch = (body: unknown) => app.request(`/api/workshop/sessions/${SESSION}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const patchDoc = (body: unknown) => app.request(`/api/workshop/sessions/${SESSION}/docs/${DOC}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const A = "https://www.instagram.com/p/DfdJozjPjT2/";
const B = "https://www.instagram.com/p/DfdJu8-v6tq/";

beforeEach(() => {
  seed();
});

describe("postings: several posts per session", () => {
  it("a pasted link is added to the list, and `posted` stays the first", async () => {
    const res = (await (await patch({ posted: A })).json()) as { postings: Array<{ shortcode: string; by: string }>; posted: { shortcode: string }; status: string };
    expect(res.postings).toEqual([expect.objectContaining({ shortcode: "DfdJozjPjT2", by: "you" })]);
    expect(res.posted.shortcode).toBe("DfdJozjPjT2");
    expect(res.status).toBe("published");
  });

  it("a second post is added beside the first, and each can name its version", async () => {
    await patch({ posted: { url: A, version: "2294" } });
    const res = (await (await patch({ posted: { url: B, version: "2296" } })).json()) as { postings: Array<{ shortcode: string; version?: string }>; posted: { shortcode: string } };
    expect(res.postings.map((p) => [p.shortcode, p.version])).toEqual([
      ["DfdJozjPjT2", "2294"],
      ["DfdJu8-v6tq", "2296"],
    ]);
    expect(res.posted.shortcode).toBe("DfdJozjPjT2");
  });

  it("naming a version on a post already listed changes it in place and keeps its place in the list", async () => {
    await patch({ posted: A });
    await patch({ posted: B });
    const res = (await (await patch({ posted: { url: A, version: "2294" } })).json()) as { postings: Array<{ shortcode: string; version?: string }> };
    expect(res.postings.map((p) => [p.shortcode, p.version])).toEqual([
      ["DfdJozjPjT2", "2294"],
      ["DfdJu8-v6tq", undefined],
    ]);
    // a re-paste without a version keeps the one it had
    const again = (await (await patch({ posted: A })).json()) as { postings: Array<{ version?: string }> };
    expect(again.postings[0]!.version).toBe("2294");
  });

  it("a version that is not a plain id is refused", async () => {
    const res = await patch({ posted: { url: A, version: "../x" } });
    expect(res.status).toBe(400);
  });

  it("'not this post' on one takes only that one off, and it is never matched again", async () => {
    await patch({ posted: A });
    await patch({ posted: B });
    const res = (await (await patch({ posted: { remove: "DfdJozjPjT2" } })).json()) as { postings: Array<{ shortcode: string }>; postedNot?: string[]; posted: { shortcode: string } };
    expect(res.postings.map((p) => p.shortcode)).toEqual(["DfdJu8-v6tq"]);
    expect(res.posted.shortcode).toBe("DfdJu8-v6tq");
    expect(res.postedNot).toEqual(["DfdJozjPjT2"]);
  });

  it("null takes every posting off, and each is marked not this session's", async () => {
    await patch({ posted: A });
    await patch({ posted: B });
    const res = (await (await patch({ posted: null })).json()) as { postings?: unknown[]; posted?: unknown; postedNot?: string[] };
    expect(res.postings).toBeUndefined();
    expect(res.posted).toBeUndefined();
    expect(res.postedNot?.sort()).toEqual(["DfdJozjPjT2", "DfdJu8-v6tq"]);
  });

  it("a session saved with only `posted` (before postings) still reads as one posting", async () => {
    seed({ status: "published", posted: { shortcode: "OLDPOST1", url: "https://www.instagram.com/p/OLDPOST1/", by: "auto", at: 1 } });
    const res = (await (await patch({ title: "Old, renamed" })).json()) as { postings?: unknown; posted: { shortcode: string } };
    expect(res.postings).toBeUndefined();
    expect(res.posted.shortcode).toBe("OLDPOST1");
    const added = (await (await patch({ posted: B })).json()) as { postings: Array<{ shortcode: string }> };
    expect(added.postings.map((p) => p.shortcode)).toEqual(["OLDPOST1", "DfdJu8-v6tq"]);
  });
});

describe("post description per version", () => {
  it("a version's own description is saved beside the main one; an empty one clears it and the main stays", async () => {
    await patchDoc({ caption: "The main one." });
    const set = (await (await patchDoc({ captions: { "2294": "For the calm cut." } })).json()) as { caption: { text: string }; captions: Record<string, { text: string; author: string }> };
    expect(set.caption.text).toBe("The main one.");
    expect(set.captions["2294"]).toEqual(expect.objectContaining({ text: "For the calm cut.", author: "user" }));

    const cleared = (await (await patchDoc({ captions: { "2294": "  " } })).json()) as { captions?: unknown; caption: { text: string } };
    expect(cleared.captions).toBeUndefined();
    expect(cleared.caption.text).toBe("The main one.");
  });

  it("only version keys are kept", async () => {
    const res = (await (await patchDoc({ captions: { "2294": "ok", "../bad": "no" } })).json()) as { captions: Record<string, unknown> };
    expect(Object.keys(res.captions)).toEqual(["2294"]);
  });
});
