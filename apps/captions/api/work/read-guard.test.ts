import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "work-read-guard-"));
process.env.DATA_DIR = path.join(dir, "data");
const share = path.join(dir, "mnt", "tiny");
vi.mock("./disks", () => ({ machineDisks: () => [{ name: "tiny", path: share, freeGb: 1, network: true, server: "tiny-nas", fs: "smb", share: "TINY FOOTAGE" }] }));

const { mayReadHere } = await import("./library");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const put = (p: string) => (mkdirSync(path.dirname(p), { recursive: true }), writeFileSync(p, "x"), p);

describe("what a library-only computer may read", () => {
  const own = path.join(dir, "data", "library-work", "1");
  const clip = put(path.join(share, "SHOOTS", "a.mov"));
  const secret = put(path.join(dir, "home", "notes.mov"));
  const link = path.join(share, "SHOOTS", "out.mov");
  symlinkSync(secret, link);
  const text = put(path.join(share, "SHOOTS", "notes.txt"));
  const downloaded = put(path.join(own, "original"));

  it("a media file on a share it has connected, or a copy in its own job folder", async () => {
    expect(await mayReadHere(clip, [own], true)).toBe(true);
    expect(await mayReadHere(downloaded, [own], true)).toBe(true);
  });

  it("never a link out of the share, a file elsewhere, a folder or a file that is not media", async () => {
    expect(await mayReadHere(link, [own], true)).toBe(false);
    expect(await mayReadHere(secret, [own], true)).toBe(false);
    expect(await mayReadHere(path.join(share, "SHOOTS"), [own], true)).toBe(false);
    expect(await mayReadHere(text, [own], true)).toBe(false);
    expect(await mayReadHere(path.join(share, "gone.mov"), [own], true)).toBe(false);
  });

  it("a Mac app's worker reads its own disks as always", async () => {
    expect(await mayReadHere(secret, [own], false)).toBe(true);
  });
});
