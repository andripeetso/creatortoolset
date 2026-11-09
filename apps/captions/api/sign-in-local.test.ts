import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// On one person's Mac (CT_MODE unset) the site sign-in and identity unlink don't exist: sign-in.test.ts sets CT_MODE=hosted.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "sign-in-local-"));
process.env.APP_SECRET = "sign-in-local-test-secret";
delete process.env.CT_MODE;

const app = (await import("./boot")).default;

describe("sign-in is hosted-only", () => {
  it("does not start a site sign-in: the route falls to the account gate, not the provider", async () => {
    const res = await app.request("/api/account/login/google?for=site");
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not answer the provider callbacks with a sign-in", async () => {
    const google = await app.request("/api/auth/google/callback?state=x&code=x");
    expect([400, 404]).toContain(google.status);
    const apple = await app.request("/api/auth/apple/callback", { method: "POST" });
    expect([400, 404]).toContain(apple.status);
  });

  it("does not mount identity unlink", async () => {
    expect((await app.request("/api/auth/identity/google", { method: "DELETE" })).status).toBe(404);
  });
});
