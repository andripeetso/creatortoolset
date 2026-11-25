import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posted: string[] = [];
vi.mock("@/lib/thisMac", () => ({ thisMacBridge: () => ({ postMessage: async (m: string) => (posted.push(m), { ok: true }) }) }));
vi.mock("@/lib/local-files", async (real) => ({
  ...(await real<typeof import("@/lib/local-files")>()),
  listMediaFolders: vi.fn(async () => [] as string[]),
  askMediaFolder: vi.fn(async () => [] as string[]),
}));
vi.mock("@/lib/library", () => ({ getAsset: vi.fn(async () => ({ sourcePath: "/Users/tiny/Desktop/jump.mp4" })) }));

import { askMediaFolder, listMediaFolders } from "@/lib/local-files";
import { getAsset } from "@/lib/library";
import { revealClip, revealsVersion } from "./clip";

// A Tiny Acrobatics clip sent from the Desktop to a server elsewhere: Show in Finder grants its folder first.
describe("Show in Finder for a clip on a server elsewhere", () => {
  beforeEach(() => {
    posted.length = 0;
    vi.stubGlobal("location", { hostname: "studio.example.com" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("asks for the clip's folder when it isn't granted, and shows nothing when the panel closes without it", async () => {
    expect(await revealClip("l1", "a1", "/Users/tiny/Desktop/jump.mp4")).toBe("");
    expect(askMediaFolder).toHaveBeenCalledWith("/Users/tiny/Desktop");
    expect(posted).toEqual([]);
  });

  it("shows the file once its folder is granted, and asks the server for the path when the page has none", async () => {
    vi.mocked(askMediaFolder).mockResolvedValueOnce(["/Users/tiny/Desktop"]);
    expect(await revealClip("l1", "a1")).toBeNull();
    expect(getAsset).toHaveBeenCalledWith("l1", "a1");
    expect(posted).toEqual(['reveal:{"library":"l1","asset":"a1"}']);
    vi.mocked(listMediaFolders).mockResolvedValueOnce(["/Users/tiny/Desktop"]);
    vi.mocked(askMediaFolder).mockClear();
    expect(await revealClip("l1", "a1", "/Users/tiny/Desktop/jump.mp4")).toBeNull();
    expect(askMediaFolder).not.toHaveBeenCalled();
  });

  it("asks nothing first when the Mac app shows any video file (its mark '2')", async () => {
    vi.stubGlobal("document", { documentElement: { dataset: { macReveal: "2" } } });
    vi.mocked(askMediaFolder).mockClear();
    expect(await revealClip("l1", "a1", "/Users/tiny/Desktop/jump.mp4")).toBeNull();
    expect(askMediaFolder).not.toHaveBeenCalled();
    expect(posted).toEqual(['reveal:{"library":"l1","asset":"a1"}']);
  });

  it("names the version only when asked for one (a clip's original beside its blurred copy)", async () => {
    vi.stubGlobal("document", { documentElement: { dataset: { macReveal: "3" } } });
    expect(revealsVersion()).toBe(true);
    expect(await revealClip("l1", "a1", "/Users/tiny/Desktop/jump.mp4", "v1")).toBeNull();
    expect(posted.at(-1)).toBe('reveal:{"library":"l1","asset":"a1","version":"v1"}');
  });

  it("on the server on this Mac asks nothing first", async () => {
    vi.stubGlobal("location", { hostname: "localhost" });
    vi.mocked(askMediaFolder).mockClear();
    expect(await revealClip("l1", "a1", "/Users/tiny/Desktop/jump.mp4")).toBeNull();
    expect(askMediaFolder).not.toHaveBeenCalled();
  });
});
