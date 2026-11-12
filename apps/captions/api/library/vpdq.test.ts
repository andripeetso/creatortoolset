import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parsePdq, runFingerprintTool } from "./vpdq";

describe("the PDQ tool", () => {
  it("reads a hash line and refuses anything else", () => {
    expect(parsePdq(`${"a".repeat(64)},50,before.ppm\n`)).toEqual({ hash: "a".repeat(64), quality: 50 });
    expect(() => parsePdq(`${"a".repeat(64)},101,before.ppm`)).toThrow();
    expect(() => parsePdq("could not decode")).toThrow();
  });

  it("stops a program that stalls", async () => {
    await expect(runFingerprintTool(process.execPath, ["-e", "setInterval(() => {}, 1000)"], undefined, 50)).rejects.toThrow("timed out");
  });

  it.skipIf(process.platform === "win32")("an abort ends the program and the program it started", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vpdq-cancel-"));
    const file = path.join(dir, "pids");
    const controller = new AbortController();
    const outcome = Promise.allSettled([
      runFingerprintTool(
        process.execPath,
        ["-e", "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(process.argv[1],JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)", file],
        undefined,
        30_000,
        controller.signal,
      ),
    ]);
    try {
      await vi.waitFor(() => expect(existsSync(file)).toBe(true));
      const pids: number[] = JSON.parse(await readFile(file, "utf8"));
      controller.abort();
      expect((await outcome)[0]).toMatchObject({ status: "rejected", reason: { name: "AbortError" } });
      await vi.waitFor(() => {
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      });
    } finally {
      controller.abort();
      await outcome;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
