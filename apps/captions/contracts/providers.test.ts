import { describe, expect, it } from "vitest";
import { parseMachine } from "./providers";

describe("parseMachine", () => {
  it("keeps what a computer reports and drops what doesn't fit", () => {
    expect(parseMachine({ os: "mac", host: " studio ", cpu: "Apple M2", cpus: 8.4, memGb: 16, load: 0.25, freeGb: 99, gpu: "" })).toEqual({
      os: "mac", host: "studio", cpu: "Apple M2", cpus: 8, memGb: 16, load: 0.25,
    });
    expect(parseMachine({ cpus: 0, memGb: 16 })).toBeUndefined();
    expect(parseMachine("nope")).toBeUndefined();
    expect(parseMachine(null)).toBeUndefined();
  });
  it("keeps good disks, drops bad ones, and keeps a network share's server", () => {
    const m = parseMachine({ cpus: 8, memGb: 16, disks: [
      { path: "/", name: "System disk", freeGb: 50, totalGb: 460 },
      { path: "/Volumes/TEAM", name: "TEAM", freeGb: 2800, network: true, server: "nas-1" },
      { path: "/Volumes/Card", name: "Card", freeGb: 5 },
      { path: "", name: "x", freeGb: 1 },
      { path: "/Volumes/y", name: "y", freeGb: -1 },
    ] });
    expect(m?.disks).toEqual([
      { path: "/", name: "System disk", freeGb: 50, totalGb: 460 },
      { path: "/Volumes/TEAM", name: "TEAM", freeGb: 2800, network: true, server: "nas-1" },
      { path: "/Volumes/Card", name: "Card", freeGb: 5 },
    ]);
    expect(m?.disks?.[2]).not.toHaveProperty("totalGb");
  });
});
