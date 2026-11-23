import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "clips-stop-"));
process.env.DATA_DIR = dataDir;
delete process.env.DEEPGRAM_API_KEY;
// on Cloud with no computer a note waits, processing, for one: the run Stop ends
process.env.CT_LOCAL = "1";
process.env.CT_SERVER = "cloud";
afterAll(() => {
  delete process.env.CT_LOCAL;
  delete process.env.CT_SERVER;
  rmSync(dataDir, { recursive: true, force: true });
});

const { clipsApp, recordingPath } = await import("./clips");
await import("./work/task-kinds");

const as = (username: string) => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", async (c, next) => {
    c.set("user", { username, role: "user", cloud: true, off: [] });
    await next();
  });
  return app.route("/api/clips", clipsApp);
};
const ana = as("ana");

describe("Video Notes Stop", () => {
  it("ends a note being made as Stopped and keeps its recording; another account gets 404", async () => {
    const { id } = (await (await ana.request("/api/clips?name=Walk&mime=audio/wav", { method: "POST", body: new Uint8Array(64) })).json()) as { id: string };
    await vi.waitFor(async () => expect(((await (await ana.request(`/api/clips/${id}`)).json()) as { status: string }).status).toBe("processing"));
    expect((await as("bo").request(`/api/clips/${id}/stop`, { method: "POST" })).status).toBe(404);
    expect(await (await ana.request(`/api/clips/${id}/stop`, { method: "POST" })).json()).toEqual({ ok: true });
    expect(await (await ana.request(`/api/clips/${id}`)).json()).toMatchObject({ status: "error", error: "Stopped" });
    expect(existsSync(recordingPath(id))).toBe(true);
    // nothing running: still ok
    expect((await ana.request(`/api/clips/${id}/stop`, { method: "POST" })).status).toBe(200);
  });
});
