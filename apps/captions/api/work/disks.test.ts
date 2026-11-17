import { describe, expect, it } from "vitest";
import { rootKey } from "../../contracts/places";
import { cachedFree, sharesIn } from "./disks";

const MOUNTS = [
  "/dev/nvme0n1p2 / ext4 rw,relatime 0 0",
  "//tiny-nas.local/FOOTAGE\\040ONE /mnt/FOOTAGE\\040ONE cifs rw,vers=3.0,username=tiny,password=hunter2,credentials=/root/.smb,uid=1000 0 0",
  "tiny-nas:/export/clips /mnt/clips nfs4 rw,sec=sys,addr=10.0.0.9 0 0",
  "tmpfs /tmp tmpfs rw 0 0",
].join("\n");

describe("machineDisks", () => {
  it("names each network share by its server and name, and never reads the mount options", () => {
    const disks = sharesIn(MOUNTS, () => 12);
    expect(disks).toEqual([
      { name: "FOOTAGE ONE", path: "/mnt/FOOTAGE ONE", freeGb: 12, network: true, server: "tiny-nas.local", fs: "smb", share: "FOOTAGE ONE" },
      { name: "clips", path: "/mnt/clips", freeGb: 12, network: true, server: "tiny-nas", fs: "nfs", share: "/export/clips" },
    ]);
    const text = JSON.stringify(disks);
    for (const secret of ["username", "tiny,", "hunter2", "password", "credentials", "/root/.smb", "uid=", "addr"]) expect(text).not.toContain(secret);
    // the same share key a Mac reports for it
    expect(rootKey(disks[0]!)).toBe("smb://tiny-nas/footage one");
  });

  it("leaves out the NAS user a source names before its host", () => {
    const disks = sharesIn("//tiny@Tiny-NAS.local/TINY\\040FOOTAGE /mnt/tiny cifs rw 0 0", () => 0);
    expect(disks).toMatchObject([{ server: "tiny-nas.local", share: "TINY FOOTAGE", path: "/mnt/tiny" }]);
    expect(JSON.stringify(disks)).not.toContain("tiny@");
  });

  it("never waits for a share's free space: a statfs that never answers holds nothing, and is not asked twice", () => {
    let asked = 0;
    const hangs = () => {
      asked++;
      return new Promise<never>(() => {});
    };
    const t = Date.now();
    expect(cachedFree("/mnt/hung", hangs)).toBe(0);
    expect(cachedFree("/mnt/hung", hangs, t + 60 * 60_000)).toBe(0);
    expect(asked).toBe(1);
  });

  it("answers with the last free space read", async () => {
    cachedFree("/mnt/ok", async () => ({ bavail: 5 * 1024 ** 2, bsize: 1024 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(cachedFree("/mnt/ok", async () => ({ bavail: 0, bsize: 1 }))).toBe(5);
  });
});
