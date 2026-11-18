import { afterEach, describe, expect, it, vi } from "vitest";
import { pairThisMac } from "./thisMac";

// Settings → Folders' "This Mac" on a server this Mac isn't on yet: added with the AI left as it is
const bridge = (state: object) => {
  const postMessage = vi.fn(async (m: string) => (m === "pair" ? { ...state, paired: true, device: "dev_1" } : state));
  vi.stubGlobal("window", { webkit: { messageHandlers: { thisMac: { postMessage } } } });
  return postMessage;
};
afterEach(() => vi.unstubAllGlobals());

describe("pairThisMac", () => {
  it("pairs through the app that says it can, and gives the device", async () => {
    const post = bridge({ aiOn: false, paired: false, pairs: true });
    expect((await pairThisMac())?.device).toBe("dev_1");
    expect(post.mock.calls.map(([m]) => m)).toEqual(["state", "pair"]);
  });

  it("never sends pair to an app from before (its unknown asks switch the AI on)", async () => {
    const post = bridge({ aiOn: false, paired: false });
    expect(await pairThisMac()).toBeNull();
    expect(post.mock.calls.map(([m]) => m)).toEqual(["state"]);
  });
});
