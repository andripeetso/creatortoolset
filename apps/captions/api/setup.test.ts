import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "setup-"));
process.env.APP_SECRET = "test-secret";
const { setupApp } = await import("./setup");
const { saveMyKey } = await import("./my-keys");
const { pairDevice, saveReport } = await import("./lib/devices");
import type { AuthVars } from "./auth";
import type { SessionUser } from "./users";

let who: SessionUser = { username: "sam", role: "user", cloud: true, off: [] };
const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", who);
  await next();
});
app.route("/api/setup", setupApp);
const get = async () => (await (await app.request("/api/setup")).json()) as { have: string[]; detected: string | null };
const put = (body: unknown) => app.request("/api/setup", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("setup: my tools, my plan, what is set up", () => {
  it("starts unasked, keeps the tools in home order and the plan, refuses junk", async () => {
    expect(await get()).toMatchObject({ tools: null, plan: null, detected: null, done: false, have: [] });
    expect((await put({ tools: ["editor", "workshop"] })).status).toBe(200);
    expect((await put({ tools: ["nope"] })).status).toBe(400);
    expect((await put({ plan: "claude_ultra" })).status).toBe(400);
    expect((await put({ plan: "claude_pro", done: true })).status).toBe(200);
    expect(await get()).toMatchObject({ tools: ["workshop", "editor"], plan: "claude_pro", done: true });
  });

  it("sees a key the person added, and the plan their Mac's CLI reports", async () => {
    saveMyKey("sam", "NVIDIA_API_KEY", "nv-test-1234");
    const { device } = pairDevice("sam", "Studio Mac");
    saveReport(device.id, { at: Date.now(), drivers: [{ driver: "claude", installed: true, signedIn: true, plan: "max default_claude_max_20x" }], homes: [] });
    const v = await get();
    expect(v.have).toContain("NVIDIA_API_KEY");
    expect(v.detected).toBe("claude_max20");
  });

  it("is for accounts only", async () => {
    who = { username: "guest-0123456789ab", role: "guest", cloud: false, off: [] };
    expect((await app.request("/api/setup")).status).toBe(403);
    who = { username: "demo-0123456789ab", role: "user", cloud: true, off: [], demo: "demo" };
    expect((await put({ done: true })).status).toBe(403);
  });
});
