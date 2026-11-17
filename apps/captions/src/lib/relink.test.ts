import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/local-files", async (real) => ({
  ...(await real<typeof import("@/lib/local-files")>()),
  askMediaFolder: vi.fn(async () => ["/Users/tiny/Moved"]),
}));

import { askMediaFolder } from "@/lib/local-files";
import { allowFolders, awayLine, candidates, findOriginals, foldersToAllow, openOriginals, relink, whyOf } from "./relink";

// A Tiny Acrobatics shoot as the timeline names it, and the same files on another computer.
const OLD = "/Volumes/Tiny Drive/Süvi lõik";
const on = (files: string[]) => {
  const asked: string[] = [];
  const exists = vi.fn(async (p: string) => (asked.push(p), files.includes(p)));
  return { exists, asked };
};

describe("finding a timeline's files in another folder", () => {
  it("tries the end of the path under the picked folder, longest first", () => {
    expect(candidates(`${OLD}/cam/a.mov`, "/Users/tiny/Moved/")).toEqual([
      "/Users/tiny/Moved/Volumes/Tiny Drive/Süvi lõik/cam/a.mov",
      "/Users/tiny/Moved/Tiny Drive/Süvi lõik/cam/a.mov",
      "/Users/tiny/Moved/Süvi lõik/cam/a.mov",
      "/Users/tiny/Moved/cam/a.mov",
      "/Users/tiny/Moved/a.mov",
    ]);
  });

  it("the first file found gives the folder change for the rest: one look each", async () => {
    const NEW = "/Users/tiny/Moved";
    const { exists, asked } = on([`${NEW}/cam/a.mov`, `${NEW}/cam/b.mov`, `${NEW}/sound/vo 1.wav`]);
    const found = await relink([`${OLD}/cam/a.mov`, `${OLD}/cam/b.mov`, `${OLD}/sound/vo 1.wav`, `${OLD}/gone.mov`], NEW, exists);
    expect(found).toEqual({
      [`${OLD}/cam/a.mov`]: `${NEW}/cam/a.mov`,
      [`${OLD}/cam/b.mov`]: `${NEW}/cam/b.mov`,
      [`${OLD}/sound/vo 1.wav`]: `${NEW}/sound/vo 1.wav`,
    });
    // b and vo 1 were found on the first try, with a's folder change
    expect(asked.filter((p) => p.endsWith("b.mov"))).toEqual([`${NEW}/cam/b.mov`]);
    expect(asked.filter((p) => p.endsWith("vo 1.wav"))).toEqual([`${NEW}/sound/vo 1.wav`]);
  });

  it("finds files dropped loose in one folder by their names", async () => {
    const { exists } = on(["/Users/tiny/All/a.mov", "/Users/tiny/All/vo.wav"]);
    expect(await relink([`${OLD}/cam/a.mov`, `${OLD}/sound/vo.wav`], "/Users/tiny/All", exists)).toEqual({
      [`${OLD}/cam/a.mov`]: "/Users/tiny/All/a.mov",
      [`${OLD}/sound/vo.wav`]: "/Users/tiny/All/vo.wav",
    });
  });

  it("Find the original files: what is where the timeline says stays, the rest is looked for in the folder picked", async () => {
    const { exists } = on([`${OLD}/a.mov`, "/Users/tiny/Moved/b.mov"]);
    const before = { paths: { s1: `${OLD}/a.mov`, s2: `${OLD}/b.mov`, s3: `${OLD}/c.mov` }, found: {}, folders: [OLD], tried: false };
    const o = await findOriginals(before, "a1.1", exists);
    expect(askMediaFolder).toHaveBeenCalledWith(OLD);
    // the Mac app's answer is every folder allowed, the timeline's own (a decomposed ü) not among them
    expect(o).toMatchObject({ found: { s2: "/Users/tiny/Moved/b.mov" }, folders: ["/Users/tiny/Moved"], tried: true });
    vi.mocked(askMediaFolder).mockResolvedValueOnce([OLD.normalize("NFD"), "/Users/tiny/Moved"]);
    expect((await findOriginals(before, "a1.1", exists)).found).toEqual({ s1: `${OLD}/a.mov`, s2: "/Users/tiny/Moved/b.mov" });
    // the folder picked was allowed before: looked in all the same. What the Mac app plays where the timeline says counts,
    // whatever its own grant list holds (the app's answer decides, never the page's copy of that list)
    vi.mocked(askMediaFolder).mockResolvedValueOnce(["/Users/tiny/Moved"]);
    expect((await findOriginals({ ...before, folders: ["/Users/tiny/Moved"] }, "a1.1", exists)).found).toEqual({ s1: `${OLD}/a.mov`, s2: "/Users/tiny/Moved/b.mov" });
    // cancelled: nothing changes
    vi.mocked(askMediaFolder).mockResolvedValueOnce([]);
    expect(await findOriginals(before, "a1.1", exists)).toBe(before);
  });
});

describe("an edit's files in a Settings → Folders folder (the Mac's own grant list empty)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const DRIVE = "/Volumes/Tiny Drive/Shoots";
  const paths = { s1: `${DRIVE}/raw/desktop.mp4`, s2: `${DRIVE}/raw/phone.mp4`, m1: `${DRIVE}/MUSIC/song.m4a` };
  /** the Mac app's mediaAccess: no open-panel grants at all, and `states` for placesState */
  const mac = (states: Record<string, string>, disks: Record<string, string> = {}) => {
    const postMessage = vi.fn(async (b: Record<string, unknown>) =>
      b.list ? { granted: [] } : b.placesState ? { states, disks } : b.folderGrant ? { granted: true } : null);
    vi.stubGlobal("window", { webkit: { messageHandlers: { mediaAccess: { postMessage } } } });
    return postMessage;
  };
  const all = (state: string) => Object.fromEntries(Object.values(paths).map((p) => [p, state]));

  it("plays every file the Mac says is here, though nothing is in its grant list, and reads none of them", async () => {
    mac(all("here"));
    const { exists } = on([]);
    const o = await openOriginals(paths, "ed.1", exists);
    expect(o.found).toEqual(paths);
    expect(o.folders).toEqual([]);
    expect(exists).not.toHaveBeenCalled();
    expect(awayLine(o)).toBeNull();
  });

  it("a drive that isn't connected says so, by its name", async () => {
    mac(all("disk_away"), Object.fromEntries(Object.values(paths).map((p) => [p, "Tiny Drive"])));
    const o = await openOriginals(paths, "ed.2", on([]).exists);
    expect(o.found).toEqual({});
    expect(awayLine(o)).toBe("Tiny Drive isn't connected");
    expect(whyOf(o, "s1")).toBe("Tiny Drive isn't connected");
  });

  it("a folder waiting for an OK: Needs your OK, and nothing is allowed until Allow is pressed", async () => {
    const postMessage = mac({ ...all("here"), [paths.s2]: "needs_ok" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ serverDisks: [], folders: [
      { id: "f_1", role: "footage", name: "Shoots", origin: { host: "dev_1", path: DRIVE }, make: false, createdAt: 0, reach: {} },
      { id: "f_2", role: "footage", name: "Other", origin: { host: "dev_1", path: "/Volumes/Other" }, make: false, createdAt: 0, reach: {} },
    ] }) })));
    const o = await openOriginals(paths, "ed.3", on([]).exists);
    expect(awayLine(o)).toBe("Needs your OK");
    const folders = await foldersToAllow(o);
    expect(folders.map((f) => f.id)).toEqual(["f_1"]);
    expect(postMessage.mock.calls.some(([b]) => "folderGrant" in b)).toBe(false); // no prompt by itself
    postMessage.mockImplementation(async (b) => (b.placesState ? { states: all("here"), disks: {} } : b.folderGrant ? { granted: true } : null));
    const after = await allowFolders(o, folders, "ed.3", on([]).exists);
    expect(postMessage).toHaveBeenCalledWith({ folderGrant: { path: DRIVE, folder: "f_1" } });
    expect(after.found).toEqual(paths);
  });

  it("an older Mac app that doesn't answer placesState: each file is read through the app", async () => {
    vi.stubGlobal("window", { webkit: { messageHandlers: { mediaAccess: { postMessage: async () => ({ granted: [] }) } } } });
    const { exists } = on([paths.s1]);
    const o = await openOriginals(paths, "ed.4", exists);
    expect(o.found).toEqual({ s1: paths.s1 });
    expect(o.away?.s2).toEqual({ state: "not_granted" }); // outside its open-panel folders: its gate refuses it
  });
});
