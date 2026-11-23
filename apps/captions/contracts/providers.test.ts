import { describe, expect, it } from "vitest";
import { isDefaultHome, parseMachine } from "./providers";

describe("parseMachine", () => {
  it("keeps what a computer reports and drops what doesn't fit", () => {
    expect(parseMachine({ os: "mac", host: " studio ", cpu: "Apple M2", cpus: 8.4, memGb: 16, load: 0.25, freeGb: 99, gpu: "" })).toEqual({
      os: "mac", host: "studio", cpu: "Apple M2", cpus: 8, memGb: 16, load: 0.25,
    });
    expect(parseMachine({ cpus: 0, memGb: 16 })).toBeUndefined();
    expect(parseMachine("nope")).toBeUndefined();
    expect(parseMachine(null)).toBeUndefined();
  });
  it("keeps a Cache folder only as a plain absolute path", () => {
    const cache = (cacheFolder: unknown) => parseMachine({ cpus: 8, memGb: 16, cacheFolder })?.cacheFolder;
    expect(cache("/Volumes/SSD/Creator Toolset Cache")).toBe("/Volumes/SSD/Creator Toolset Cache");
    expect(cache("")).toBe(""); // none: the server forgets the last one
    const picked = (cacheFolderPicked: unknown) => parseMachine({ cpus: 8, memGb: 16, cacheFolder: "/Volumes/SSD/c", cacheFolderPicked })?.cacheFolderPicked;
    expect([picked(true), picked(false), picked("yes"), picked(undefined)]).toEqual([true, false, undefined, undefined]);
    // a folder refused: its flag goes with it
    expect(parseMachine({ cpus: 8, memGb: 16, cacheFolder: "/Volumes/SSD/../etc", cacheFolderPicked: true })?.cacheFolderPicked).toBeUndefined();
    for (const bad of ["relative/cache", "/Volumes/SSD/../../etc", `/${"x".repeat(300)}`, 7, null]) expect(cache(bad)).toBeUndefined();
  });
  it("keeps good disks, drops bad ones, and keeps a network share's server", () => {
    const m = parseMachine({ cpus: 8, memGb: 16, disks: [
      { path: "/", name: "System disk", freeGb: 50, totalGb: 460 },
      { path: "/Volumes/TEAM", name: "TEAM", freeGb: 2800, network: true, server: "nas-1" },
      { path: "/Volumes/Card", name: "Card", freeGb: 5 },
      { path: "", name: "x", freeGb: 1 },
      { path: "/Volumes/y", name: "y", freeGb: -1 },
    ] });
    expect(m?.disks).toEqual([
      { path: "/", name: "System disk", freeGb: 50, totalGb: 460 },
      { path: "/Volumes/TEAM", name: "TEAM", freeGb: 2800, network: true, server: "nas-1" },
      { path: "/Volumes/Card", name: "Card", freeGb: 5 },
    ]);
    expect(m?.disks?.[2]).not.toHaveProperty("totalGb");
  });
  it("keeps a share's kind and name only when they are plain names that can go into a command", () => {
    const disks = (share: string) => parseMachine({ cpus: 8, memGb: 16, disks: [{ path: "/Volumes/F", name: "F", freeGb: 1, network: true, server: "nas", fs: "smb", share }] })?.disks?.[0];
    expect(disks("Team Footage")).toMatchObject({ fs: "smb", share: "Team Footage" });
    expect(disks("x'; rm -rf ~ #")).not.toHaveProperty("share");
    expect(disks("x$(id)")).not.toHaveProperty("share");
  });
  it("keeps a volume's id, and away only for a share", () => {
    const [vol, nas, odd] = parseMachine({ cpus: 8, memGb: 16, disks: [
      { path: "/", name: "Macintosh HD", freeGb: 1, uuid: "AAAA0000-0000-4000-8000-00000000000A", away: true },
      { path: "/Volumes/F", name: "F", freeGb: 1, network: true, away: true },
      { path: "/Volumes/G", name: "G", freeGb: 1, uuid: "../x" },
    ] })!.disks!;
    expect(vol).toEqual({ path: "/", name: "Macintosh HD", freeGb: 1, uuid: "AAAA0000-0000-4000-8000-00000000000A" });
    expect(nas).toMatchObject({ network: true, away: true });
    expect(odd).not.toHaveProperty("uuid");
  });
});

describe("isDefaultHome", () => {
  it("is the tool's own folder only, so it is never saved as an account folder", () => {
    expect(isDefaultHome("claude", "/Users/tiny/.claude")).toBe(true);
    expect(isDefaultHome("claude", "/Users/tiny/.claude/")).toBe(true);
    expect(isDefaultHome("claude", "/Users/tiny/.claude-work")).toBe(false);
    expect(isDefaultHome("codex", "/Users/tiny/.codex")).toBe(true);
    expect(isDefaultHome("codex", "/Users/tiny/.claude")).toBe(false);
    expect(isDefaultHome("claude", "/Users/tiny/accounts/work/.claude")).toBe(false); // a second account kept in a folder of that name
  });
});
