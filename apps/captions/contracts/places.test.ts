import { describe, expect, it } from "vitest";
import { applyMove, derivedMove, joinRoot, rootKey, type PathMove } from "./places";
import type { ShareFs } from "./storage";

// Plain tables: apps/mac PlacesTests.swift copies these rows, so the Swift port answers the same.
// NFD/NFC: "é" as one code point or as "e" + a combining accent.
const E_NFC = "\u00e9";
const E_NFD = "e\u0301";

/** [what the disk says, its root key] */
const ROOT_KEYS: [{ fs?: ShareFs; server?: string; share?: string; uuid?: string }, string | undefined][] = [
  [{ fs: "smb", server: "office-nas", share: "footage" }, "smb://office-nas/footage"],
  [{ fs: "smb", server: "office-nas.local", share: "footage" }, "smb://office-nas/footage"],
  [{ fs: "smb", server: "office-nas._smb._tcp.local", share: "footage" }, "smb://office-nas/footage"],
  [{ fs: "smb", server: "Office-NAS.local.", share: "footage" }, "smb://office-nas/footage"],
  [{ fs: "afp", server: "office-nas._afpovertcp._tcp.local", share: "Footage" }, "afp://office-nas/footage"],
  [{ fs: "smb", server: "office-nas", share: "/Footage/" }, "smb://office-nas/footage"],
  [{ fs: "nfs", server: "office-nas", share: "/volume1/Footage/" }, "nfs://office-nas/volume1/Footage"],
  [{ fs: "smb", server: "office-nas", share: `Vid${E_NFD}o` }, `smb://office-nas/vid${E_NFC}o`],
  [{ fs: "smb", server: "office-nas", share: `Vid${E_NFC}o` }, `smb://office-nas/vid${E_NFC}o`],
  [{ uuid: "5a1e0c7d-0b1f-4c2e-9a6b-3d4e5f607182" }, "vol:5A1E0C7D-0B1F-4C2E-9A6B-3D4E5F607182"],
  [{ fs: "smb", server: "office-nas", share: "footage", uuid: "5a1e0c7d" }, "smb://office-nas/footage"],
  [{ server: "office-nas", share: "footage" }, undefined],
  [{}, undefined],
];

/** [old path, new path, the folder change or null] */
const MOVES: [string, string, PathMove | null][] = [
  // mounted again at another path
  ["/Volumes/footage/2025/a.mov", "/Volumes/footage-1/2025/a.mov", { from: "/Volumes/footage", to: "/Volumes/footage-1" }],
  // root paths: a folder moved into another
  ["2025/June/C0012.MP4", "Archive/2025/June/C0012.MP4", { from: "2025", to: "Archive/2025" }],
  ["Shoots/2025/a.mov", "Archive/2025/a.mov", { from: "Shoots", to: "Archive" }],
  ["/Volumes/footage/2025/a.mov", "/Volumes/footage/Archive/2025/a.mov", { from: "/Volumes/footage", to: "/Volumes/footage/Archive" }],
  ["/a/b.mov", "/x/a/b.mov", { from: "", to: "/x" }],
  ["/x/a/b.mov", "/a/b.mov", { from: "/x", to: "" }],
  // the file's own name changed, the same path, or no folder in the shared end
  ["2025/a.mov", "2025/b.mov", null],
  ["/Volumes/footage/a.mov", "/Volumes/footage/a.mov", null],
  ["a.mov", "2025/a.mov", null],
  // NFD and NFC are one text, given back in NFC
  [`/Volumes/Vid${E_NFD}o/2025/a.mov`, `/Volumes/Archive/Vid${E_NFC}o/2025/a.mov`, { from: "/Volumes", to: "/Volumes/Archive" }],
  [`/Volumes/Vid${E_NFC}o/a.mov`, `/Volumes/T${E_NFD}l${E_NFD}/Vid${E_NFD}o/a.mov`, { from: "/Volumes", to: `/Volumes/T${E_NFC}l${E_NFC}` }],
  [`/Volumes/Vid${E_NFD}o/a.mov`, `/Volumes/Clips/a.mov`, { from: `/Volumes/Vid${E_NFC}o`, to: "/Volumes/Clips" }],
  // Windows separators
  ["Z:\\footage\\2025\\a.mov", "Z:\\footage\\Archive\\2025\\a.mov", { from: "Z:\\footage", to: "Z:\\footage\\Archive" }],
  ["/Volumes/footage/2025/a.mov", "F:\\2025\\a.mov", { from: "/Volumes/footage", to: "F:" }],
  // the longest shared end wins, a folder's name included ("footage" on both sides)
  ["\\\\office-nas\\footage\\2025\\a.mov", "/Volumes/footage/2025/a.mov", { from: "\\\\office-nas", to: "/Volumes" }],
  ["Z:\\x\\a.mov", "Z:/x/a.mov", null],
];

/** [path, folder change, the path after it or null] */
const APPLIED: [string, PathMove, string | null][] = [
  ["2025/July/b.mov", { from: "2025", to: "Archive/2025" }, "Archive/2025/July/b.mov"],
  ["2025", { from: "2025", to: "Archive/2025" }, "Archive/2025"],
  ["20251/b.mov", { from: "2025", to: "Archive/2025" }, null],
  ["/a/c.mov", { from: "", to: "/x" }, "/x/a/c.mov"],
  ["/x/a/c.mov", { from: "/x", to: "" }, "/a/c.mov"],
  ["/Volumes/footage/2025/b.mov", { from: "/Volumes/footage", to: "F:" }, "F:\\2025\\b.mov"],
  ["Z:\\footage\\2025\\b.mov", { from: "Z:\\footage", to: "/Volumes/footage" }, "/Volumes/footage/2025/b.mov"],
  [`/Volumes/Vid${E_NFD}o/b.mov`, { from: `/Volumes/Vid${E_NFC}o`, to: "/Volumes/Clips" }, "/Volumes/Clips/b.mov"],
];

/** [disk path on a computer, root path, the file's path there] */
const JOINED: [string, string, string][] = [
  ["/Volumes/footage-1", "2025/June/C0012.MP4", "/Volumes/footage-1/2025/June/C0012.MP4"],
  ["/Volumes/footage/", "a.mov", "/Volumes/footage/a.mov"],
  ["/", "Users/tiny/Movies/a.mov", "/Users/tiny/Movies/a.mov"],
  ["/mnt/footage", "/2025/a.mov", "/mnt/footage/2025/a.mov"],
  ["/mnt/footage", "", "/mnt/footage"],
  ["Z:\\", "2025/a.mov", "Z:\\2025\\a.mov"],
  ["\\\\office-nas\\footage", "2025/a.mov", "\\\\office-nas\\footage\\2025\\a.mov"],
];

describe("places", () => {
  it.each(ROOT_KEYS)("rootKey %j", (disk, key) => expect(rootKey(disk)).toBe(key));
  it.each(MOVES)("derivedMove %s → %s", (from, to, move) => expect(derivedMove(from, to)).toEqual(move));
  it.each(APPLIED)("applyMove %s", (path, move, to) => expect(applyMove(path, move)).toBe(to));
  it.each(JOINED)("joinRoot %s + %s", (dir, rel, path) => expect(joinRoot(dir, rel)).toBe(path));

  it("a move found from one file takes the others along", () => {
    const m = derivedMove("/Volumes/footage/2025/June/a.mov", "/Volumes/footage-1/Archive/2025/June/a.mov")!;
    expect(applyMove("/Volumes/footage/2025/July/b.mov", m)).toBe("/Volumes/footage-1/Archive/2025/July/b.mov");
  });
});
