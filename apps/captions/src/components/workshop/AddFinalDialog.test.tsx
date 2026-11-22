import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ pathOnMac: vi.fn(), importCopy: vi.fn(), rows: vi.fn(async () => [] as string[]) }));
vi.mock("@/pages/library/Import", () => ({ sourceRowsHere: m.rows }));
vi.mock("@/lib/thisMac", async (orig) => ({ ...(await orig<typeof import("@/lib/thisMac")>()), pathOnMac: m.pathOnMac, importCopy: m.importCopy, importProgress: vi.fn(async () => ({ bytes: 0, of: 0 })), importCancel: vi.fn(async () => ({})) }));
const { copyIn, sendEach } = await import("./AddFinalDialog");

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

describe("several finals dropped at once (sendEach)", () => {
  const video = (name: string) => new File(["x"], name, { type: "video/mp4" });

  it("one that fails doesn't stop the rest; a file that isn't a video is left out", async () => {
    const sent: string[] = [];
    const one = vi.fn(async (f: File) => {
      if (f.name === "B.mp4") throw new Error("Could not upload");
      sent.push(f.name);
    });
    const failed = await sendEach([video("A.mp4"), video("B.mp4"), new File(["x"], "thumb.jpg", { type: "image/jpeg" }), video("C.mov")], one, new AbortController().signal);
    expect(sent).toEqual(["A.mp4", "C.mov"]);
    expect(failed).toEqual(["thumb.jpg: Not a video", "B.mp4: Could not upload"]);
  });

  it("Cancel while one is being added: the rest never start", async () => {
    const ctl = new AbortController();
    const one = vi.fn(async () => ctl.abort());
    expect(await sendEach([video("A.mp4"), video("B.mp4")], one, ctl.signal)).toBeNull();
    expect(one).toHaveBeenCalledTimes(1);
  });

  it("a Cancel before the copy starts copies nothing", async () => {
    m.pathOnMac.mockResolvedValue("/Users/tiny/Movies/final.mp4");
    m.importCopy.mockClear();
    const ctl = new AbortController();
    ctl.abort();
    await expect(copyIn(new File(["x"], "final.mp4"), "/Volumes/Tiny/Projects/Reel", ctl.signal, () => {})).rejects.toThrow();
    expect(m.importCopy).not.toHaveBeenCalled();
  });
});
