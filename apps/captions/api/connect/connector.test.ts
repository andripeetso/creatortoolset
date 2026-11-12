import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The connector runs a stand-in for cloudflared: a shell script that logs its start (and its token from the environment)
// and then sleeps. That exercises the real spawn, kill, restart and stop paths without the network.
const scratch = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "connector-"));
process.env.DATA_DIR = path.join(scratch, "data");
mkdirSync(process.env.DATA_DIR, { recursive: true });
const log = path.join(scratch, "starts.log");
const fake = path.join(scratch, "cloudflared");
writeFileSync(fake, `#!/bin/sh\necho "$TUNNEL_TOKEN $$" >> "${log}"\nexec sleep 60\n`);
chmodSync(fake, 0o755);
process.env.CT_CLOUDFLARED_PATH = fake;

const statePath = path.join(process.env.DATA_DIR, "connect.json");
writeFileSync(
  statePath,
  JSON.stringify({ brokerUrl: "https://broker.test", owner: "acct-1", localUser: "admin", computerId: "a".repeat(32), name: "test", origin: "http://127.0.0.1:3000", hostname: "a".repeat(32) + ".tunnels.test.example", tunnelToken: "secret-tunnel-token", relayKid: "k", relayPublicKey: "", usedJti: {} }),
  { mode: 0o600 },
);

const { PINNED, ensureCloudflared, installVerified, startConnector, stopConnector, unlinkConnector, connectorStatus } = await import("./connector");
const { connectState } = await import("./state");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 6_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(50);
  }
}
const starts = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);

afterAll(async () => {
  await stopConnector();
});

describe("pinned cloudflared", () => {
  it("pins a 64-hex SHA-256 for every supported platform", () => {
    for (const pin of Object.values(PINNED)) expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(PINNED).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
  });

  it("refuses bytes that do not match the pin, and installs nothing", async () => {
    const dest = path.join(scratch, "bad", "cloudflared");
    const pin = { file: "x", sha256: "0".repeat(64), tgz: false };
    await expect(installVerified(Buffer.from("not cloudflared"), pin, dest)).rejects.toThrow("checksum mismatch");
    expect(existsSync(dest)).toBe(false);
  });

  it("installs bytes that match the pin, executable", async () => {
    const bytes = Buffer.from("#!/bin/sh\nexit 0\n");
    const pin = { file: "x", sha256: createHash("sha256").update(bytes).digest("hex"), tgz: false };
    const dest = path.join(scratch, "good", "cloudflared");
    await installVerified(bytes, pin, dest);
    expect(readFileSync(dest, "utf8")).toBe(bytes.toString());
    expect(existsSync(dest)).toBe(true);
  });

  it("refuses a download that does not match, and never stores it", async () => {
    const fetchBad = (async () => new Response("tampered")) as unknown as typeof fetch;
    // this platform's real pin: the tampered bytes must not pass
    delete process.env.CT_CLOUDFLARED_PATH;
    try {
      await expect(ensureCloudflared(fetchBad)).rejects.toThrow("checksum mismatch");
    } finally {
      process.env.CT_CLOUDFLARED_PATH = fake;
    }
  });

  it("refuses an override path that does not exist", async () => {
    process.env.CT_CLOUDFLARED_PATH = path.join(scratch, "missing");
    try {
      await expect(ensureCloudflared()).rejects.toThrow("does not exist");
    } finally {
      process.env.CT_CLOUDFLARED_PATH = fake;
    }
  });
});

describe("the tunnel process", () => {
  beforeAll(() => {
    expect(connectState()?.tunnelToken).toBe("secret-tunnel-token");
  });

  it("starts cloudflared with the tunnel token in the environment", async () => {
    startConnector();
    await until(() => starts().length === 1);
    expect(starts()[0]).toMatch(/^secret-tunnel-token \d+$/);
    expect(connectorStatus()).toMatchObject({ running: true, starts: 1 });
  });

  it("restarts it after a kill", async () => {
    const pid = connectorStatus().pid;
    expect(pid).not.toBeNull();
    process.kill(pid!, "SIGKILL");
    await until(() => starts().length === 2);
    expect(connectorStatus().running).toBe(true);
  });

  it("stops cloudflared when the server itself is told to stop (SIGTERM), then lets the signal end the server", async () => {
    const pid = connectorStatus().pid!;
    // the listener the connector added (the last one), called as the signal would; its re-raise is not carried out here
    const onTerm = process.listeners("SIGTERM").at(-1) as () => void;
    const own = vi.spyOn(process, "kill").mockImplementationOnce(() => true);
    onTerm();
    expect(own).toHaveBeenCalledWith(process.pid, "SIGTERM");
    own.mockRestore();
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  it("stops cleanly and does not restart", async () => {
    await stopConnector();
    const count = starts().length;
    await sleep(1_500);
    expect(starts().length).toBe(count);
    expect(connectorStatus()).toMatchObject({ running: false, pid: null });
  });

  it("unlink stops the tunnel and removes the token from disk", async () => {
    startConnector();
    await until(() => connectorStatus().running);
    await unlinkConnector();
    expect(connectState()).toBeNull();
    expect(existsSync(statePath)).toBe(false);
    expect(connectorStatus().running).toBe(false);
  });

  it("does nothing on a computer that is not linked", async () => {
    const before = starts().length;
    startConnector();
    await sleep(100);
    expect(starts().length).toBe(before);
  });
});
