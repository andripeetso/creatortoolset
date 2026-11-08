import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "devices-"));
const { deviceForToken, listDevices, pairDevice } = await import("./devices");

// Re-pairing the same Mac (same owner, same name) replaces its row and revokes the old token.
describe("pairDevice", () => {
  it("keeps one app row per owner and name, and the old token stops working", () => {
    const first = pairDevice("tinyacrobatics", "Tiny Mac");
    const second = pairDevice("tinyacrobatics", "Tiny Mac");
    const rows = listDevices((d) => d.owner === "tinyacrobatics");
    expect(rows.map((d) => d.id)).toEqual([second.device.id]);
    expect(deviceForToken(`Bearer ${first.token}`)).toBeNull();
    expect(deviceForToken(`Bearer ${second.token}`)?.id).toBe(second.device.id);
  });

  it("keeps a different name, and another owner's Mac with the same name", () => {
    pairDevice("tinyacrobatics", "Tiny Studio");
    pairDevice("otheruser", "Tiny Mac");
    const mine = listDevices((d) => d.owner === "tinyacrobatics").map((d) => d.name).sort();
    expect(mine).toEqual(["Tiny Mac", "Tiny Studio"]);
    expect(listDevices((d) => d.owner === "otheruser")).toHaveLength(1);
  });
});
