import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A linked computer with no APP_SECRET: without a secret every request is the admin, so the tunnel must answer nothing.
// APP_SECRET is read once at import, so this runs in its own file, with the link state written straight to disk.
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "connect-nosecret-"));
process.env.APP_SECRET = "";
const HOST = "a".repeat(32) + ".tunnels.test.example";
mkdirSync(process.env.DATA_DIR, { recursive: true });
writeFileSync(
  path.join(process.env.DATA_DIR, "connect.json"),
  JSON.stringify({ brokerUrl: "https://broker.test", owner: "acct-1", localUser: "admin", computerId: "a".repeat(32), name: "test", origin: "http://127.0.0.1:3000", hostname: HOST, tunnelToken: "t", relayKid: "k", relayPublicKey: "", usedJti: {} }),
  { mode: 0o600 },
);

const app = (await import("../boot")).default;

describe("a linked computer with no APP_SECRET answers nothing on its tunnel", () => {
  it("refuses a tunnel request, even one that would otherwise be the admin", async () => {
    const res = await app.request(`https://${HOST}/api/auth/check`, { headers: { "cf-connecting-ip": "203.0.113.9", "cf-ray": "8f00-SIN" } }, {
      incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 50000, remoteFamily: "IPv4" } },
    });
    expect(res.status).toBe(403);
  });
});
