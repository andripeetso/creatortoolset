import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// /api/auth/check tells the web whether this server is hosted (teams, admin, view-as, join links). It is read per
// request, so one file can switch CT_MODE between its cases.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "auth-check-"));
delete process.env.APP_SECRET;

const { default: app } = await import("./boot");

const check = async () => (await app.request("/api/auth/check")).json() as Promise<{ hosted: boolean; viewedBy: string | null }>;

describe("/api/auth/check hosted flag", () => {
  it("reports a local server as not hosted, with no view-as", async () => {
    delete process.env.CT_MODE;
    const d = await check();
    expect(d.hosted).toBe(false);
    expect(d.viewedBy).toBeNull();
  });

  it("reports CT_MODE=hosted as hosted", async () => {
    process.env.CT_MODE = "hosted";
    const d = await check();
    expect(d.hosted).toBe(true);
    expect(d.viewedBy).toBeNull();
    delete process.env.CT_MODE;
  });
});
