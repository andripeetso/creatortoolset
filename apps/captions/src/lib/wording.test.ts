import { describe, expect, it } from "vitest";
import { ownMacLine } from "./wording";

// The viewer's own Mac with its switch off: only he can turn it on, and he is at that Mac (api/work/waits.ts class 3).
describe("ownMacLine", () => {
  const entry = { wait: "offline", reason: "Linux box is offline", devices: ["linux", "mac"] };

  it("makes an offline wait that names this Mac, ranked first or not, the switch's line", () => {
    const line = { reason: "Take work from this server is off on Mac Studio", href: "/settings/devices#use-this-mac" };
    expect(ownMacLine(entry, { device: "mac", aiOn: false, computer: "Mac Studio" })).toEqual(line);
    expect(ownMacLine({ ...entry, devices: ["mac"] }, { device: "mac", aiOn: false, computer: "Mac Studio" })).toEqual(line);
    expect(ownMacLine(entry, { device: "mac", aiOn: false })?.reason).toBe("Take work from this server is off on this Mac");
  });

  it("leaves every other wait and viewer as it was", () => {
    expect(ownMacLine(entry, { device: "mac", aiOn: true })).toBeNull();
    expect(ownMacLine(entry, { device: "other", aiOn: false })).toBeNull();
    expect(ownMacLine(entry, null)).toBeNull();
    expect(ownMacLine({ ...entry, wait: "stuck" }, { device: "mac", aiOn: false })).toBeNull();
    expect(ownMacLine({ wait: "offline" }, { device: "mac", aiOn: false })).toBeNull();
  });
});
