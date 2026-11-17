import { describe, expect, it } from "vitest";
import { moveLine, searchLine } from "./Missing";

// Missing here's lines: what moved or was found elsewhere, and how far Find missing files is.

describe("Missing here", () => {
  it("says each folder change in one line", () => {
    const footage = { key: "smb://office-nas/footage", name: "footage", server: "office-nas" };
    expect(moveLine({ at: 1, kind: "moved", from: "2025", to: "Archive/2025", count: 48, root: footage })).toBe("Moved: 2025 → Archive/2025 (48 files)");
    expect(moveLine({ at: 1, kind: "moved", from: "", to: "Archive", count: 1, root: footage })).toBe("Moved: footage → Archive (1 file)");
    expect(moveLine({ at: 1, kind: "found", from: "/Volumes/footage/2025", to: "/Volumes/Travel SSD/2025", count: 12, root: { key: "vol:B", name: "Travel SSD" } })).toBe(
      "Found on Travel SSD (12 files)",
    );
    expect(moveLine({ at: 1, kind: "found", from: "/Users/tiny/Movies", to: "/Users/tiny/Clips", count: 2 })).toBe("Found on Clips (2 files)");
  });

  it("says how far the search is, and nothing before the first", () => {
    const s = { library: "lib", running: true, looked: 0, found: 0, left: 0 };
    expect(searchLine(null)).toBeNull();
    expect(searchLine({ ...s, running: false })).toBeNull();
    expect(searchLine(s)).toBe("Looking");
    expect(searchLine({ ...s, left: 12, found: 3 })).toBe("Looking for 12 files · 3 found");
    expect(searchLine({ ...s, running: false, found: 15 })).toBe("Found 15 files");
    expect(searchLine({ ...s, running: false, found: 1, left: 2 })).toBe("Found 1 file · 2 files not found");
    expect(searchLine({ ...s, running: false, left: 2 })).toBe("2 files not found");
  });
});
