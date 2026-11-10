import { describe, expect, it } from "vitest";
import { planWarning } from "@contracts/plans";
import { planToWarnBy } from "./setup";

describe("the plan a heavy run is checked against", () => {
  it("prefers the plan a reading tells over the one the person picked", () => {
    // picked Pro, the Mac's CLI says Max 5x: no warning, since the bigger plan is the real one
    const view = { detected: "claude_max5" as const, plan: "claude_pro" as const };
    expect(planWarning(planToWarnBy(view), "editor")).toBeNull();
    expect(planToWarnBy(view)).toBe("claude_max5");
  });

  it("falls back to the person's answer, then to none", () => {
    expect(planToWarnBy({ detected: null, plan: "claude_pro" })).toBe("claude_pro");
    expect(planWarning(planToWarnBy({ detected: null, plan: "claude_pro" }), "editor")).not.toBeNull();
    expect(planToWarnBy({ detected: null, plan: null })).toBeNull();
    expect(planToWarnBy(null)).toBeNull();
  });
});
