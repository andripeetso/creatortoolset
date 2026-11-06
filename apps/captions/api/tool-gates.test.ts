import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "tool-gates-"));
process.env.APP_SECRET = "tool-gates-test-secret";

const { TOOLS } = await import("../contracts/tools");
const { default: app, startupProblem, TOOL_GATES } = await import("./boot");
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
    expect(Object.keys(body).sort()).toEqual(["ok", "rssMb", "uptimeSec"]);
    expect(body.ok).toBe(true);
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
