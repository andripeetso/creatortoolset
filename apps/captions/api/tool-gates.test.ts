import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "tool-gates-"));
process.env.APP_SECRET = "tool-gates-test-secret";

const { TOOLS } = await import("../contracts/tools");
const { default: app, startupProblem, TOOL_GATES, exitWithParent } = await import("./boot");
const { env } = await import("./lib/env");

// Apps with no entry in TOOL_GATES, and why. Each one is either hidden in the
// app only, or checked by the API it belongs to (boot.ts comment above TOOL_GATES).
const UNGATED: Record<string, string> = {
  captions: "the base app, hidden in the app only (no API checks a switch)",
  review: "hidden in the app only; Review's own routes serve share links and the AI key",
  notes: "hidden in the app only; Review and Guides play Video Notes",
  guides: "hidden in the app only; its APIs serve each other",
  stories: "hidden in the app only (no API checks a switch)",
};

describe("tool gates", () => {
  it("gates or explains every TOOLS entry, once", () => {
    for (const tool of TOOLS) {
      const gated = TOOL_GATES.some(([, tools]) => tools.includes(tool));
      const reason = UNGATED[tool];
      expect(gated !== (reason !== undefined), `${tool}: gate it in TOOL_GATES or list it in UNGATED with a reason`).toBe(true);
      if (reason !== undefined) expect(reason.length).toBeGreaterThan(10);
    }
    for (const tool of Object.keys(UNGATED)) expect(TOOLS).toContain(tool);
  });

  it("only names real tools, and every gated prefix is mounted", () => {
    const paths = app.routes.map((r) => r.path);
    for (const [prefix, tools] of TOOL_GATES) {
      expect(tools.every((t) => (TOOLS as readonly string[]).includes(t))).toBe(true);
      expect(paths.some((p) => p === prefix || p.startsWith(prefix + "/")), `${prefix} is not mounted`).toBe(true);
    }
  });
});

describe("boot", () => {
  it("answers /api/health without an account, with no user or secret data", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["environment", "ok", "rssMb", "uptimeSec"]);
    expect(body.ok).toBe(true);
    // the data folder's own id, made once and kept
    const file = JSON.parse(readFileSync(path.join(process.env.DATA_DIR!, "environment.json"), "utf8"));
    expect(body.environment).toBe(file.id);
    const again = (await (await app.request("/api/health")).json()) as Record<string, unknown>;
    expect(again.environment).toBe(body.environment);
  });

  it("with CT_LOCAL=1 answers only requests addressed to this machine", async () => {
    const status = async (url: string) => (await app.request(url)).status;
    expect(await status("http://evil.example/api/health")).toBe(200);
    process.env.CT_LOCAL = "1";
    process.env.PUBLIC_ORIGIN = "https://mac.tinyacrobatics.example";
    try {
      expect(await status("http://evil.example/api/health")).toBe(400);
      expect(await status("http://evil.example/")).toBe(400);
      expect(await status("http://127.0.0.1:43128/api/health")).toBe(200);
      expect(await status("http://localhost:43128/api/health")).toBe(200);
      expect(await status("http://[::1]:43128/api/health")).toBe(200);
      expect(await status("https://mac.tinyacrobatics.example/api/health")).toBe(200);
      // a form or text/plain POST from another local web server carries the cookie (same site): refused by its Origin
      const post = async (origin?: string, extra: Record<string, string> = {}) =>
        (await app.request("http://127.0.0.1:43128/api/auth/logout", { method: "POST", headers: { ...(origin ? { origin } : {}), ...extra } })).status;
      expect(await post("http://127.0.0.1:3000")).toBe(403);
      expect(await post("null")).toBe(403);
      expect(await post("http://127.0.0.1:43128")).toBe(200);
      expect(await post("https://mac.tinyacrobatics.example")).toBe(200);
      expect(await post()).toBe(200);
      expect(await post("http://127.0.0.1:3000", { authorization: "Bearer ctk_x" })).not.toBe(403);
    } finally {
      delete process.env.CT_LOCAL;
      delete process.env.PUBLIC_ORIGIN;
    }
  });

  it("marks the sign-in cookie Secure only when the request came in over HTTPS", async () => {
    const cookie = async (url: string, headers: Record<string, string> = {}) =>
      (await app.request(url, { method: "POST", headers })).headers.get("set-cookie")!;
    expect(await cookie("http://10.0.0.20:43128/api/auth/guest")).not.toMatch(/Secure/);
    expect(await cookie("https://tools.example.com/api/auth/guest")).toMatch(/; Secure/);
    expect(await cookie("http://app:3000/api/auth/guest", { "x-forwarded-proto": "https" })).toMatch(/; Secure/);
    expect(await cookie("http://app:3000/api/auth/logout", { "x-forwarded-proto": "http" })).not.toMatch(/Secure/);
  });

  it("CT_EXIT_WITH_PARENT: exits once stdin closes", () => {
    const stdin = new PassThrough();
    const exit = vi.fn();
    exitWithParent(stdin, exit);
    expect(exit).not.toHaveBeenCalled();
    stdin.end();
    return new Promise<void>((resolve) => setImmediate(() => {
      expect(exit).toHaveBeenCalled();
      resolve();
    }));
  });

  it("refuses to start in production without APP_SECRET, and only then", () => {
    const saved = { isProduction: env.isProduction, appSecret: env.appSecret };
    try {
      env.isProduction = true;
      env.appSecret = "";
      expect(startupProblem()).toMatch(/APP_SECRET/);
      env.appSecret = "set";
      expect(startupProblem()).toBeNull();
      env.isProduction = false;
      env.appSecret = "";
      expect(startupProblem()).toBeNull();
    } finally {
      Object.assign(env, saved);
    }
  });
});
