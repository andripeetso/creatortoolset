import { afterEach, describe, expect, it, vi } from "vitest";
import { localFilesOverlap, readLocalFile } from "./local-files";

afterEach(() => vi.unstubAllGlobals());

describe("a recording's files in an app whose scheme takes one request at a time", () => {
  it("reads one file at a time: the next starts when the one before has ended, even if that one failed", async () => {
    const started: string[] = [];
    const finish: Record<string, (ok: boolean) => void> = {};
    vi.stubGlobal("fetch", (url: string) => {
      started.push(url);
      return new Promise((resolve) => {
        finish[url] = (ok) => resolve({ ok, status: ok ? 200 : 404, blob: async () => new Blob([url]) });
      });
    });
    const a = readLocalFile("ctlocal://x/screen.mp4");
    const b = readLocalFile("ctlocal://x/screen-look.json");
    const c = readLocalFile("ctlocal://x/screen-events.json");
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["ctlocal://x/screen.mp4"]); // the other two wait
    finish["ctlocal://x/screen.mp4"](true);
    expect(await (await a).text()).toBe("ctlocal://x/screen.mp4");
    await vi.waitFor(() => expect(started).toHaveLength(2));
    finish["ctlocal://x/screen-look.json"](false); // no look saved yet
    await expect(b).rejects.toThrow("404");
    await vi.waitFor(() => expect(started).toHaveLength(3));
    finish["ctlocal://x/screen-events.json"](true);
    expect((await c).size).toBeGreaterThan(0);
  });

  it("knows the app that takes requests at once by its mark", () => {
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    expect(localFilesOverlap()).toBe(false); // 0.14.0 and before: no mark
    vi.stubGlobal("document", { documentElement: { dataset: { macLocalFiles: "2" } } });
    expect(localFilesOverlap()).toBe(true);
  });
});
