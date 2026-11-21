// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usePlayFrom, type Local } from "./play-here";

// The player's src as the hook gives it: asked for first in the Mac app, the server's when a local file fails, and never
// the last file's src for a new one.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let now: ReturnType<typeof usePlayFrom>;
const shown: (string | undefined)[] = [];
const flush = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));

function Player({ server, local }: { server: string; local: Local | undefined | (() => Promise<Local | undefined>) }) {
  now = usePlayFrom(server, local);
  shown.push(now.src);
  return null;
}
const show = (server: string, local?: Local | (() => Promise<Local | undefined>)) => act(() => root.render(<Player server={server} local={local} />));

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  shown.length = 0;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.macPlaces;
});

describe("a player's src", () => {
  it("plays the server copy at once outside the Mac app", async () => {
    await show("/play/1", () => Promise.resolve("ctlocal://media/one"));
    expect(shown).toEqual(["/play/1"]);
  });

  it("in the Mac app: nothing while asked, the local file once found, the server's after the local file fails", async () => {
    document.documentElement.dataset.macPlaces = "1";
    await show("/play/1", () => Promise.resolve("ctlocal://media/one"));
    expect(shown[0]).toBeUndefined();
    await flush();
    expect(now.src).toBe("ctlocal://media/one");
    act(() => void now.onError());
    expect(now.src).toBe("/play/1");
    // the server copy failing too stays on it (no loop back to the local file)
    act(() => void now.onError());
    expect(now.src).toBe("/play/1");
  });

  it("a new file never starts with the last file's src", async () => {
    document.documentElement.dataset.macPlaces = "1";
    await show("/play/1", () => Promise.resolve("ctlocal://media/one"));
    await flush();
    shown.length = 0;
    await show("/play/2", () => Promise.resolve("ctlocal://media/two"));
    expect(shown).not.toContain("ctlocal://media/one");
    await flush();
    expect(now.src).toBe("ctlocal://media/two");
  });
});
