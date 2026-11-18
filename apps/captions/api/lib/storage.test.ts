import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { connectFor, finalsDirName, finalsFolderOf, sourcesOf, type Disk, type StorageFolder } from "../../contracts/storage";
import { canReach, folderFor, hostPath, isInside, mountOf, withMounts, localDisks, parseStorageFile, parseStorageReport, storageFilePath, uploadRelayView } from "./storage";

// Two fake volumes: "/" (100 GB free of 200) and an external drive at /Volumes/EXT (5 of 20). Other paths do not exist.
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  const volumes: Record<string, { bavail: number; blocks: number }> = {
    "/": { bavail: 1e8, blocks: 2e8 },
    "/Volumes/EXT": { bavail: 5e6, blocks: 2e7 },
  };
  return {
    ...real,
    statfs: async (p: string) => {
      const v = volumes[p];
      if (!v) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return { bsize: 1000, ...v };
    },
  };
});

describe("local disks: the server reads the Library's disk (statfs), not only the system disk", () => {
  it("system disk only when no library path is given, or it is on the system disk", async () => {
    expect((await localDisks()).map((d) => d.path)).toEqual(["/"]);
    expect((await localDisks("/Users/tiny/Creator Toolset")).map((d) => d.path)).toEqual(["/"]);
    expect((await localDisks("~/Creator Toolset")).map((d) => d.path)).toEqual(["/"]);
  });

  it("adds the library's own disk with its free and total space when it is another volume", async () => {
    const disks = await localDisks("/Volumes/EXT/Creator Toolset");
    expect(disks.map((d) => [d.path, d.freeGb, d.totalGb])).toEqual([["/", 100, 200], ["/Volumes/EXT", 5, 20]]);
  });

  it("reads a library that does not exist yet at its nearest folder that does", async () => {
    const disks = await localDisks("/Volumes/EXT/not/made/yet");
    expect(disks.at(-1)?.path).toBe("/Volumes/EXT");
  });
});

describe("upload relay choice (the server's, never the browser's)", () => {
  it("direct when a bucket is set up, chunked otherwise", () => {
    expect(uploadRelayView(undefined, true).active).toBe("direct");
    expect(uploadRelayView(undefined, false).active).toBe("chunked");
    expect(uploadRelayView("", true).active).toBe("direct");
  });

  it("the setting wins, and direct without a bucket falls back to chunked", () => {
    expect(uploadRelayView("chunked", true).active).toBe("chunked");
    expect(uploadRelayView("direct", false).active).toBe("chunked");
    expect(uploadRelayView("some-other", true).active).toBe("direct"); // not a built-in id: ignored
  });

  it("lists both built-in relays, with direct available only when the bucket is", () => {
    const view = uploadRelayView(undefined, false);
    expect(view.relays.map((r) => [r.id, r.available])).toEqual([["chunked", true], ["direct", false]]);
  });
});

const team = (reach: StorageFolder["reach"] = {}): StorageFolder => ({
  id: "team", role: "footage", name: "TEAM", origin: { host: "studio-mac", path: "/Volumes/TEAM" }, make: false, createdAt: 0, reach,
});

describe("where the files are: reach", () => {
  it("no restriction without a footage folder around the path", () => {
    expect(canReach(["/Volumes/X/a.mp4"], [], "pc")).toBe(true);
    expect(canReach(["/Volumes/TEAM2/a.mp4"], [team()], "pc")).toBe(true);
  });

  it("matches on a path boundary: TEAM2 is not inside TEAM", () => {
    expect(folderFor("/Volumes/TEAM2/x.mp4", [team()])).toBeNull();
    expect(folderFor("/Volumes/TEAM/x.mp4", [team()])?.prefix).toBe("/Volumes/TEAM");
    expect(folderFor("/Volumes/TEAM", [team()])?.prefix).toBe("/Volumes/TEAM");
  });

  it("~ paths never match absolute paths", () => {
    const home = { ...team(), origin: { host: "studio-mac", path: "~/Creator Toolset/Footage" } };
    expect(canReach(["/Users/a/Creator Toolset/Footage/x.mp4"], [home], "pc")).toBe(true);
    expect(canReach(["~/Creator Toolset/Footage/x.mp4"], [home], "pc")).toBe(false);
    expect(canReach(["~/Creator Toolset/Footage/x.mp4"], [home], "studio-mac")).toBe(true);
  });

  it("the origin computer reaches the folder it made; another computer only where it found it", () => {
    const f = team();
    expect(canReach(["/Volumes/TEAM/Shoot/a.mp4"], [f], "studio-mac")).toBe(true);
    expect(canReach(["/Volumes/TEAM/Shoot/a.mp4"], [f], "pc")).toBe(false);
    expect(canReach(["/Volumes/TEAM/Shoot/a.mp4"], [team({ pc: { path: "/Volumes/TEAM", at: 1 } })], "pc")).toBe(true);
    // the same folder at another path on that computer: reached, by its marker
    expect(canReach(["/Volumes/TEAM/Shoot/a.mp4"], [team({ pc: { path: "/mnt/team", at: 1 } })], "pc")).toBe(true);
  });

  it("rewrites a path for the computer it goes to, by the folder it is in", () => {
    const f = team({ linux: { path: "/mnt/team/", at: 1 }, win: { path: "Z:\\", at: 1 }, unc: { path: "\\\\nas\\Team", at: 1 } });
    expect(hostPath("/Volumes/TEAM/Shoot 1/a.mp4", [f], "linux")).toBe("/mnt/team/Shoot 1/a.mp4");
    expect(hostPath("/Volumes/TEAM/Shoot 1/a.mp4", [f], "win")).toBe("Z:\\Shoot 1\\a.mp4");
    expect(hostPath("/Volumes/TEAM/Shoot 1/a.mp4", [f], "unc")).toBe("\\\\nas\\Team\\Shoot 1\\a.mp4");
    expect(hostPath("/Volumes/TEAM", [f], "linux")).toBe("/mnt/team/");
    // back from Windows: either separator, any case
    expect(hostPath("z:\\Shoot 1\\a.mp4", [f], "studio-mac", "win")).toBe("/Volumes/TEAM/Shoot 1/a.mp4");
    expect(hostPath("\\\\NAS\\team/Shoot 1/a.mp4", [f], "linux", "unc")).toBe("/mnt/team/Shoot 1/a.mp4");
    expect(hostPath("/Volumes/TEAM/a.mp4", [f], "pc")).toBeNull();   // never found it
    expect(hostPath("/Volumes/Other/a.mp4", [f], "linux")).toBeNull();   // in no footage folder
    // `from`: only that computer's path counts ("/mnt/team" on the Mac is not the folder)
    expect(hostPath("/mnt/team/a.mp4", [f], "linux", "studio-mac")).toBeNull();
  });

  it("a computer that found the folder at another path names the same folder: each reaches it at its own path", () => {
    const f = team({ pc: { path: "/Mnt/TEAM/", at: 1 } });
    expect(folderFor("/Mnt/TEAM/Shoot/a.mp4", [f])?.prefix).toBe("/Mnt/TEAM");
    expect(canReach(["/Mnt/TEAM/Shoot/a.mp4"], [f], "pc")).toBe(true);
    expect(canReach(["/Mnt/TEAM/Shoot/a.mp4"], [f], "studio-mac")).toBe(true);
    expect(hostPath("/Mnt/TEAM/Shoot/a.mp4", [f], "studio-mac")).toBe("/Volumes/TEAM/Shoot/a.mp4");
  });

  it("every footage path of a job must be reachable", () => {
    const f = team({ pc: { path: "/Volumes/TEAM", at: 1 } });
    expect(canReach(["/Volumes/TEAM/a.mp4", "/Volumes/TEAM2/b.mp4"], [f], "pc")).toBe(true);
    expect(canReach(["/Volumes/TEAM/a.mp4", "/Volumes/TEAM/b.mp4"], [f], "pc")).toBe(true);
    expect(canReach(["/Volumes/TEAM/a.mp4", "/Volumes/TEAM/b.mp4"], [team()], "pc")).toBe(false);
  });
});

describe("where the files are: the workers' reports", () => {
  it("keeps good found rows and errors, drops bad paths, caps each list at 100", () => {
    expect(parseStorageReport(null)).toBeNull();
    expect(parseStorageReport({
      found: [{ id: "a", path: "/x" }, { id: "b", path: "../x" }, { id: "c", path: "~/y" }, { path: "/z" }],
      errors: [{ id: "a", error: "nope" }, { id: "b" }],
    })).toEqual({ found: [{ id: "a", path: "/x" }, { id: "c", path: "~/y" }], errors: [{ id: "a", error: "nope" }] });
    const many = Array.from({ length: 150 }, (_, i) => ({ id: `f${i}`, path: "/x" }));
    expect(parseStorageReport({ found: many, errors: [] })?.found).toHaveLength(100);
  });
});

describe("where the files are: the library and its files", () => {
  it("a file is inside a music folder only below it, never beside or at it", () => {
    expect(isInside("/m/Music/a.mp3", ["/m/Music"])).toBe(true);
    expect(isInside("/m/Music/album/a.mp3", ["/x", "/m/Music"])).toBe(true);
    expect(isInside("/m/Music2/a.mp3", ["/m/Music"])).toBe(false);
    expect(isInside("/m/Music", ["/m/Music"])).toBe(false);
  });

  it("each account's list is its own file under storage/", () => {
    expect(storageFilePath("/data", "studio")).toBe(path.join("/data", "storage", "studio.json"));
    expect(storageFilePath("/data", "tiny")).not.toBe(storageFilePath("/data", "studio"));
  });

  it("a corrupt storage file reads as an empty list, and a file without a list does too", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseStorageFile("{ not json")).toEqual({ folders: [] });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    expect(parseStorageFile("null")).toEqual({ folders: [] });
    expect(parseStorageFile('{"folders":"x"}')).toEqual({ folders: [] });
  });

  it("one Media list: a music folder from before is Media, and one inside a Media folder in all its workspaces is left out", () => {
    const at = (id: string, p: string, more: Partial<StorageFolder> = {}): StorageFolder => ({ ...team(), id, origin: { host: "studio-mac", path: p }, ...more });
    const moo = at("moo", "/Volumes/MONO/MOO", { workspace: "ws-a" });
    const music = { ...at("music", "/Volumes/MONO/MOO/FOOTAGE/MUSIC", { workspace: "ws-a" }), role: "music" };
    const wider = at("wider", "/Volumes/MONO/MOO/B", { workspaces: ["ws-a", "ws-b"], workspace: "ws-a" }); // ws-b doesn't have MOO
    const elsewhere = at("pc", "/Volumes/MONO/MOO/C", { origin: { host: "pc", path: "/Volumes/MONO/MOO/C" } }); // another computer
    const old = at("old", "/Volumes/MONO2/Songs", { role: "music" as never });
    const read = parseStorageFile(JSON.stringify({ folders: [moo, music, wider, elsewhere, old] })).folders;
    expect(read.map((f) => [f.id, f.role])).toEqual([["moo", "footage"], ["wider", "footage"], ["pc", "footage"], ["old", "footage"]]);
    // a folder in every workspace covers its subfolders in any of them
    expect(parseStorageFile(JSON.stringify({ folders: [{ ...moo, workspace: "*" }, wider] })).folders.map((f) => f.id)).toEqual(["moo"]);
  });

  it("a readable storage file keeps its folders", () => {
    const f = team();
    expect(parseStorageFile(JSON.stringify({ folders: [f] }))).toEqual({ folders: [f] });
  });

  it("an Exports folder is never a Media folder; an older one's Footage, listed on read, keeps its reach", () => {
    const lib: StorageFolder = {
      id: "lib", role: "library", name: "Creator Toolset", origin: { host: "studio-mac", path: "~/Creator Toolset" },
      make: true, createdAt: 0, reach: { pc: { path: "/Mnt/CT", at: 1 } },
    };
    expect(sourcesOf([lib])).toEqual([]);
    const read = parseStorageFile(JSON.stringify({ folders: [lib] })).folders;
    expect(canReach(["/Mnt/CT/Footage/a.mp4"], read, "pc")).toBe(true);
    expect(hostPath("/Mnt/CT/Footage/a.mp4", read, "studio-mac")).toBe("~/Creator Toolset/Footage/a.mp4");
    expect(canReach(["/Mnt/CT/Footage/a.mp4"], read, "laptop")).toBe(false);
  });

  it("schema 3, once: a Library made before 2026-11-17 gets its Footage/ as a listed Media folder, a newer one none", () => {
    const old: StorageFolder = {
      id: "lib", role: "library", name: "Creator Toolset", origin: { host: "mac", path: "/Volumes/Tiny/Creator Toolset" },
      make: true, createdAt: 1, reach: { pc: { path: "/Mnt/CT", at: 1 } }, workspace: "ws-a", workspaces: ["ws-a", "ws-b"], folderState: "found" as never,
    };
    const made: StorageFolder = { ...old, id: "new", origin: { host: "mac", path: "/Volumes/Tiny/Exports" }, createdAt: Date.UTC(2026, 10, 18), workspace: "ws-c", workspaces: undefined };
    const read = parseStorageFile(JSON.stringify({ schemaVersion: 2, folders: [old, made] }));
    const footage = read.folders.filter((f) => f.role === "footage");
    expect(footage).toHaveLength(1);
    expect(footage[0]).toMatchObject({ id: "lib:footage", name: "Footage", make: false, origin: { host: "mac", path: "/Volumes/Tiny/Creator Toolset/Footage" }, reach: { pc: { path: "/Mnt/CT/Footage" } }, workspace: "ws-a", workspaces: ["ws-a", "ws-b"] });
    expect(footage[0]!.folderState).toBeUndefined();
    // once: a file at schema 3 (written back after the first read) never gets it again, so a removed one stays removed
    expect(parseStorageFile(JSON.stringify({ schemaVersion: 3, folders: [old] })).folders.map((f) => f.role)).toEqual(["library"]);
    // one already listed at that path is not added twice
    const listed = { ...footage[0]!, id: "mine" };
    expect(parseStorageFile(JSON.stringify({ folders: [old, listed] })).folders.map((f) => f.id)).toEqual(["lib", "mine"]);
  });
});

describe("the Finals folder", () => {
  const lib: StorageFolder = { id: "lib", role: "library", name: "Creator Toolset", origin: { host: "mac", path: "~/Creator Toolset" }, make: true, createdAt: 0, reach: { pc: { path: "/Mnt/CT", at: 1 } } };
  it("is the Exports folder itself until one is chosen, and the chosen one after", () => {
    expect(finalsFolderOf([lib])).toMatchObject({ id: "lib:finals", role: "finals", origin: { path: "~/Creator Toolset" }, reach: { pc: { path: "/Mnt/CT" } } });
    const own: StorageFolder = { ...lib, id: "fin", role: "finals", name: "Finals", origin: { host: "mac", path: "/Volumes/Drive/Finals" }, reach: {} };
    expect(finalsFolderOf([lib, own])?.id).toBe("fin");
    expect(finalsFolderOf([])).toBeUndefined();
    // the Library's own Finished/ is no Media folder
    expect(sourcesOf([lib])).toEqual([]);
  });
  it("names a project's folder by its title, safe as a file name", () => {
    expect(finalsDirName("Tiny Acrobatics: rolls / v2?")).toBe("Tiny Acrobatics rolls v2");
    expect(finalsDirName("..hidden. ")).toBe("hidden");
    expect(finalsDirName("  ")).toBe("Untitled");
  });
});

describe("a second computer connects the same share", () => {
  const macDisks: Disk[] = [
    { path: "/", name: "System disk", freeGb: 50 },
    { path: "/Volumes/Footage", name: "Footage", freeGb: 900, network: true, server: "nas", fs: "smb", share: "Footage" },
  ];
  const folder: StorageFolder = { id: "f", role: "footage", name: "Shoots", origin: { host: "mac", path: "/Volumes/Footage/Shoots" }, make: false, createdAt: 0, reach: {} };

  it("reads the share a folder is on from its computer's disks: nothing for its own disk", () => {
    expect(mountOf("/Volumes/Footage/Shoots", macDisks)).toEqual({ fs: "smb", server: "nas", share: "Footage", sub: "Shoots" });
    expect(mountOf("/Users/tiny/Movies", macDisks)).toBeUndefined();
    expect(mountOf("/Volumes/Footage", [{ ...macDisks[1]!, share: undefined, fs: undefined }])).toBeUndefined();
  });

  it("a computer with the same share connected reaches the folder at its own path, by itself", () => {
    const linux: Disk = { path: "/mnt/footage", name: "footage", freeGb: 900, network: true, server: "NAS.local", fs: "smb", share: "footage" };
    const win: Disk = { path: "Z:\\", name: "Z", freeGb: 900, network: true, server: "nas", fs: "smb", share: "Footage" };
    const other: Disk = { ...linux, path: "/mnt/other", share: "other" };
    const [f] = withMounts([folder], [{ id: "mac", disks: macDisks }, { id: "pc", disks: [linux] }, { id: "win", disks: [win] }, { id: "laptop", disks: [other] }]);
    expect(f!.mount).toEqual({ fs: "smb", server: "nas", share: "Footage", sub: "Shoots" });
    expect(Object.keys(f!.reach).sort()).toEqual(["pc", "win"]);
    expect(hostPath("/Volumes/Footage/Shoots/a.mp4", [f!], "pc")).toBe("/mnt/footage/Shoots/a.mp4");
    expect(hostPath("/Volumes/Footage/Shoots/a.mp4", [f!], "win")).toBe("Z:\\Shoots\\a.mp4");
    expect(canReach(["/Volumes/Footage/Shoots/a.mp4"], [f!], "laptop")).toBe(false);
  });

  it("tells each kind of computer how to connect it, with no password", () => {
    const m = { fs: "smb" as const, server: "nas", share: "Team Footage", sub: "" };
    expect(connectFor(m, "mac")).toEqual({ url: "smb://nas.local/Team%20Footage" });
    expect(connectFor(m, "linux")).toEqual({ line: "sudo mkdir -p /mnt/Team-Footage && sudo mount -t cifs '//nas.local/Team Footage' /mnt/Team-Footage -o username=$USER,uid=$(id -u),gid=$(id -g)" });
    expect(connectFor(m, "windows")).toEqual({ line: 'net use * "\\\\nas\\Team Footage" /persistent:yes' });
    expect(connectFor({ fs: "nfs", server: "nas", share: "volume1/rushes", sub: "" }, "linux")).toEqual({ line: "sudo mkdir -p /mnt/rushes && sudo mount -t nfs 'nas.local:/volume1/rushes' /mnt/rushes" });
    expect(connectFor({ fs: "nfs", server: "nas", share: "volume1/rushes", sub: "" }, "windows")).toBeNull();
    expect(connectFor({ ...m, share: "a'b" }, "linux")).toBeNull();
  });
});
