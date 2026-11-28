import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renameAtomic, writeJsonAtomic } from "./write-json";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const err = (code: string) => Object.assign(new Error(`${code}: rename failed`), { code });

describe("writeJsonAtomic", () => {
  it("writes and replaces JSON atomically on disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ct-write-json-"));
    dirs.push(dir);
    const file = path.join(dir, "sub", "meta.json");
    await writeJsonAtomic(file, { n: 1 });
    await writeJsonAtomic(file, { n: 2 }, 2);
    expect(JSON.parse(await readFile(file, "utf-8"))).toEqual({ n: 2 });
  });

  it("retries transient Windows EPERM/EBUSY/EACCES rename failures and succeeds", async () => {
    const delays: number[] = [];
    const mv = vi
      .fn()
      .mockRejectedValueOnce(err("EPERM"))
      .mockRejectedValueOnce(err("EBUSY"))
      .mockRejectedValueOnce(err("EACCES"))
      .mockResolvedValueOnce(undefined);
    await renameAtomic("a.tmp", "a.json", { rename: mv as never, wait: async (ms) => void delays.push(ms) });
    expect(mv).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([20, 40, 80]);
  });

  it("stops after the retry limit on persistent EPERM and fails immediately on non-transient errors", async () => {
    const mvPerm = vi.fn().mockRejectedValue(err("EPERM"));
    await expect(renameAtomic("a.tmp", "a.json", { rename: mvPerm as never, wait: async () => {} })).rejects.toThrow("EPERM");
    expect(mvPerm).toHaveBeenCalledTimes(6);

    const mvNoent = vi.fn().mockRejectedValue(err("ENOENT"));
    await expect(renameAtomic("a.tmp", "a.json", { rename: mvNoent as never, wait: async () => {} })).rejects.toThrow("ENOENT");
    expect(mvNoent).toHaveBeenCalledTimes(1);
  });
});
