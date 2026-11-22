import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// /api/auth/check tells the web whether this server is hosted (teams, admin, view-as, join links). It is read per
// request, so one file can switch CT_SERVER between its cases.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "auth-check-"));
delete process.env.APP_SECRET;

const { default: app } = await import("./boot");

const check = async () => (await app.request("/api/auth/check")).json() as Promise<{ kind: string; viewedBy: string | null }>;

describe("/api/auth/check server kind", () => {
  it("reports This Mac, with no view-as", async () => {
    process.env.CT_SERVER = "mac";
    const d = await check();
    expect(d.kind).toBe("mac");
    expect(d.viewedBy).toBeNull();
  });

  it("reports CT_MODE=hosted as a Server", async () => {
    delete process.env.CT_SERVER;
    process.env.CT_MODE = "hosted";
    const d = await check();
    expect(d.kind).toBe("server");
    expect(d.viewedBy).toBeNull();
    delete process.env.CT_MODE;
  });
});
