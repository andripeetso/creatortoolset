import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ pathOnMac: vi.fn(), importCopy: vi.fn(), rows: vi.fn(async () => [] as string[]) }));
vi.mock("@/pages/library/Import", () => ({ sourceRowsHere: m.rows }));
vi.mock("@/lib/thisMac", async (orig) => ({ ...(await orig<typeof import("@/lib/thisMac")>()), pathOnMac: m.pathOnMac, importCopy: m.importCopy, importProgress: vi.fn(async () => ({ bytes: 0, of: 0 })), importCancel: vi.fn(async () => ({})) }));
const { copyIn } = await import("./AddFinalDialog");

describe("a final dropped from this Mac (copyIn)", () => {
  const file = new File(["x"], "final.mp4");
  const at = "/Volumes/Studio/FOOTAGE/Shoot/final.mp4";

  it("a file in another library's Media folder is refused as the Mac app says, never uploaded instead", async () => {
    m.pathOnMac.mockResolvedValue(at);
    const said = `${at} is in the Media folder /Volumes/Studio/FOOTAGE: drop the folder with the footage itself`;
    m.importCopy.mockResolvedValue({ copied: [], failed: [{ from: at, error: said }] });
    await expect(copyIn(file, "/Volumes/Tiny/Projects/Reel", new AbortController().signal, () => {})).rejects.toThrow(said);
  });

  it("a file the Mac app can't vouch for as dropped here is refused too, never uploaded instead", async () => {
    m.pathOnMac.mockResolvedValue(at);
    m.importCopy.mockResolvedValue({ copied: [], failed: [{ from: at, error: "Not a file from a drop or a pick in this window." }] });
    await expect(copyIn(file, "/Volumes/Tiny/Projects/Reel", new AbortController().signal, () => {})).rejects.toThrow("Not a file from a drop");
  });

  it("a final in this workspace's own Media folder: null, it goes up from where it is (no copy asked)", async () => {
    m.importCopy.mockClear();
    m.rows.mockResolvedValueOnce(["/Volumes/Tiny/Media"]);
    m.pathOnMac.mockResolvedValue("/Volumes/Tiny/Media/Finals/final.mp4");
    expect(await copyIn(file, "/Volumes/Tiny/Projects/Reel", new AbortController().signal, () => {})).toBeNull();
    expect(m.importCopy).not.toHaveBeenCalled();
  });

  it("a folder the Mac app doesn't copy into: null, so the file is uploaded as before", async () => {
    m.pathOnMac.mockResolvedValue("/Users/tiny/Downloads/final.mp4");
    m.importCopy.mockResolvedValue({ copied: [], failed: [{ from: "/Users/tiny/Downloads/final.mp4", error: "Not a folder this app copies into." }] });
    expect(await copyIn(file, "/Volumes/Tiny/Projects/Reel", new AbortController().signal, () => {})).toBeNull();
  });
});
