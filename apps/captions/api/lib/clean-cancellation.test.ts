import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { run } from "./clean-media";
import { runFingerprintTool } from "./clean-fingerprints";
describe("native work cancellation", () => {
  it("waits for a rendering process to exit before releasing its caller", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "clean-cancel-")),
      file = path.join(dir, "pid");
    const controller = new AbortController();
    const pending = run(
      process.execPath,
      [
        "-e",
        "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",
        file,
      ],
      controller.signal,
    );
    const outcome = Promise.allSettled([pending]);
    try {
      await vi.waitFor(() => expect(existsSync(file)).toBe(true));
      const pid = Number(await readFile(file, "utf8"));
      controller.abort();
      expect((await outcome)[0]).toMatchObject({
        status: "rejected",
        reason: { name: "AbortError" },
      });
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort();
      await outcome;
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform === "win32")(
    "cancels the fingerprint process group including its decoder subprocess",
    async () => {
      const dir = await mkdtemp(
          path.join(tmpdir(), "clean-fingerprint-cancel-"),
        ),
        file = path.join(dir, "pids");
      const controller = new AbortController();
      const pending = runFingerprintTool(
        process.execPath,
        [
          "-e",
          "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(process.argv[1],JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)",
          file,
        ],
        undefined,
        30_000,
        controller.signal,
      );
      const outcome = Promise.allSettled([pending]);
      try {
        await vi.waitFor(() => expect(existsSync(file)).toBe(true));
        const pids: number[] = JSON.parse(await readFile(file, "utf8"));
        controller.abort();
        expect((await outcome)[0]).toMatchObject({
          status: "rejected",
          reason: { name: "AbortError" },
        });
        await vi.waitFor(() => {
          for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
        });
      } finally {
        controller.abort();
        await outcome;
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
