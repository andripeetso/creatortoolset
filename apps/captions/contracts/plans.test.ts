import { describe, expect, it } from "vitest";
import { limitMessage, planFromCli, planWarning, shareOfWindow, WARN_SHARE } from "./plans";

describe("plan warnings", () => {
  it("warn before an AI Editor run on Pro and Plus, never on Max or ChatGPT Pro", () => {
    expect(planWarning("claude_pro", "editor")).toMatch(/about half of a Claude Pro plan's 5-hour limit \(an estimate\)/);
    expect(planWarning("chatgpt_plus", "editor")).toMatch(/ChatGPT Plus/);
    for (const big of ["claude_max5", "claude_max20", "chatgpt_pro"] as const) expect(planWarning(big, "editor")).toBeNull();
  });

  it("stay quiet with no plan given", () => {
    expect(planWarning(null, "editor")).toBeNull();
    expect(planWarning(undefined, "research")).toBeNull();
  });

  it("scale the Analyzer by posts: a few are fine, a big run warns", () => {
    expect(shareOfWindow("claude_pro", "analyzer", 10)).toBeLessThan(WARN_SHARE);
    expect(planWarning("claude_pro", "analyzer", 10)).toBeNull();
    expect(planWarning("claude_pro", "analyzer", 40)).toMatch(/Reading posts in the Analyzer \(40 posts\) usually uses about a quarter/);
    expect(planWarning("claude_pro", "analyzer", 400)).toMatch(/more than a whole/);
  });
});

describe("plan from the CLI", () => {
  it("reads what claude auth status says, and nothing else", () => {
    expect(planFromCli("pro")).toBe("claude_pro");
    expect(planFromCli("max default_claude_max_20x")).toBe("claude_max20");
    expect(planFromCli("max")).toBe("claude_max5");
    expect(planFromCli("ChatGPT")).toBeNull();
    expect(planFromCli(undefined)).toBeNull();
  });
});

describe("limit reached", () => {
  it("says when the window opens again, in the CLI's words", () => {
    expect(limitMessage("You've hit your limit · resets 2pm (Europe/Tallinn)")).toBe(
      "Your Claude plan's limit is reached; it resets 2pm (Europe/Tallinn). Claude said: You've hit your limit · resets 2pm (Europe/Tallinn)",
    );
    expect(limitMessage("You've hit your weekly limit · resets Oct 12", "Codex")).toMatch(/^Your Codex plan's weekly limit is reached; it resets Oct 12\./);
    expect(limitMessage("You've hit your limit")).toBe("Your Claude plan's limit is reached. Claude said: You've hit your limit");
  });
});
