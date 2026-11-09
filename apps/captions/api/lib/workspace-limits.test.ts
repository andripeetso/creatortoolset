import { afterEach, describe, expect, it } from "vitest";
import { limitsFor, setLimitsHook } from "./workspace-limits";

afterEach(() => setLimitsHook(null));

describe("workspace limits", () => {
  it("are unlimited by default, for any workspace", () => {
    expect(limitsFor("tiny-acrobatics")).toEqual({ storageBytes: null });
    expect(limitsFor("")).toEqual({ storageBytes: null });
  });

  it("take the value from an installed hook, per workspace", () => {
    setLimitsHook((ws) => ({ storageBytes: ws === "small" ? 1_000 : null }));
    expect(limitsFor("small")).toEqual({ storageBytes: 1_000 });
    expect(limitsFor("other")).toEqual({ storageBytes: null });
  });

  it("go back to unlimited when the hook is cleared", () => {
    setLimitsHook(() => ({ storageBytes: 5 }));
    setLimitsHook(null);
    expect(limitsFor("small")).toEqual({ storageBytes: null });
  });
});
