import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StorageFolder, StorageView } from "@contracts/storage";
import { Storage, type Computer, driveLabel, driveOf, driveStart, shareAddress } from "./StorageRows";

const mac = { id: "dev_1", name: "Sam's Mac Studio", owner: "sam", online: true } as unknown as Computer;
const library: StorageFolder = {
  id: "lib_1", role: "library", name: "Creator Toolset", origin: { host: "dev_1", path: "/Volumes/Footage SSD/Creator Toolset" },
  make: true, createdAt: 0, reach: {},
};
const view = (folders: StorageFolder[]): StorageView => ({ folders, serverDisks: [] });
const page = (folders: StorageFolder[]) => renderToStaticMarkup(<Storage devices={[mac]} storage={view(folders)} onChanged={() => {}} />);

describe("Storage rows", () => {
  it("with nothing set, one row says what the folders are for and each row only offers its button", () => {
    const html = page([]);
    expect(html).toContain("Where the Media Library and the AI Editor read and save files.");
    expect(html.match(/>Set folder</g)).toHaveLength(3);
    expect(html).not.toContain("Not set");
  });

  it("a set row shows its full path on its computer and says Change", () => {
    const html = page([library]);
    expect(html).not.toContain("Where the Media Library");
    expect(html).toContain("Sam&#x27;s Mac Studio · /Volumes/Footage SSD/Creator Toolset");
    expect(html).toContain("Sam&#x27;s Mac Studio · /Volumes/Footage SSD/Creator Toolset/Footage");
    expect(html).toContain(">Change<");
    expect(html).not.toContain("Library/Footage");
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
