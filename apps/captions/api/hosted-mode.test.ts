import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Local mode (the default, one person's Mac): no CT_MODE, no APP_SECRET. The hosted-only routes must not exist.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "hosted-local-"));
delete process.env.CT_MODE;
delete process.env.APP_SECRET;

const { default: app } = await import("./boot");

const HOSTED_ROUTES = ["/api/admin", "/api/workspace", "/api/auth/invite"];
const mounted = (prefix: string) => app.routes.some((r) => r.path === prefix || r.path.startsWith(prefix + "/"));

describe("local mode", () => {
  it("mounts no admin, team or invite routes", () => {
    for (const prefix of HOSTED_ROUTES) expect(mounted(prefix), prefix).toBe(false);
  });

  it("answers the hosted routes with 404", async () => {
    expect((await app.request("/api/admin/users")).status).toBe(404);
    expect((await app.request("/api/admin/view-as/someone", { method: "POST" })).status).toBe(404);
    expect((await app.request("/api/workspace")).status).toBe(404);
    expect((await app.request("/api/auth/invite/" + "a".repeat(40))).status).toBe(404);
  });

  it("keeps the library grant routes, which every mode has", () => {
    expect(app.routes.some((r) => r.path === "/api/library/collections/:id/grants" && r.method === "GET")).toBe(true);
  });
});
