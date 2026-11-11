import { afterEach, describe, expect, it, vi } from "vitest";
import { allowOtherDevices, installInMacAi, pathOnMac } from "./thisMac";

const bridgeWith = (postMessage: (m: string) => Promise<unknown>) => vi.stubGlobal("window", { webkit: { messageHandlers: { thisMac: { postMessage } } } });

afterEach(() => vi.unstubAllGlobals());

it("asks the Mac app for access and shows what it answers, nothing when it is on", async () => {
  const asked: string[] = [];
  bridgeWith(async (m) => (asked.push(m), { aiOn: true, paired: true, problem: "Choose this computer's password to turn it on." }));
  expect(await allowOtherDevices()).toBe("Choose this computer's password to turn it on.");
  expect(asked).toEqual(["access"]);
  bridgeWith(async () => ({ aiOn: true, paired: true, problem: null }));
  expect(await allowOtherDevices()).toBeNull();
});

it("says what to do in a browser, where there is no Mac app", async () => {
  vi.stubGlobal("window", {});
  expect(await allowOtherDevices()).toContain("Creator Toolset Mac app");
});

it("says the app did not answer when the bridge fails", async () => {
  bridgeWith(async () => {
    throw new Error("gone");
  });
  expect(await allowOtherDevices()).toContain("did not answer");
});

const withBridge = (answer: unknown) => vi.stubGlobal("window", { webkit: { messageHandlers: { thisMac: { postMessage: vi.fn(async () => answer) } } } });
afterEach(() => vi.unstubAllGlobals());

describe("Install through the Mac app", () => {
  it("is done when the Mac app says ok, and says why when it could not", async () => {
    withBridge({ ok: true });
    expect(await installInMacAi("claude", "ctk_0123456789abcdef")).toBe(true);
    withBridge({ ok: false, problem: "Codex isn't on this Mac." });
    expect(await installInMacAi("codex", "ctk_0123456789abcdef")).toBe("Codex isn't on this Mac.");
  });

  it("is left to the page (the line to run) in a browser and in a Mac app from before it could install", async () => {
    vi.stubGlobal("window", {});
    expect(await installInMacAi("claude", "ctk_0123456789abcdef")).toBeUndefined();
    // an older Mac app answers every unknown question with its state: no `ok` in it
    withBridge({ aiOn: false, paired: false });
    expect(await installInMacAi("claude", "ctk_0123456789abcdef")).toBeUndefined();
  });

  it("asks with the app and the key only", async () => {
    const postMessage = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("window", { webkit: { messageHandlers: { thisMac: { postMessage } } } });
    await installInMacAi("codex", "ctk_0123456789abcdef");
    expect(postMessage).toHaveBeenCalledWith("install:codex:ctk_0123456789abcdef");
  });
});

describe("where a picked file is on this Mac", () => {
  const file = (name: string, size: number, lastModified = 1_700_000_000_000) => new File([new Uint8Array(size)], name, { lastModified });
  const at = (path: string, size: number, modified = 1_700_000_000_000) => ({ path, name: path.split("/").pop(), size, modified });

  it("matches by name and size, and by the time it changed when two picked files share both", async () => {
    withBridge({ files: [at("/a/C0001.MP4", 10), at("/b/C0001.MP4", 10, 1_600_000_000_000), at("/a/C0002.MP4", 20)] });
    expect(await pathOnMac(file("C0002.MP4", 20))).toBe("/a/C0002.MP4");
    expect(await pathOnMac(file("C0001.MP4", 10))).toBe("/a/C0001.MP4");
    expect(await pathOnMac(file("C0001.MP4", 10, 1_600_000_000_500))).toBe("/b/C0001.MP4");
    expect(await pathOnMac(file("C0001.MP4", 11))).toBeUndefined(); // another file of that name
    // the Mac may spell an accented letter as two characters, the page as one
    withBridge({ files: [at("/a/Jõgi.mp4".normalize("NFD"), 30)] });
    expect(await pathOnMac(file("Jõgi.mp4".normalize("NFC"), 30))).toBe("/a/Jõgi.mp4".normalize("NFD"));
  });

  it("leaves it to an upload when it is not sure, in a browser, and in a Mac app from before it could say", async () => {
    withBridge({ files: [at("/a/C0001.MP4", 10), at("/b/C0001.MP4", 10)] });
    expect(await pathOnMac(file("C0001.MP4", 10))).toBeUndefined();
    withBridge({ aiOn: false, paired: false });
    expect(await pathOnMac(file("C0001.MP4", 10))).toBeUndefined();
    vi.stubGlobal("window", {});
    expect(await pathOnMac(file("C0001.MP4", 10))).toBeUndefined();
  });
});
