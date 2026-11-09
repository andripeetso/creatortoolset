import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AuthVars } from "./auth";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "exports-finals-"));
const { exportsApp } = await import("./exports");

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "tiny-owner", role: "user", cloud: true, off: [] } as never);
  await next();
});
app.route("/", exportsApp);

const burn = (width: number, height: number) =>
  app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "burn", format: "h264", name: "Tiny", duration: 10, width, height, fps: 25,
      projectId: "project-1", clipId: "clip-1", engine: "native", ass: "[Script Info]", finals: true,
    }),
  });

describe("export: Send to Finals", () => {
  it("never accepts a render below 1080p (a 540×960 AI Editor preview went out, 2026-10-02)", async () => {
    const small = await burn(540, 960);
    expect(small.status).toBe(409);
    expect(((await small.json()) as { error: string }).error).toMatch(/540×960, below 1080p/);
  });

  it("accepts a full-size render for Finals (the request then needs its source, which this test has not made)", async () => {
    const full = await burn(1920, 1080);
    expect(((await full.json()) as { error?: string }).error ?? "").not.toMatch(/below 1080p/);
  });
});
