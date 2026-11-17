// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetCard } from "@contracts/library";
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

  it("a clip not on a computer plays the server's address, asking nothing", async () => {
    await open({ ...card, onMac: undefined });
    expect(post).not.toHaveBeenCalled();
    expect(video().getAttribute("src")).toBe("/api/library/media/v1/play");
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
