import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "devices-"));
const { deviceForToken, forViewer, listDevices, pairDevice, reportOf, saveReport } = await import("./devices");
import type { Device, MacReport } from "../../contracts/providers";

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

// A report can come from two reporters for one Mac; a report with no disk list keeps the last one.
describe("saveReport disks", () => {
  it("keeps the last disk list when a report comes without one, and takes an empty list when it is sent", () => {
    const { device } = pairDevice("tinyacrobatics", "Tiny Disks");
    const machine = (disks?: unknown[]) => ({ os: "mac", host: "tiny", cpus: 8, ...(disks ? { disks } : {}) }) as unknown as MacReport["machine"];
    const report = (at: number, disks?: unknown[]): MacReport => ({ at, drivers: [], homes: [], machine: machine(disks) });
    saveReport(device.id, report(1, [{ name: "footage", path: "/Volumes/footage", freeGb: 3 }]));
    saveReport(device.id, report(2));
    expect(reportOf(device.id)?.machine?.disks?.map((x) => x.name)).toEqual(["footage"]);
    saveReport(device.id, report(3, []));
    expect(reportOf(device.id)?.machine?.disks).toEqual([]);
  });
});

// Disks are the owner's: another account that sees the Mac (an admin, for a workspace or another admin's Mac) gets none.
describe("forViewer", () => {
  it("shows a Mac's disks only to its owner", () => {
    const d = { id: "x", owner: "tinyacrobatics", report: { at: 1, drivers: [], homes: [], machine: { os: "mac", host: "h", cpus: 1, disks: [{ name: "footage", path: "/Volumes/footage", freeGb: 3 }] } } } as unknown as Device;
    expect(forViewer("tinyacrobatics", d).report?.machine?.disks).toHaveLength(1);
    expect(forViewer("someadmin", d).report?.machine?.disks).toBeUndefined();
    expect(forViewer("someadmin", d).report?.machine?.host).toBe("h");
  });
});

// Its owner hears "devices" when a Mac comes online and when its CLIs change, not on every call or report.
describe("device notices", () => {
  it("announces the online flip once and a report only when its drivers change", async () => {
    const { currentSeq } = await import("./sync");
    const { touchDevice } = await import("./devices");
    const { device } = pairDevice("tinyacrobatics", "Tiny Notices");
    const report = (signedIn: boolean): MacReport => ({ at: Date.now(), drivers: [{ driver: "claude", installed: true, signedIn }], homes: [] });
    const s0 = currentSeq();
    touchDevice(device.id);
    touchDevice(device.id);
    expect(currentSeq() - s0).toBe(1);
    saveReport(device.id, report(false));
    saveReport(device.id, { ...report(false), at: Date.now() + 1 });
    expect(currentSeq() - s0).toBe(2);
    saveReport(device.id, report(true));
    expect(currentSeq() - s0).toBe(3);
  });
});
