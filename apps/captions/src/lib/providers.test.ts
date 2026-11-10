import { describe, expect, it } from "vitest";
import { addInstanceTo, driverFields, type ProviderInstance } from "@contracts/providers";
import { autoTestDue } from "./providers";

const ready = { enabled: true, runs: true, online: true, reportAt: 100, installed: true };

describe("autoTestDue: when Providers tests an AI by itself", () => {
  it("tests an AI with nothing on record, on a computer that is online and has the tool", () => {
    expect(autoTestDue({ ...ready })).toBe(true);
  });

  it("never re-tests an AI that already has a result, whether it passed or failed, unless the computer reported since a failure", () => {
    expect(autoTestDue({ ...ready, check: { ok: true, at: 50 } })).toBe(false);
    expect(autoTestDue({ ...ready, check: { ok: false, at: 50 } })).toBe(true); // reported at 100 after the failure at 50
    expect(autoTestDue({ ...ready, reportAt: 40, check: { ok: false, at: 50 } })).toBe(false);
  });

  it("does not test an AI that is off, not run by the app, on an offline computer, or not installed there", () => {
    expect(autoTestDue({ ...ready, enabled: false })).toBe(false);
    expect(autoTestDue({ ...ready, runs: false })).toBe(false);
    expect(autoTestDue({ ...ready, online: false })).toBe(false);
    expect(autoTestDue({ ...ready, installed: false })).toBe(false);
    expect(autoTestDue({ ...ready, reportAt: undefined })).toBe(false); // the computer has not reported at all
  });
});



const claude = (id: string, extra: Partial<ProviderInstance> = {}): ProviderInstance => ({ id, driver: "claude", name: id, enabled: true, device: "d1", ...extra });

describe("addInstanceTo", () => {
  it("makes the first AI the Default with its own model and thinking level", () => {
    const s = addInstanceTo(null, claude("claude", { model: "claude-sonnet-5-5", effort: "high" }));
    expect(s.instances.map((i) => i.id)).toEqual(["claude"]);
    expect(s.default).toEqual({ instance: "claude", model: "claude-sonnet-5-5", effort: "high" });
  });

  it("keeps the Default when another AI is added, and replaces an AI with the same id", () => {
    const first = addInstanceTo(null, claude("claude"));
    const second = addInstanceTo(first, claude("claude_work"));
    expect(second.default.instance).toBe("claude");
    const again = addInstanceTo(second, claude("claude", { name: "Renamed" }));
    expect(again.instances.map((i) => i.name)).toEqual(["Renamed", "claude_work"]);
  });
});

describe("driverFields", () => {
  it("shows only the Advanced fields the Mac reads for the tool", () => {
    expect(driverFields("codex")).toEqual({ home: true, program: false, args: false, env: false });
    expect(driverFields("claude")).toEqual({ home: true, program: false, args: false, env: true });
    expect(driverFields("grok")).toEqual({ home: false, program: false, args: false, env: false });
    expect(driverFields("cursor")).toEqual({ home: false, program: true, args: true, env: true });
  });
});
