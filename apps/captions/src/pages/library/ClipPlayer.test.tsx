// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetCard, AssetDetail } from "@contracts/library";
import type { PlaceCheck } from "@contracts/places";
import { ClipPlayer } from "./ClipPlayer";

// What the clip window plays when the original is on a computer: here, the original; away, the proxy (lib/here.ts).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card: AssetCard = { id: "a1", libraryId: "lib", kind: "video", title: "Beach run", versionId: "v1", versionN: 1, tags: [], aiTags: [], state: "ready", onMac: "Studio" };
const root = { key: "smb://office-nas/footage", name: "footage", server: "office-nas" };
const original: PlaceCheck = { state: "here", path: "/Volumes/footage/2025/a.mov", url: "ctlocal://media/a" };

let host: HTMLDivElement;
let r: Root;
let answer: PlaceCheck | undefined;
let post: ReturnType<typeof vi.fn>;
let access: ReturnType<typeof vi.fn>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  r = createRoot(host);
  answer = original;
  post = vi.fn(async () => ({ versions: answer ? { v1: answer } : {} }));
  access = vi.fn(async () => ({ granted: ["/Volumes/footage"] }));
  (window as unknown as { webkit: object }).webkit = { messageHandlers: { thisMac: { postMessage: post }, mediaAccess: { postMessage: access } } };
  document.documentElement.dataset.macPlaces = "1";
});
afterEach(async () => {
  await act(async () => r.unmount());
  host.remove();
  delete (window as unknown as { webkit?: object }).webkit;
  delete document.documentElement.dataset.macPlaces;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const open = (a: AssetCard = card) =>
  act(async () => r.render(<ClipPlayer asset={a} detail={null} media={createRef()} startAt={0} />));
const openWith = (detail: unknown) =>
  act(async () => r.render(<ClipPlayer asset={card} detail={detail as AssetDetail} media={createRef()} startAt={0} />));
const video = () => host.querySelector("video")!;
const badge = () => host.querySelector("span.rounded")?.textContent;
const fire = (type: string) => act(async () => void video().dispatchEvent(new Event(type)));
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text);

describe("without the Mac app's mark", () => {
  it("plays the server's address as before, asks nothing and shows no badge", async () => {
    delete document.documentElement.dataset.macPlaces;
    await open();
    expect(video().getAttribute("src")).toBe("/api/library/media/v1/play");
    expect(post).not.toHaveBeenCalled();
    expect(badge()).toBeUndefined();
  });
});

describe("with it", () => {
  it("plays the original from this computer, never asking the server for it", async () => {
    await open();
    expect(post.mock.calls[0][0]).toBe('places:check:{"library":"lib","versions":["v1"]}');
    expect(video().getAttribute("src")).toBe("ctlocal://media/a");
    expect(badge()).toBe("Original");
  });

  // local-first decision 5: the card's flags are not the test; a folder or place row on this computer may hold the clip
  it("asks this computer for a clip the card does not flag, and plays its file, never the server's", async () => {
    await open({ ...card, onMac: undefined });
    expect(post).toHaveBeenCalled();
    expect(video().getAttribute("src")).toBe("ctlocal://media/a");
    expect(badge()).toBe("Original");
  });

  it("a clip on no computer plays the server's address only after this computer said so", async () => {
    answer = undefined;
    await open({ ...card, onMac: undefined });
    expect(post).toHaveBeenCalled();
    expect(video().getAttribute("src")).toBe("/api/library/media/v1/play");
  });

  it("when the server refuses the clip, the panel says where it is: the place line, else not checked yet", async () => {
    answer = undefined;
    // the library cannot be read: the place line is said as before (no library answer to wait for)
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    await open({ ...card, onMac: undefined, placeWord: { word: "on", computer: "Studio" } });
    await fire("error");
    await act(async () => {});
    expect(host.textContent).toContain("On Studio");
    await open({ ...card, onMac: undefined, placeWord: undefined });
    await fire("error");
    await act(async () => {});
    expect(host.textContent).toContain("Not checked yet");
  });

  it("the original failing takes the proxy at the same second and keeps playing; the original comes back only after a pause", async () => {
    await open();
    video().currentTime = 12.5;
    answer = { state: "away", root };
    await fire("error");
    expect(video().getAttribute("src")).toBe("/api/library/media/v1/play#t=12.5");
    expect(video().paused).toBe(false);
    expect(badge()).toBe("Proxy");
    expect(host.querySelector("span.rounded")!.getAttribute("title")).toBe("The original is on footage (office-nas), which isn't connected");
    // the share is back: a playing proxy stays
    answer = original;
    await act(async () => void window.dispatchEvent(new CustomEvent("mac-places", { detail: { at: 2 } })));
    expect(video().getAttribute("src")).toBe("/api/library/media/v1/play#t=12.5");
    // paused, then played: the original, at that second
    await act(async () => video().pause());
    video().currentTime = 20;
    await act(async () => video().play());
    expect(video().getAttribute("src")).toBe("ctlocal://media/a#t=20");
    expect(badge()).toBe("Original");
  });

  it("the original stalled for 3 seconds takes the proxy; a stall on the proxy waits", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await open();
    video().currentTime = 4;
    await fire("waiting");
    await act(async () => void vi.advanceTimersByTime(2900));
    expect(badge()).toBe("Original");
    await act(async () => void vi.advanceTimersByTime(200));
    expect(video().getAttribute("src")).toBe("/api/library/media/v1/play#t=4");
    await fire("waiting");
    await act(async () => void vi.advanceTimersByTime(5000));
    expect(video().getAttribute("src")).toBe("/api/library/media/v1/play#t=4");
  });

  it("the original failing takes this computer's cached proxy before the server's", async () => {
    answer = { ...original, cached: "ctlocal://media/c" };
    await open();
    video().currentTime = 7;
    answer = { state: "away", root, cached: "ctlocal://media/c" };
    await fire("error");
    expect(video().getAttribute("src")).toBe("ctlocal://media/c#t=7");
    expect(badge()).toBe("Proxy");
  });

  it("Available offline: a clip kept offline plays from the cache, never asking the server", async () => {
    answer = { state: "cached", url: "ctlocal://media/c" };
    await open({ ...card, onMac: undefined, here: true });
    expect(post.mock.calls[0][0]).toBe('places:check:{"library":"lib","versions":["v1"]}');
    expect(video().getAttribute("src")).toBe("ctlocal://media/c");
    expect(badge()).toBe("Proxy");
  });

  it("the server's proxy failing (the internet went) takes the cached proxy at the same second; without one it fails", async () => {
    answer = { state: "away", root };
    await open();
    expect(video().getAttribute("src")).toBe("/api/library/media/v1/play");
    // kept offline meanwhile: a playing proxy is not swapped while it plays
    answer = { state: "away", root, cached: "ctlocal://media/c" };
    await act(async () => void window.dispatchEvent(new CustomEvent("mac-places", { detail: { at: 2 } })));
    expect(video().getAttribute("src")).toBe("/api/library/media/v1/play");
    video().currentTime = 9;
    await fire("error");
    expect(video().getAttribute("src")).toBe("ctlocal://media/c#t=9");
    // the cached file failing has nowhere else to go
    await fire("error");
    expect(video().getAttribute("src")).toBe("ctlocal://media/c#t=9");
  });

  it("an answer saying the original went away while it plays takes the proxy", async () => {
    await open();
    video().currentTime = 3;
    answer = { state: "away", root };
    await act(async () => void window.dispatchEvent(new CustomEvent("mac-places", { detail: { at: 2 } })));
    expect(video().getAttribute("src")).toBe("/api/library/media/v1/play#t=3");
  });

  it("an original outside the allowed folders plays the proxy and offers the folder; allowed, it plays the original", async () => {
    answer = { state: "here", path: "/Volumes/footage/2025/a.mov", needs: "access", folder: "/Volumes/footage", root };
    await open();
    expect(video().getAttribute("src")).toBe("/api/library/media/v1/play");
    answer = original;
    await act(async () => button("Allow access to footage")!.click());
    expect(access).toHaveBeenCalledWith({ ask: "/Volumes/footage" });
    expect(video().getAttribute("src")).toMatch(/^ctlocal:\/\/media\/a/);
    expect(button("Allow access to footage")).toBeUndefined();
  });

  it("a share that needs its login offers Connect", async () => {
    answer = { state: "away", root, needs: "connect" };
    await open();
    post.mockResolvedValueOnce({ ok: true });
    await act(async () => button("Connect")!.click());
    expect(post).toHaveBeenCalledWith('places:connect:{"root":"smb://office-nas/footage"}');
  });

  it("away with no proxy on the server: where the original is, and for the owner why nothing plays", async () => {
    answer = { state: "away", root };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ libraries: [{ id: "lib", name: "Tiny Acrobatics", storage: "local", settings: { upload: "none" } }] })));
    await open();
    await fire("error");
    expect(host.textContent).toContain("The original is on footage (office-nas), which isn't connected");
    expect(host.textContent).toContain("Proxies aren't uploaded for this library, so it plays only where the originals are.");
    expect(host.textContent).not.toContain("Could not play the file");
  });
});

// Upload none (no team shares the library): the server plays nothing of a clip this computer lacks, so no address is asked
describe("under Upload none", () => {
  const openNone = (a: AssetCard = card) =>
    act(async () => r.render(<ClipPlayer asset={a} detail={null} media={createRef()} startAt={0} serverPlays={false} />));

  it("a 'not here' answer (the original missing) never yields a server address, and the panel says where it is", async () => {
    answer = { state: "gone" };
    await openNone({ ...card, onMac: undefined, placeWord: { word: "on", computer: "Studio" } });
    expect(post).toHaveBeenCalled();
    expect(video().getAttribute("src")).toBeNull();
    expect(host.textContent).toContain("The original is missing on this computer");
  });

  it("an away answer with no copy on this computer: no server address, and the disk's line", async () => {
    answer = { state: "away", root };
    await openNone();
    expect(video().getAttribute("src")).toBeNull();
    expect(host.textContent).toContain("The original is on footage (office-nas), which isn't connected");
  });

  it("without the Mac app the server's address is never asked either: the place line is shown", async () => {
    delete document.documentElement.dataset.macPlaces;
    await openNone({ ...card, onMac: undefined, placeWord: { word: "on", computer: "Studio" } });
    expect(video().getAttribute("src")).toBeNull();
    expect(host.textContent).toContain("On Studio");
  });

  it("a copy this computer has still plays from here", async () => {
    answer = { state: "here", path: "/Volumes/footage/2025/a.mov", url: "ctlocal://media/a" };
    await openNone();
    expect(video().getAttribute("src")).toBe("ctlocal://media/a");
  });
});

describe("where a clip is, when this Mac cannot play it (decision 5, A4/A5)", () => {
  const openNone = (a: AssetCard = card) =>
    act(async () => r.render(<ClipPlayer asset={a} detail={null} media={createRef()} startAt={0} serverPlays={false} />));

  it("a clip on none of his computers under Upload none: no server address, and the panel says Not checked yet", async () => {
    answer = undefined;
    await openNone({ ...card, onMac: undefined });
    expect(video().getAttribute("src")).toBeNull();
    expect(host.textContent).toContain("Not checked yet");
  });

  it("a clip missing on a computer under Upload none: no server address, and the panel says Missing on that computer", async () => {
    answer = undefined;
    await openNone({ ...card, onMac: undefined, placeWord: { word: "missing", computer: "Studio" } });
    expect(video().getAttribute("src")).toBeNull();
    expect(host.textContent).toContain("Missing on Studio");
  });

  it("a clip a computer holds (a listed folder or a place row) asks this Mac and never sets a server /play address", async () => {
    answer = original;
    await open({ ...card, onMac: undefined, placeWord: { word: "on", computer: "Studio" } });
    expect(post).toHaveBeenCalled();
    expect(video().getAttribute("src")).toBe("ctlocal://media/a");
    expect(video().getAttribute("src")).not.toMatch(/\/api\/library\/media\/.*\/play/);
  });
});

// Hosted originals: the server plays the original, so a file this window cannot play is not sent to a place
describe("under Originals hosted", () => {
  it("a failed server original is not 'away': the player keeps to its own note, and nothing asks for a place", async () => {
    answer = { state: "away", root };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ libraries: [{ id: "lib", name: "Tiny Acrobatics", storage: "local", settings: { upload: "originals" } }] })));
    await open();
    await fire("error");
    expect(host.textContent).not.toContain("The original is on footage (office-nas), which isn't connected");
    expect(host.textContent).not.toContain("Proxies aren't uploaded");
  });

  it("a file the window cannot play says Can't play this format here, with Download of the original", async () => {
    answer = undefined;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ libraries: [{ id: "lib", name: "Tiny Acrobatics", storage: "local", settings: { upload: "originals" } }] })));
    await openWith({ state: "ready", jobs: [] });
    await fire("error");
    await act(async () => {});
    expect(host.textContent).toContain("Can't play this format here");
    expect(host.querySelector('a[href="/api/library/media/v1/source"]')?.textContent).toContain("Download");
  });

  it("the library's answer comes first: no away line shows while it is pending", async () => {
    answer = undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    await openWith({ state: "ready", jobs: [] });
    await fire("error");
    expect(host.textContent).not.toContain("Not checked yet");
    expect(host.textContent).not.toContain("This clip isn't on the server.");
  });
});

describe("under Proxies hosted, with no proxy for the clip", () => {
  it("says This clip isn't on the server.", async () => {
    answer = undefined;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ libraries: [{ id: "lib", name: "Tiny Acrobatics", storage: "local", settings: { upload: "proxies" } }] })));
    await openWith({ state: "ready", jobs: [] });
    await fire("error");
    await act(async () => {});
    expect(host.textContent).toContain("This clip isn't on the server.");
    expect(host.textContent).not.toContain("Can't play this format here");
  });
});
