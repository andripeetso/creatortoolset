// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaceCheck } from "@contracts/places";
import { awayLine, pickSource, useHere, type Here } from "./here";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const root = { key: "smb://office-nas/footage", name: "footage", server: "office-nas" };

describe("pickSource", () => {
  const rows: [PlaceCheck | undefined, ReturnType<typeof pickSource>][] = [
    [{ state: "here", path: "/Volumes/footage/a.mov", url: "ctlocal://media/x" }, { src: "ctlocal://media/x", badge: "Original" }],
    [{ state: "cached", url: "ctlocal://media/c" }, { src: "ctlocal://media/c", badge: "Proxy" }],
    [{ state: "here", path: "/Volumes/footage/a.mov", needs: "access", folder: "/Volumes/footage" }, { src: "/api/library/media/v1/play", badge: "Proxy" }],
    [{ state: "away", root }, { src: "/api/library/media/v1/play", badge: "Proxy" }],
    [{ state: "gone" }, { src: "/api/library/media/v1/play", badge: "Proxy" }],
    [undefined, { src: "/api/library/media/v1/play", badge: "Proxy" }],
  ];
  it.each(rows)("%j", (check, want) => expect(pickSource(check, "v1")).toEqual(want));

  it("says why the original doesn't play here", () => {
    expect(awayLine({ state: "away", root })).toBe("The original is on footage (office-nas), which isn't connected");
    expect(awayLine({ state: "gone" })).toBe("The original is missing here");
    expect(awayLine({ state: "here", path: "/a", url: "ctlocal://media/a" })).toBeNull();
  });
});

describe("useHere", () => {
  let host: HTMLDivElement;
  let r: Root;
  let seen: (Here | null)[];
  let post: ReturnType<typeof vi.fn>;
  let answer: (ask: { library: string; versions: string[] }) => Here;
  function Probe({ library, ids }: { library: string | string[] | null; ids: string[] }) {
    seen.push(useHere(library, ids)[0]);
    return null;
  }
  const show = (library: string | string[] | null, ids: string[]) => act(async () => r.render(createElement(Probe, { library, ids })));
  const asks = () => post.mock.calls.map(([m]) => JSON.parse(String(m).replace(/^places:check:/, "")));
  const last = () => seen[seen.length - 1];

  beforeEach(() => {
    host = document.createElement("div");
    r = createRoot(host);
    seen = [];
    answer = ({ versions }) => Object.fromEntries(versions.map((v) => [v, { state: "here", path: `/f/${v}`, url: `ctlocal://media/${v}` } as PlaceCheck]));
    post = vi.fn(async (m: string) => ({ versions: answer(JSON.parse(m.replace(/^places:check:/, ""))) }));
    (window as unknown as { webkit: object }).webkit = { messageHandlers: { thisMac: { postMessage: post } } };
    document.documentElement.dataset.macPlaces = "1";
  });
  afterEach(async () => {
    await act(async () => r.unmount());
    delete (window as unknown as { webkit?: object }).webkit;
    delete document.documentElement.dataset.macPlaces;
  });

  it("asks nothing and has no answer without the Mac app's mark (the page plays the server's proxy, as before)", async () => {
    delete document.documentElement.dataset.macPlaces;
    await show("lib", ["v1"]);
    expect(post).not.toHaveBeenCalled();
    expect(last()).toBeNull();
  });

  it("asks once the ids are known, and again with the new answer when a disk comes or goes", async () => {
    await show("lib", ["v1"]);
    expect(asks()).toEqual([{ library: "lib", versions: ["v1"] }]);
    expect(last()?.v1).toEqual({ state: "here", path: "/f/v1", url: "ctlocal://media/v1" });
    answer = () => ({ v1: { state: "away", root } });
    await act(async () => void window.dispatchEvent(new CustomEvent("mac-places", { detail: { at: 1 } })));
    expect(post).toHaveBeenCalledTimes(2);
    expect(last()?.v1).toEqual({ state: "away", root });
    // the window back in front asks again too
    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("drops an answer for ids asked before, and asks PLACES_MAX at a time, in each library", async () => {
    let release!: () => void;
    const slow = new Promise<void>((done) => (release = done));
    post.mockImplementationOnce(async () => {
      await slow;
      return { versions: { old: { state: "gone" } } };
    });
    await show("lib", ["old"]);
    const ids = Array.from({ length: 201 }, (_, i) => `v${i}`);
    await show(["lib", "lib2"], ids);
    await act(async () => release());
    expect(last()?.old).toBeUndefined();
    expect(Object.keys(last()!)).toHaveLength(201);
    expect(asks().slice(1).map((a) => [a.library, a.versions.length])).toEqual([["lib", 200], ["lib", 1], ["lib2", 200], ["lib2", 1]]);
  });

  it("an ask that fails is an empty answer: the server's proxy plays", async () => {
    post.mockRejectedValueOnce(new Error("no"));
    await show("lib", ["v1"]);
    expect(last()).toEqual({});
  });
});
