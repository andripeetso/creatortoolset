import { describe, expect, it } from "vitest";
import { parseExportSettings, presetOf, exportSize, DEFAULT_EXPORT } from "./ExportDialog";
import { exportBitrate } from "@/lib/screen-export";

describe("export settings", () => {
  it("keeps good values and drops the rest", () => {
    expect(parseExportSettings({ short: 1440, fps: 25, quality: "custom", mbps: 40 })).toEqual({ short: 1440, fps: 25, quality: "custom", mbps: 40, size: null });
    expect(parseExportSettings({ size: { width: 1921, height: 99999 } }).size).toEqual({ width: 1922, height: 8192 });
    expect(parseExportSettings({ short: 99999, fps: 61, quality: "standard", mbps: "x" })).toEqual({ ...DEFAULT_EXPORT, short: 4320 });
    expect(parseExportSettings(null)).toEqual(DEFAULT_EXPORT);
  });

  it("names the preset, and a custom size is taken as typed", () => {
    expect(presetOf(DEFAULT_EXPORT)).toBe("youtube-4k");
    expect(presetOf({ ...DEFAULT_EXPORT, short: 1080, fps: 30 })).toBe("social");
    expect(presetOf({ ...DEFAULT_EXPORT, short: 1170 })).toBeNull();
    const size = { width: 1920, height: 1440 };
    expect(presetOf({ ...DEFAULT_EXPORT, size })).toBeNull();
    expect(exportSize({ ...DEFAULT_EXPORT, size }, "source", 3544, 2160)).toEqual(size);
    expect(exportSize({ ...DEFAULT_EXPORT, short: 1440 }, "source", 3544, 2160)).toEqual({ width: 2362, height: 1440 });
  });

  it("takes a set bit rate as it is, an automatic one from the frame", () => {
    expect(exportBitrate(3840, 2160, 60, "custom", 25)).toBe(25_000_000);
    expect(exportBitrate(1920, 1080, 30, "high")).toBe(8_294_400);
    expect(exportBitrate(1920, 1080, 30, "low")).toBe(2_073_600);
  });
});
