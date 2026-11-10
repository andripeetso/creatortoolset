import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";

const dataDir = mkdtempSync(path.join(tmpdir(), "ig-retry-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = ""; // background work runs as the local user

const asked: string[] = [];
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: unknown) => {
    asked.push(String(input));
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { "content-type": "image/jpeg" } });
  }),
);

const postDir = (id: string) => path.join(dataDir, "instagram", id);
const mediaUrl = (code: string) => `https://scontent.cdninstagram.com/v/${code}.jpg`;

/** A saved post whose download failed on the network: info and stats are in, the media is not. */
function failedPost(code: string, extra: Record<string, unknown> = {}): string {
  const id = randomUUID();
  const url = `https://www.instagram.com/p/${code}/`;
  const error = "Download failed: fetch failed (ETIMEDOUT)";
  mkdirSync(postDir(id), { recursive: true });
  writeFileSync(
    path.join(postDir(id), "meta.json"),
    JSON.stringify({
      id,
      owner: "local",
      status: "error",
      progress: 0.1,
      error,
      input: url,
      url,
      shortcode: code,
      mediaId: "1",
      kind: "post",
      creator: { id: "1", username: "tinyacrobatics" },
      takenAt: 1,
      caption: "A sample post",
      counts: { likes: 1, comments: 0, fetchedAt: 1 },
      comments: { status: "skipped", count: 0, replies: 0 },
      bytes: 0,
      createdAt: 1,
      updatedAt: 1,
      recipe: { preset: "watch", jobs: ["info", "stats", "media"] },
      jobs: [
        { type: "info", status: "done" },
        { type: "stats", status: "done" },
        { type: "media", status: "error", error },
      ],
      slides: [{ index: 0, kind: "image", file: "", mime: "", width: 10, height: 10, bytes: 0, transcript: { status: "skipped" }, vision: { status: "skipped" } }],
      tags: [],
      ...extra,
    }),
  );
  // what the first read kept: the media link is still good, so nothing has to be read again
  writeFileSync(path.join(postDir(id), "info.json"), JSON.stringify({ shortCode: code, type: "Image", url, displayUrl: mediaUrl(code), ownerUsername: "tinyacrobatics" }));
  return id;
}

const waiting = failedPost("TINYWAIT1");
const spent = failedPost("TINYSPENT1", { autoRetries: 3 });

mkdirSync(path.join(dataDir, "instagram", "users", "local"), { recursive: true });
writeFileSync(
  path.join(dataDir, "instagram", "users", "local", "apify.json"),
  JSON.stringify({ token: "test-token", savedAt: 1, savedBy: "local", valid: true, source: "file" }),
);

const { instagramApp } = await import("./instagram");

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "local", role: "admin", cloud: true, off: [] });
  await next();
});
app.route("/", instagramApp);

describe("a download that failed on the network", () => {
  it("is tried again by itself, a few times and no more", async () => {
    // the server's start-up pass picks up what failed before
    await vi.waitFor(() => expect(asked).toContain(mediaUrl("TINYWAIT1")), { timeout: 15_000, interval: 100 });
    expect(asked).not.toContain(mediaUrl("TINYSPENT1"));
    expect(JSON.parse(readFileSync(path.join(postDir(spent), "meta.json"), "utf-8")).status).toBe("error");
    // only the media was asked for: the kept link was used, the post was not read again
    expect(asked.filter((u) => u.includes("apify"))).toEqual([]);
    void waiting;
  }, 20_000);

  it("gets its automatic tries back after a Retry by hand", async () => {
    const res = await app.request(`/${spent}/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { autoRetries?: number }).autoRetries).toBeUndefined();
  });
});
