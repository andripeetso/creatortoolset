import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AuthVars } from "./auth";

// Save to Content, an older path, now Finals (review.ts and exports.ts): the routes answer for what is not there.
// The 409 "Mark it captioned" branch needs a real Review version and is not covered here.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "review-content-"));
const { reviewApp } = await import("./review");
const { exportsApp } = await import("./exports");

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "tiny-owner", role: "user", cloud: false, off: [] } as never);
  await next();
});
app.route("/api/review", reviewApp);
app.route("/api/exports", exportsApp);

const post = (url: string) => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

describe("Save to Content (an older path, Finals underneath)", () => {
  it("answers a Review version's content route with 404 for a version that is not there", async () => {
    expect((await post("/api/review/assets/00000000-0000-4000-8000-000000000000/v/1/content")).status).toBe(404);
  });

  it("answers an export's content route with 404 for an export that is not there", async () => {
    expect((await post("/api/exports/no-such-export/content")).status).toBe(404);
  });
});
