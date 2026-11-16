import { describe, expect, it } from "vitest";
import { parseExportSettings, DEFAULT_EXPORT } from "./ExportDialog";
import { exportBitrate } from "@/lib/screen-export";

describe("export settings", () => {
  it("keeps good values and drops the rest", () => {
    expect(parseExportSettings({ short: 1440, fps: 25, quality: "custom", mbps: 40 })).toEqual({ short: 1440, fps: 25, quality: "custom", mbps: 40 });
    expect(parseExportSettings({ short: 99999, fps: 61, quality: "standard", mbps: "x" })).toEqual({ ...DEFAULT_EXPORT, short: 4320 });
    expect(parseExportSettings(null)).toEqual(DEFAULT_EXPORT);
  });

  it("takes a set bit rate as it is, an automatic one from the frame", () => {
    expect(exportBitrate(3840, 2160, 60, "custom", 25)).toBe(25_000_000);
    expect(exportBitrate(1920, 1080, 30, "high")).toBe(8_294_400);
    expect(exportBitrate(1920, 1080, 30, "low")).toBe(2_073_600);
  });
});
