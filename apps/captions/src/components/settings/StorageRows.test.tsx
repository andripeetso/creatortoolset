import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { StorageFolder, StorageView } from "@contracts/storage";
import { AllowedRows, removeBody, Storage, whereOf, type Computer, canRevealFolder, driveLabel, driveOf, driveStart, folderLine, revealFolder, shareAddress } from "./StorageRows";
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
    expect(html.match(/>Add folder</g)).toHaveLength(3); // Exports, Projects, Media
    expect(html).not.toContain("Not set");
    expect(html).not.toContain("No folders");
  });

  it("an Exports folder is a row under Exports with its menu; Media lists only the folders someone added", () => {
    const html = page([library]);
    expect(html).toContain("Sam&#x27;s Mac Studio · /Volumes/Footage SSD/Creator Toolset");
    expect(html).toContain('aria-label="Actions for Creator Toolset"');
    expect(html).not.toContain("/Volumes/Footage SSD/Creator Toolset/Footage");
    // no Finals row any more: Finals reads Exports, so the folder shows once
    expect(html).not.toContain("/Creator Toolset/Finished");
    expect(html.match(/>Add folder</g)).toHaveLength(3); // Exports, Projects, Media
  });

  it("a folder on a network share is named by the share's server and its path there, not the computer that added it", () => {
    const onShare: StorageFolder = { ...library, origin: { host: "dev_1", path: "/Volumes/home/Tiny/Exports" }, mount: { fs: "smb", server: "tiny-nas", share: "home", sub: "Tiny/Exports" } };
    expect(whereOf(onShare, [mac])).toBe("tiny-nas · home/Tiny/Exports");
    expect(whereOf(library, [mac])).toContain("Sam's Mac Studio · ");
  });

  it("a Projects folder is listed under Projects with its menu", () => {
    const projects: StorageFolder = { id: "p_1", role: "projects", name: "Projects", origin: { host: "dev_1", path: "/Volumes/Footage SSD/Projects" }, make: true, createdAt: 0, reach: {} };
    const html = page([projects]);
    expect(html).toContain(">Projects<");
    expect(html).toContain("Sam&#x27;s Mac Studio · /Volumes/Footage SSD/Projects");
    expect(html).toContain('aria-label="Actions for Projects"');
  });

  it("a folder whose computer is none of the account's says Computer not found, and keeps its menu", () => {
    const gone: StorageFolder = { ...library, id: "gone_1", origin: { host: "device-nobody-has", path: "/Volumes/Old/Exports" }, missing: true };
    const html = page([gone]);
    expect(html).toContain("Computer not found · /Volumes/Old/Exports");
    // said once: no "Not checked yet on Computer not found" under it
    expect(html.match(/Computer not found/g)).toHaveLength(1);
    expect(html).not.toContain("Not checked yet");
    expect(html).not.toContain("A removed computer");
    expect(html).toContain('aria-label="Actions for Creator Toolset"');
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

  it("a card per workspace (Media, Projects, Exports in that order), then the folders for every workspace with no Add folder", () => {
    const html = shown({}, [{ ...library, workspace: "ws-a" }, { ...songs, workspace: "*" }]);
    expect(html.indexOf(">Tiny Acrobatics<")).toBeLessThan(html.indexOf(">Tiny Swimmers<"));
    expect(html.indexOf(">Tiny Swimmers<")).toBeLessThan(html.indexOf(">Every workspace<"));
    expect(html.match(/>Exports</g)).toHaveLength(2); // one per workspace; none in Every workspace, which has only Media
    expect(html.match(/>Add folder</g)).toHaveLength(6); // Media, Projects, Exports in each workspace's card
    expect(html.indexOf(">Media<")).toBeLessThan(html.indexOf(">Projects<"));
    expect(html.indexOf(">Projects<")).toBeLessThan(html.indexOf(">Exports<"));
    expect(html.match(/>Change</g)).toBeNull();
    expect(html.indexOf("/Volumes/Footage SSD/Songs")).toBeGreaterThan(html.indexOf(">Every workspace<"));
  });

  it("one workspace shown: Exports lists the folder it uses, its own before the one for every workspace", () => {
    const one = { id: "ws-a", all: false, workspaces, many: true, cacheKey: "ws-a", name: () => "" } as unknown as SettingsWorkspace;
    const html = renderToStaticMarkup(
      <Storage devices={[mac]} storage={view([{ ...library, id: "lib_every", workspace: "*", origin: { host: "dev_1", path: "/Volumes/Every/Exports" } }, { ...library, workspace: "ws-a" }])} onChanged={() => {}} w={one} />,
    );
    expect(html).not.toContain("/Volumes/Every/Exports");
    expect(html.match(/aria-label="Actions for Creator Toolset"/g)).toHaveLength(1);
  });

  it("one workspace shown: every Projects folder is listed (one per computer), not only one", () => {
    const one = { id: "ws-a", all: false, workspaces, many: true, cacheKey: "ws-a", name: () => "" } as unknown as SettingsWorkspace;
    const p = (id: string, host: string, at: string): StorageFolder => ({ id, role: "projects", name: "Projects", origin: { host, path: at }, make: true, createdAt: 0, reach: {}, workspace: "ws-a" });
    const html = renderToStaticMarkup(<Storage devices={[mac]} storage={view([p("p1", "dev_1", "/Volumes/A/Projects"), p("p2", "dev_2", "/Volumes/B/Projects")])} onChanged={() => {}} w={one} />);
    expect(html).toContain("/Volumes/A/Projects");
    expect(html).toContain("/Volumes/B/Projects");
  });

  it("Remove of a folder in two workspaces names both; of one, only that its files stay", () => {
    const all = { id: null, all: true, workspaces, many: true, cacheKey: "*", name: () => "" } as unknown as SettingsWorkspace;
    expect(removeBody({ ...library, workspace: "ws-a", workspaces: ["ws-a", "ws-b"] }, all)).toBe("Removes it from Tiny Acrobatics, Tiny Swimmers; its files are not deleted.");
    expect(removeBody({ ...library, workspace: "ws-a" }, all)).toBe("The folder's files are not deleted.");
  });

  it("every Exports folder is listed, one of a workspace that is not listed too (under Other workspaces)", () => {
    const html = shown({}, [{ ...library, workspace: "ws-a" }, { ...library, id: "lib_2", workspace: "ws-elsewhere", origin: { host: "dev_1", path: "/Volumes/Other/Exports" } }]);
    expect(html.match(/aria-label="Actions for Creator Toolset"/g)).toHaveLength(2);
    expect(html).toContain("/Volumes/Other/Exports");
  });

  it("with one workspace picked, Exports is one list", () => {
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

describe("Show in Finder, in the Mac app", () => {
  const g = globalThis as unknown as { window?: unknown; document?: unknown };
  const asks: string[] = [];
  // the Mac app's bridge and marks: this Mac is dev_1; `reveal`: it shows Settings → Folders folders
  const inMacApp = (reveal: boolean, answer: object = { ok: true }) => {
    g.window = { webkit: { messageHandlers: { thisMac: { postMessage: async (m: string) => (asks.push(m), answer) } } } };
    g.document = { documentElement: { dataset: { macDevice: "dev_1", ...(reveal ? { macFolderReveal: "1" } : {}) } } };
  };
  afterEach(() => {
    delete g.window;
    delete g.document;
    asks.length = 0;
  });

  it("is in the menu of each Exports, Projects and Media folder of this Mac (no Finals button)", () => {
    inMacApp(true);
    const html = page([library]);
    expect(html.match(/>Show in Finder</g)).toBeNull(); // in each row's menu, which is closed until pressed
    expect(html).toContain('aria-label="Actions for Creator Toolset"');
    expect(canRevealFolder(library)).toBe(true);
  });

  it("is left out without the Mac app's mark, and for a folder on another computer", () => {
    inMacApp(false);
    expect(page([library])).not.toContain("Show in Finder");
    expect(page([library])).not.toContain('aria-label="Actions for Footage"');
    inMacApp(true);
    const elsewhere = { ...library, origin: { host: "dev_2", path: "/Volumes/Other/Creator Toolset" } };
    expect(canRevealFolder(elsewhere)).toBe(false);
    expect(page([elsewhere])).not.toContain("Show in Finder");
  });

  it("asks the Mac app by the folder's path and passes on its answer", async () => {
    inMacApp(true);
    await revealFolder(library);
    expect(asks).toEqual([`reveal:${JSON.stringify({ folder: "/Volumes/Footage SSD/Creator Toolset" })}`]);
    inMacApp(true, { ok: false, problem: "Folder not found on this Mac" });
    await expect(revealFolder(library)).rejects.toThrow("Folder not found on this Mac");
  });
});

describe("Allowed folders (the Mac app's read list)", () => {
  const draw = (folders: string[], reads: string[], rows: string[] = []) =>
    renderToStaticMarkup(<AllowedRows list={{ folders, reads }} rows={rows} busy={false} onAsk={() => async () => {}} onRemove={async () => {}} />);

  it("lists each folder this Mac reads outside its rows, each with its menu; a drop's is copied on import with Allow", () => {
    const html = draw(["/Volumes/NAS/FOOTAGE", "/Users/tiny/Downloads", "/Volumes/Tiny/Footage/Imports/2026-11-23"], ["/Volumes/NAS/FOOTAGE"], ["/Volumes/Tiny/Footage"]);
    expect(html).toContain("Allowed folders");
    expect(html).toContain('aria-label="Actions for FOOTAGE"');
    expect(html).toContain('aria-label="Actions for Downloads"');
    expect(html).not.toContain("Imports/2026-11-23"); // under a row: the row says it
    expect(html.match(/Copied on import/g)).toHaveLength(1);
    expect(html.match(/>Allow</g)).toHaveLength(1);
  });
});
