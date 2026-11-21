import { afterEach, describe, expect, it, vi } from "vitest";
import { localMediaUrl } from "./local-files";
import { playFrom } from "./play-here";

afterEach(() => vi.unstubAllGlobals());

const SERVER = "/api/review/assets/a1/v/2/play?c=1";
const LOCAL = "/Volumes/Tiny Drive/Projects/Handstand/Handstand_A_D2.preview.mp4";
const mac = (mark?: string) => vi.stubGlobal("document", { documentElement: { dataset: mark ? { macLocalFiles: mark } : {} } });
const says = (state: "here" | "not_here" | "disk_away" | "needs_ok") => async () => ({ states: { [LOCAL]: state }, disks: {} });
const never = async () => {
  throw new Error("not asked");
};

describe("where a Review version plays", () => {
  it("plays the local file only when the Mac app says it is here, else the server copy", async () => {
    mac("3");
    expect(await playFrom(SERVER, LOCAL, says("here"), never)).toBe(localMediaUrl(LOCAL));
    for (const state of ["not_here", "disk_away", "needs_ok"] as const) expect(await playFrom(SERVER, LOCAL, says(state), never)).toBe(SERVER);
    // an older app that doesn't answer placesState: a one-byte read decides
    expect(await playFrom(SERVER, LOCAL, async () => null, async () => true)).toBe(localMediaUrl(LOCAL));
    expect(await playFrom(SERVER, LOCAL, async () => null, async () => false)).toBe(SERVER);
  });

  it("plays the server copy with no local path, in a browser, or in an app that serves no media files", async () => {
    mac("3");
    expect(await playFrom(SERVER, undefined, never, never)).toBe(SERVER);
    mac();
    expect(await playFrom(SERVER, LOCAL, never, never)).toBe(SERVER);
    mac("2");
    expect(await playFrom(SERVER, LOCAL, never, never)).toBe(SERVER);
  });
});
