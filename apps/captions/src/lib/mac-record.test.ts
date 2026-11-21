// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { askSavePlace, savedOnMac } from "./mac-record";

const said: string[] = [];
const app = (on: boolean) => {
  document.documentElement.dataset.macSaveAs = on ? "1" : "";
  (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { window: { postMessage: (m: string) => said.push(m) } } };
};
const fire = (type: string, detail: unknown) => window.dispatchEvent(new CustomEvent(type, { detail }));

afterEach(() => {
  said.length = 0;
  delete document.documentElement.dataset.macSaveAs;
  vi.restoreAllMocks();
});

describe("Export asks where the video goes before it is made", () => {
  it("an app from before the ask: goes on at once, nothing asked (it saves to Downloads)", async () => {
    app(false);
    expect(await askSavePlace("Take (zoomed).mp4")).toBe(true);
    expect(said).toEqual([]);
  });

  it("asks the app, and goes on only when a place was chosen", async () => {
    app(true);
    const chosen = askSavePlace("Take (zoomed).mp4");
    expect(said).toEqual(["record-save-as:Take (zoomed).mp4"]);
    fire("mac-save-as", { ok: true });
    expect(await chosen).toBe(true);

    const cancelled = askSavePlace("Take (zoomed).mp4", false);
    expect(said[1]).toBe("record-save-for:Take (zoomed).mp4");   // Send to Editor: not shown in Finder
    fire("mac-save-as", { ok: false });
    expect(await cancelled).toBe(false);
  });

  it("hears where its own export was written, a failed one as an error, and stops on Stop", async () => {
    const ctl = new AbortController();
    const saved = savedOnMac("Take (zoomed).mp4", ctl.signal);
    fire("mac-saved", { name: "Other.mp4", path: "/Users/me/Other.mp4" });   // someone else's
    fire("mac-saved", { name: "Take (zoomed).mp4", path: "/Users/me/Take.mp4" });
    expect(await saved).toBe("/Users/me/Take.mp4");

    const failed = savedOnMac("Take (zoomed).mp4", ctl.signal);
    fire("mac-saved", { name: "Take (zoomed).mp4", path: null });
    await expect(failed).rejects.toThrow("could not be saved");

    const stopped = savedOnMac("Take (zoomed).mp4", ctl.signal);
    ctl.abort();
    await expect(stopped).rejects.toBeDefined();
  });
});
