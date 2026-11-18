import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StorageFolder, StorageView } from "@contracts/storage";
import { Storage, type Computer, driveLabel, driveOf, driveStart, folderLine, shareAddress } from "./StorageRows";
import type { SettingsWorkspace } from "./workspace-pick";

const mac = { id: "dev_1", name: "Sam's Mac Studio", owner: "sam", online: true } as unknown as Computer;
const library: StorageFolder = {
  id: "lib_1", role: "library", name: "Creator Toolset", origin: { host: "dev_1", path: "/Volumes/Footage SSD/Creator Toolset" },
  make: true, createdAt: 0, reach: {},
};
const view = (folders: StorageFolder[]): StorageView => ({ folders, serverDisks: [] });
const page = (folders: StorageFolder[]) => renderToStaticMarkup(<Storage devices={[mac]} storage={view(folders)} onChanged={() => {}} />);

describe("Storage rows", () => {
  it("with nothing set, each kind's row only offers its button", () => {
    const html = page([]);
    expect(html.match(/>Add folder</g)).toHaveLength(3); // Exports, Finals, Media
    expect(html).not.toContain("Not set");
    expect(html).not.toContain("No folders");
  });

  it("a set row shows its full path on its computer and says Change", () => {
    const html = page([library]);
    expect(html).toContain("Sam&#x27;s Mac Studio · /Volumes/Footage SSD/Creator Toolset");
    expect(html).toContain("Sam&#x27;s Mac Studio · /Volumes/Footage SSD/Creator Toolset/Footage");
    // Finals: the Library's Finished/ until another folder is chosen
    expect(html).toContain("Sam&#x27;s Mac Studio · /Volumes/Footage SSD/Creator Toolset/Finished");
    expect(html).toContain(">Change<");
    expect(html).not.toContain("Library/Footage");
  });
});

describe("every workspace's folders (Settings on All workspaces)", () => {
  const workspaces = [{ id: "ws-a", name: "Tiny Acrobatics" }, { id: "ws-b", name: "Tiny Swimmers" }];
  const songs: StorageFolder = { id: "f_9", role: "footage", name: "Songs", origin: { host: "dev_1", path: "/Volumes/Footage SSD/Songs" }, make: false, createdAt: 0, reach: {} };
  // the workspace tag itself is not asserted: it reads the workspace store, which a static render sees empty
  const shown = (w: Partial<SettingsWorkspace>, folders: StorageFolder[]) => {
    const all = { id: null, all: true, workspaces, many: true, cacheKey: "*", name: () => "", ...w } as unknown as SettingsWorkspace;
    return renderToStaticMarkup(<Storage devices={[mac]} storage={view(folders)} onChanged={() => {}} w={all} />);
  };

  it("Finished videos has a row per workspace: Change where it has a folder, Add folder where it has none", () => {
    const html = shown({}, [{ ...library, workspace: "ws-a" }, { ...songs, workspace: "*" }]);
    expect(html.match(/>Exports</g)).toHaveLength(2);
    expect(html.match(/>Change</g)).toHaveLength(2); // its Exports and its Finals
    expect(html.match(/>Add folder</g)).toHaveLength(3); // the other workspace's Exports and Finals, Media
    expect(html).toContain("/Volumes/Footage SSD/Songs");
  });

  it("a Finished videos folder of a workspace that is not listed still has its row", () => {
    const html = shown({}, [{ ...library, workspace: "ws-a" }, { ...library, id: "lib_2", workspace: "ws-elsewhere", origin: { host: "dev_1", path: "/Volumes/Other/Creator Toolset" } }]);
    expect(html.match(/>Exports</g)).toHaveLength(3);
    expect(html).toContain("/Volumes/Other/Creator Toolset");
  });

  it("with one workspace picked, Finished videos is one row", () => {
    const html = shown({ id: "ws-a", all: false, cacheKey: "ws-a" }, [{ ...library, workspace: "ws-a" }, { ...songs, workspace: "*" }]);
    expect(html.match(/>Exports</g)).toHaveLength(1);
    expect(html).toContain("/Volumes/Footage SSD/Songs");
  });
});

describe("which computers can read a folder", () => {
  const pc = { id: "dev_2", name: "Edit PC", owner: "sam", online: true, report: { machine: { os: "linux", cpus: 8, memGb: 16 } } } as unknown as Computer;
  const laptop = { id: "dev_3", name: "Laptop", owner: "sam", online: true, report: { machine: { os: "mac", cpus: 8, memGb: 16 } } } as unknown as Computer;
  const shoots: StorageFolder = {
    id: "f_1", role: "footage", name: "Shoots", origin: { host: "dev_1", path: "/Volumes/Footage/Shoots" }, make: false, createdAt: 0,
    reach: { dev_2: { path: "/mnt/footage/Shoots", at: 0 } }, mount: { fs: "smb", server: "nas", share: "Footage", sub: "Shoots" },
  };
  const rows = (copies?: boolean, devices = [mac, pc, laptop]) =>
    renderToStaticMarkup(<Storage devices={devices} storage={{ ...view([shoots]), ...(copies ? { copies } : {}) }} onChanged={() => {}} />);

  it("says per computer: on it, or not checked yet there, with Connect for a share", () => {
    const html = rows();
    expect(html).toContain("On Sam&#x27;s Mac Studio");
    expect(html).toContain("On Edit PC");
    expect(html).toContain("Not checked yet on Laptop");
    expect(html.match(/>Connect</g)).toHaveLength(1);
    expect(rows(true)).not.toContain("server copy");
  });

  it("says nothing of it with one computer", () => {
    expect(rows(false, [mac])).not.toContain("On this computer");
  });
});

describe("the Drive select", () => {
  const system = { name: "System disk", path: "/", freeGb: 72, totalGb: 460 };
  const ssd = { name: "Footage SSD", path: "/Volumes/Footage SSD", freeGb: 759, totalGb: 1843 };
  const share = { name: "STUDIO", path: "/Volumes/STUDIO", freeGb: 2867, network: true as const, server: "studio-nas" };
  const deeper = { name: "Archive", path: "/Volumes/STUDIO/Archive", freeGb: 10 };
  const disks = [system, ssd, share, deeper];

  it("names a network share with the machine it lives on and its free space", () => {
    expect(driveLabel(share)).toBe("STUDIO · studio-nas · 2.8 TB free");
    expect(driveLabel(ssd)).toBe("Footage SSD · 759 GB free");
    expect(driveLabel({ ...share, server: undefined })).toBe("STUDIO · Network · 2.8 TB free");
    expect(driveLabel({ ...share, server: "STUDIO" })).toBe("STUDIO · Network · 2.8 TB free"); // a share named like its machine is not said twice
  });

  it("starts the folder at the drive: the home folder on the system disk, the drive's own folder elsewhere", () => {
    expect(driveStart(system)).toBe("~");
    expect(driveStart(share)).toBe("/Volumes/STUDIO");
    expect(driveStart({ ...ssd, path: "/Volumes/Footage SSD/" })).toBe("/Volumes/Footage SSD");
  });

  it("shows the drive a typed path is on: the longest drive folder that holds it, else the system disk", () => {
    expect(driveOf(disks, "/Volumes/STUDIO/2026/Shoot")).toBe(share);
    expect(driveOf(disks, "/Volumes/STUDIO")).toBe(share);
    expect(driveOf(disks, "/Volumes/STUDIO/Archive/old")).toBe(deeper);
    expect(driveOf(disks, "/Volumes/STUDIO 2/x")).toBe(system); // a name that only starts the same is another place
    expect(driveOf(disks, "~/Movies")).toBe(system);
    expect(driveOf(disks, "")).toBeUndefined();
    expect(driveOf([ssd], "~/Movies")).toBeUndefined();
  });
});

describe("Connect network storage", () => {
  it("takes a share the ways people write one and gives Finder's address", () => {
    expect(shareAddress("smb://nas.local/Footage")).toBe("smb://nas.local/Footage");
    expect(shareAddress("  nas.local/Footage/ ")).toBe("smb://nas.local/Footage");
    expect(shareAddress("\\\\studio-nas\\My Footage")).toBe("smb://studio-nas/My%20Footage");
    expect(shareAddress("smb://studio-nas.local/My%20Footage")).toBe("smb://studio-nas.local/My%20Footage"); // not encoded twice
    expect(shareAddress("afp://old-nas.local/Archive")).toBe("afp://old-nas.local/Archive");
    expect(shareAddress("studio-nas")).toBe("smb://studio-nas");
  });

  it("refuses anything that is not a share: the address becomes a link", () => {
    for (const bad of ["", "   ", "javascript://alert(1)", "https://example.com/x", "file:///etc/passwd", "smb://", "smb:// spaced host/x", "smb://-bad/x"]) expect(shareAddress(bad)).toBeNull();
  });
});

describe("a folder's state on its computer", () => {
  const f: StorageFolder = { id: "f_1", role: "footage", name: "Shoots", origin: { host: "dev_1", path: "/Volumes/Tiny Drive/Shoots" }, make: false, createdAt: 0, reach: {} };
  it("says what its computer last reported, in the plan's words", () => {
    expect(folderLine(f, "Studio Mac", true)).toBe("Not checked yet");
    expect(folderLine(f, "Studio Mac", false)).toBe("Not checked yet on Studio Mac");
    expect(folderLine({ ...f, folderState: "ok", checkedAt: Date.now() - 5 * 60_000 }, "Studio Mac", true)).toBe("Last checked 5 min ago");
    expect(folderLine({ ...f, folderState: "not_found" }, "Studio Mac", true)).toBe("Folder not found, re-point?");
    expect(folderLine({ ...f, folderState: "needs_ok" }, "Studio Mac", true)).toBe("Needs your OK");
    expect(folderLine({ ...f, folderState: "disk_away" }, "Studio Mac", true)).toBe("Tiny Drive isn't connected");
  });

  it("outside the Mac app's window a folder waiting for an OK has no Allow button", () => {
    const html = page([{ ...f, folderState: "needs_ok" }]);
    expect(html).toContain("Needs your OK");
    expect(html).not.toContain("Allow on this Mac");
  });
});
