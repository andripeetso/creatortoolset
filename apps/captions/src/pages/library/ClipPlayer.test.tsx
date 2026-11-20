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

// the player's skin is its own chunk (React.lazy): rendered, then that chunk waited for
const skin = () => act(async () => void (await import("./SkinPlayer")));
const open = async (a: AssetCard = card) => {
  await act(async () => r.render(<ClipPlayer asset={a} detail={null} media={createRef()} startAt={0} />));
  await skin();
};
const openWith = async (detail: unknown) => {
  await act(async () => r.render(<ClipPlayer asset={card} detail={detail as AssetDetail} media={createRef()} startAt={0} />));
  await skin();
};
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
  const openNone = async (a: AssetCard = card) => {
    await act(async () => r.render(<ClipPlayer asset={a} detail={null} media={createRef()} startAt={0} serverPlays={false} />));
    await skin();
  };

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

  // 11-19: an original on a NAS share that answered late was left for a proxy that doesn't exist ("Proxies aren't uploaded")
  it("with no proxy anywhere, a slow original is waited out, never left", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await openNone();
    await fire("waiting");
    await act(async () => void vi.advanceTimersByTime(10_000));
    expect(video().getAttribute("src")).toBe("ctlocal://media/a");
    expect(badge()).toBe("Original");
    expect(host.textContent).not.toContain("Proxies aren't uploaded");
  });

  it("with no proxy anywhere, an original that errors is asked for again (this computer asked too), then said, with Retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await openNone();
    const asked = post.mock.calls.length;
    for (let n = 1; n <= 3; n++) {
      await fire("error");
      await act(async () => void (await vi.advanceTimersByTimeAsync(1500 * n)));
      expect(video().getAttribute("src")).toBe(`ctlocal://media/a?try=${n}`);
    }
    expect(post.mock.calls.length).toBeGreaterThan(asked);
    await fire("error"); // the last try failed too
    expect(host.textContent).toContain("The original on this computer didn't open.");
    expect(host.textContent).not.toContain("Proxies aren't uploaded");
    await act(async () => void button("Retry")!.click()); // replaced (app wording rule: the button is "Retry")
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(video().getAttribute("src")).toBe("ctlocal://media/a?try=4");
  });
});

describe("where a clip is, when this Mac cannot play it (decision 5, A4/A5)", () => {
  const openNone = async (a: AssetCard = card) => {
    await act(async () => r.render(<ClipPlayer asset={a} detail={null} media={createRef()} startAt={0} serverPlays={false} />));
    await skin();
  };

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

  it("an address that failed before the player was on the page (no error event to hear) is said all the same", async () => {
    answer = undefined;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ libraries: [{ id: "lib", name: "Tiny Acrobatics", storage: "local", settings: { upload: "originals" } }] })));
    const failed = vi.spyOn(HTMLMediaElement.prototype, "error", "get").mockReturnValue({ code: 4 } as MediaError);
    await openWith({ state: "ready", jobs: [] });
    await act(async () => {});
    expect(host.textContent).toContain("Can't play this format here");
    failed.mockRestore();
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

// 11-19 (Andri): Video.js's skin replaces the window's own controls and the strip under the player
describe("the player", () => {
  const strip = { ...card, spriteUrl: "/api/library/media/v1/sprite?s=144x256", width: 1080, height: 1920 };
  it("plays in the skin, its bar previewing the clip's strip (thumbs.vtt); no strip of frames under it", async () => {
    await open(strip);
    const v = host.querySelector(".video-skin video")!;
    expect(v).not.toBeNull();
    expect(v.hasAttribute("controls")).toBe(false);
    expect(v.querySelector('track[kind="metadata"][label="thumbnails"]')!.getAttribute("src")).toBe("/api/library/media/v1/thumbs.vtt");
    expect(host.querySelector("[data-filmstrip]")).toBeNull();
    await act(async () => r.unmount());
    r = createRoot(host);
    await open(card); // no strip: no preview track
    expect(host.querySelector("track")).toBeNull();
  });

  it("its one accent is the workspace colour (violet follows <html data-tint>)", async () => {
    await open(strip);
    const skin = host.querySelector<HTMLElement>(".video-skin")!;
    expect(skin.style.getPropertyValue("--media-accent-color")).toBe("rgb(var(--violet-600))");
    expect(skin.style.getPropertyValue("--media-object-fit")).toBe("contain");
  });

  it("the picture before play fills the player and is contained in it: the skin's layered rule is restated outside any layer", async () => {
    await open(strip);
    const css = document.getElementById("video-skin-css")!.textContent!;
    // the app's own `img { height: auto }` is unlayered and would win over the skin's @layer rule (an upright picture cropped)
    const at = css.lastIndexOf(".media-skin .media-poster-image { height: 100%; }");
    expect(at).toBeGreaterThan(0);
    // at the top level of the sheet: every block opened before it is closed, so it is in no @layer
    const before = css.slice(0, at);
    expect(before.split("{").length).toBe(before.split("}").length);
  });

  it("a turned clip is a plain video with no bar: a click plays and pauses", async () => {
    await open({ ...strip, turn: 90 });
    expect(host.querySelector(".video-skin")).toBeNull();
    const v = video();
    expect(v.hasAttribute("controls")).toBe(false);
    await act(async () => v.pause());
    await act(async () => void v.click());
    expect(v.paused).toBe(false);
    await act(async () => void v.click());
    expect(v.paused).toBe(true);
  });

  it("a sound plays in the window's own audio controls", async () => {
    await open({ ...card, kind: "audio" });
    expect(host.querySelector("audio[controls]")).not.toBeNull();
    expect(host.querySelector(".video-skin")).toBeNull();
  });

  it("muted by the window: the badge first, then Sound on, both over the skin", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValueOnce(new DOMException("no", "NotAllowedError")).mockResolvedValue(undefined);
    await open(strip);
    await act(async () => {});
    const row = host.querySelector("[data-player] > div.absolute.left-2")!;
    expect([...row.children].map((c) => c.textContent)).toEqual(["Original", "Sound on"]);
    play.mockRestore();
  });
});

describe("the clip's keys", () => {
  it("← → and Space inside the player are the player's; outside they move between clips", async () => {
    const { ownKeys } = await import("./ClipPanel");
    await open(card);
    expect(ownKeys(host.querySelector(".video-skin"))).toBe(true);
    expect(ownKeys(host.querySelector("video"))).toBe(true);
    const outside = document.createElement("div");
    document.body.append(outside);
    expect(ownKeys(outside)).toBe(false);
    outside.remove();
  });
});
