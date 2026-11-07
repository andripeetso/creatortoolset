import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptionRenderSpec } from "../src/lib/types";

const launch = vi.fn();
const spawn = vi.fn();
vi.mock("playwright-chromium", () => ({ chromium: { launch } }));
vi.mock("node:child_process", () => ({ spawn }));

const missing = new Error("browserType.launch: Executable doesn't exist at /x/chrome-headless-shell");
const fakeBrowser = { close: vi.fn(async () => {}), newPage: vi.fn() };
const spec = { width: 0, height: 0 } as unknown as CaptionRenderSpec;

/** A child process that exits with `code` on the next tick. */
function child(code: number) {
  const p = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
  setImmediate(() => {
    if (code) p.stderr.emit("data", "network down");
    p.emit("close", code);
  });
  return p;
}

beforeEach(() => {
  vi.resetModules();
  launch.mockReset();
  spawn.mockReset();
  vi.stubEnv("EXPORT_RENDER_PAGES", "1");
});

describe("Chromium on the first caption export", () => {
  it("downloads the headless shell once when it is missing, then launches", async () => {
    launch.mockRejectedValueOnce(missing).mockResolvedValue(fakeBrowser);
    spawn.mockImplementation(() => child(0));
    fakeBrowser.newPage.mockRejectedValueOnce(new Error("stop after launch"));
    const { createCaptionFrameRenderer } = await import("./caption-frames");
    const onDownload = vi.fn();
    await expect(createCaptionFrameRenderer(spec, onDownload)).rejects.toThrow("stop after launch");
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawn.mock.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(args[0]).toMatch(/playwright-chromium[/\\]cli\.js$/);
    expect(args.slice(1)).toEqual(["install", "chromium-headless-shell"]);
  });

  it("shares one download between exports and tries again after a failure", async () => {
    spawn.mockImplementationOnce(() => child(1)).mockImplementation(() => child(0));
    const { installExportBrowser } = await import("./caption-frames");
    const first = installExportBrowser();
    expect(installExportBrowser()).toBe(first);
    await expect(first).rejects.toThrow(/export browser failed: network down/);
    await installExportBrowser();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("passes any other launch error through without downloading", async () => {
    launch.mockRejectedValue(new Error("out of memory"));
    const { createCaptionFrameRenderer } = await import("./caption-frames");
    await expect(createCaptionFrameRenderer(spec)).rejects.toThrow("out of memory");
    expect(spawn).not.toHaveBeenCalled();
  });
});
