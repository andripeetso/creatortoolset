import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "connect-state-"));
const { consumeJti, saveConnectState } = await import("./state");

describe("connect.json", () => {
  it("is replaced whole on each save (a new file swapped in), never written over in place", () => {
    const file = path.join(process.env.DATA_DIR!, "connect.json");
    saveConnectState({
      brokerUrl: "https://broker.example", owner: "acct-1", localUser: "admin", computerId: "a".repeat(32), name: "Studio Mac",
      origin: "http://127.0.0.1:43128", hostname: "a.tunnels.example", tunnelToken: "tok", relayKid: "k1", relayPublicKey: "pk", usedJti: {},
    });
    const first = statSync(file);
    expect(first.mode & 0o777).toBe(0o600);
    expect(consumeJti("j1", 4_000_000_000, 1)).toBe(true);
    const second = statSync(file);
    // a crash while writing leaves the old file whole: the write went to another inode, renamed over it
    expect(second.ino).not.toBe(first.ino);
    expect(second.mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).usedJti).toEqual({ j1: 4_000_000_000 });
    expect(readdirSync(process.env.DATA_DIR!).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(consumeJti("j1", 4_000_000_000, 2)).toBe(false);
  });
});
