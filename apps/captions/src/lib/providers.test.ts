import { describe, expect, it } from "vitest";
import { addInstanceTo, driverFields, type ProviderInstance } from "@contracts/providers";

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
