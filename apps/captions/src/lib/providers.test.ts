import { describe, expect, it } from "vitest";
import { addInstanceTo, driverFields, type ProviderInstance, type ProviderSettings } from "@contracts/providers";
import { autoTestDue, effectiveSelection, modelChoices } from "./providers";

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

  it("does not test a failed AI again for five minutes, even when the computer keeps reporting", () => {
    const failedAt = 1_000_000;
    const failed = { ...ready, reportAt: failedAt + 15_000, check: { ok: false, at: failedAt } };
    expect(autoTestDue({ ...failed, now: failedAt + 60_000 })).toBe(false);
    expect(autoTestDue({ ...failed, now: failedAt + 5 * 60_000 })).toBe(true);
  });
});

describe("modelChoices: a stored model is offered even when the tool's list lacks it", () => {
  it("adds the stored model to the list, once, and never drops it for the first model", () => {
    expect(modelChoices(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(modelChoices(["a", "b"], "a")).toEqual(["a", "b"]);
    expect(modelChoices([], "")).toEqual([]);
  });
});

describe("effectiveSelection: the model an AI really runs with", () => {
  const set = (over: Partial<ProviderSettings> = {}): ProviderSettings => ({
    instances: [claude("claude", { model: "claude-opus-5-5", effort: "xhigh" }), claude("claude_work")],
    default: { instance: "claude", model: "claude-sonnet-5-5", effort: "medium" },
    jobs: {},
    ...over,
  });
  const models = ["claude-opus-5-5", "claude-sonnet-5-5"];

  it("shows the Default's model and thinking level for the AI that is the Default (what the Default row says)", () => {
    const s = set();
    expect(effectiveSelection(s, s.instances[0]!, models)).toEqual({ model: "claude-sonnet-5-5", effort: "medium" });
  });

  it("shows the AI's own model and effort for another AI, falling back to the tool's first model and the Default's effort", () => {
    const s = set();
    expect(effectiveSelection(s, s.instances[1]!, models)).toEqual({ model: "claude-opus-5-5", effort: "medium" });
    expect(effectiveSelection(s, claude("x", { model: "claude-haiku-5-5", effort: "low" }), models)).toEqual({ model: "claude-haiku-5-5", effort: "low" });
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
