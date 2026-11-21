import { afterEach, describe, expect, it, vi } from "vitest";
import { localMediaUrl } from "./local-files";
import { localBytes, playFrom } from "./play-here";

afterEach(() => vi.unstubAllGlobals());

const SERVER = "/api/review/assets/a1/v/2/play?c=1";
const LOCAL = "/Volumes/Tiny Drive/Projects/Handstand/Handstand_A_D2.preview.mp4";
const mac = (mark?: string) => vi.stubGlobal("document", { documentElement: { dataset: mark ? { macLocalFiles: mark } : {} } });
const says = (state: "here" | "not_here" | "disk_away" | "needs_ok") => async () => ({ states: { [LOCAL]: state }, disks: {} });
const never = async (): Promise<never> => {
  throw new Error("not asked");
};
const serves = async () => true;

describe("where a file plays", () => {
  it("plays the local file only when the Mac app says it is here, else the server copy", async () => {
    mac("3");
    expect(await playFrom(SERVER, LOCAL, { said: says("here"), exists: never, serves })).toBe(localMediaUrl(LOCAL));
    for (const state of ["not_here", "disk_away", "needs_ok"] as const) expect(await playFrom(SERVER, LOCAL, { said: says(state), exists: never, serves })).toBe(SERVER);
    // an older app that doesn't answer placesState: a one-byte read decides
    expect(await playFrom(SERVER, LOCAL, { said: async () => null, exists: async () => true, serves })).toBe(localMediaUrl(LOCAL));
    expect(await playFrom(SERVER, LOCAL, { said: async () => null, exists: async () => false, serves })).toBe(SERVER);
  });

  it("plays a Review version's path only while the file there is still that version's (a later render took the path: the server's)", async () => {
    mac("3");
    const file = { path: LOCAL, bytes: 5_000_000 };
    expect(await playFrom(SERVER, file, { said: says("here"), exists: never, serves, size: async () => 5_000_000 })).toBe(localMediaUrl(LOCAL));
    expect(await playFrom(SERVER, file, { said: says("here"), exists: never, serves, size: async () => 5_200_000 })).toBe(SERVER);
    expect(await playFrom(SERVER, file, { said: says("here"), exists: never, serves, size: async () => null }
    // not here at all: no size is read
    expect(await playFrom(SERVER, file, { said: says("not_here"), exists: never, serves, size: never })).toBe(SERVER);)).toBe(SERVER);
  });

  it("reads a local file's size from the Mac app's answer to a one-byte read", async () => {
    vi.stubGlobal("fetch", async () => new Response("x", { status: 206, headers: { "Content-Range": "bytes 0-0/5000000" } }));
    expect(await localBytes("ctlocal://media/abc")).toBe(5_000_000);
    vi.stubGlobal("fetch", async () => new Response("", { status: 403 }));
    expect(await localBytes("ctlocal://media/abc")).toBeNull();
  });

  it("never plays locally what the server keeps from this person (a cut waiting for its blur under Blur faces)", async () => {
    mac("3");
    expect(await playFrom(SERVER, LOCAL, { said: says("here"), exists: never, serves: async () => false })).toBe(SERVER);
  });

  it("takes the Mac app's own URL as it is (a library version it found here)", async () => {
    mac();
    expect(await playFrom(SERVER, "ctlocal://media/abc", { said: never, exists: never, serves: never })).toBe("ctlocal://media/abc");
  });

  it("plays the server copy with no local path, in a browser, or in an app that serves no media files", async () => {
    mac("3");
    expect(await playFrom(SERVER, undefined, { said: never, exists: never, serves: never })).toBe(SERVER);
    mac();
    expect(await playFrom(SERVER, LOCAL, { said: never, exists: never, serves: never })).toBe(SERVER);
    mac("2");
    expect(await playFrom(SERVER, LOCAL, { said: never, exists: never, serves: never })).toBe(SERVER);
  });
});
