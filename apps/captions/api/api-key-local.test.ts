import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// a solo install: no APP_SECRET, so no sign-in and no account record until the first key
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "api-key-local-"));
delete process.env.APP_SECRET;

const app = (await import("./boot")).default;

describe("AI access keys on a solo install (no sign-in)", () => {
  it("lists none, makes one, and lists its last four", async () => {
    expect(await (await app.request("/api/auth/api-key")).json()).toEqual({ review: null, full: null, ai: [] });

    const made = await app.request("/api/auth/api-key", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(made.status).toBe(200);
    const { key } = (await made.json()) as { key: string };
    expect(key).toMatch(/^ctk_/);

    const listed = (await (await app.request("/api/auth/api-key")).json()) as { review: { last4: string } | null };
    expect(listed.review?.last4).toBe(key.slice(-4));
    expect(JSON.stringify(listed)).not.toContain(key);
  });
});
