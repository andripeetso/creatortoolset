import { afterEach, describe, expect, it, vi } from "vitest";
import { localSource } from "./screen-source";
import { canRecordScreen, openRecorder, tellRecorder, type LocalRecording } from "./mac-record";

const rec: LocalRecording = {
  id: "0a1b2c3d4e5f",
  name: "Screen recording 2026-11-08",
  createdAt: Date.UTC(2026, 10, 8, 10),
  durationMs: 12000,
  width: 1920,
  height: 1080,
  camera: false,
};

describe("localSource", () => {
  it("builds ctlocal URLs; the camera only when the recording has one", () => {
    const plain = localSource(rec);
    expect(plain.url).toBe("ctlocal://0a1b2c3d4e5f/screen.mp4");
    expect(plain.cameraUrl).toBeNull();
    expect(localSource({ ...rec, camera: true }).cameraUrl).toBe("ctlocal://0a1b2c3d4e5f/camera.mp4");
  });

  it("posts the look as record-look:<id>:<json> to the app", () => {
    const postMessage = vi.fn();
    vi.stubGlobal("window", { webkit: { messageHandlers: { window: { postMessage } } } });
    const look = { pointer: 1.6, zooms: [] } as unknown as Parameters<ReturnType<typeof localSource>["saveLook"]>[0];
    localSource(rec).saveLook(look);
    expect(postMessage).toHaveBeenCalledWith(`record-look:0a1b2c3d4e5f:${JSON.stringify(look)}`);
  });
});

describe("mac-record messages", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends record- messages and no-ops outside the app", () => {
    const postMessage = vi.fn();
    vi.stubGlobal("window", { webkit: { messageHandlers: { window: { postMessage } } } });
    openRecorder();
    tellRecorder("share:0a1b2c3d4e5f:guide");
    tellRecorder("delete:0a1b2c3d4e5f");
    expect(postMessage.mock.calls.map((c) => c[0])).toEqual([
      "record-toolbar",
      "record-share:0a1b2c3d4e5f:guide",
      "record-delete:0a1b2c3d4e5f",
    ]);

    vi.stubGlobal("window", {});
    expect(() => openRecorder()).not.toThrow();
  });

  it("reports the app only when it sets data-mac-record", () => {
    vi.stubGlobal("document", { documentElement: { dataset: { macRecord: "1" } } });
    expect(canRecordScreen()).toBe(true);
  });
});
