import { describe, expect, it } from "vitest";
import { planWarning } from "@contracts/plans";
import { planToWarnBy } from "./setup";

describe("the plan a heavy run is checked against", () => {
  it("keeps the plan the person picked over the one their AI names", () => {
    // picked Pro, the Mac's CLI says Max 5x: Usage shows their pick, and the warning goes by the same plan
    const view = { detected: "claude_max5" as const, plan: "claude_pro" as const };
    expect(planToWarnBy(view)).toBe("claude_pro");
    expect(planWarning(planToWarnBy(view), "editor")).not.toBeNull();
  });

  it("falls back to the plan the AI names, then to none", () => {
    expect(planToWarnBy({ detected: "chatgpt_plus", plan: null })).toBe("chatgpt_plus");
    expect(planToWarnBy({ detected: null, plan: "claude_pro" })).toBe("claude_pro");
    expect(planToWarnBy({ detected: null, plan: null })).toBeNull();
    expect(planToWarnBy(null)).toBeNull();
  });
});
