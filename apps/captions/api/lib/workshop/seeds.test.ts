import { describe, expect, it } from "vitest";
import { ORIGINAL_SEED_KEYS, RETIRED_RULE_SEED_KEYS, RETIRED_SEED_KEYS, SEED_FRAMEWORKS, SEED_RULES, extraFrameworkCopyIds, missingRuleSeeds, missingSeeds, planRuleSeedSync, ruleSeedAt, type RuleSeedRecord } from "./seeds";
import { LIMITS, parseFrameworkInput, parseRuleInput } from "./validate";

describe("SEED_FRAMEWORKS", () => {
  it("are 21 distinct, valid, medium-agnostic frameworks", () => {
    expect(SEED_FRAMEWORKS).toHaveLength(21);
    expect(new Set(SEED_FRAMEWORKS.map((s) => s.seedKey)).size).toBe(21);
    for (const seed of SEED_FRAMEWORKS) {
      expect(seed.steps.length, seed.seedKey).toBeGreaterThanOrEqual(4);
      const parsed = parseFrameworkInput(seed);
      expect(parsed.steps, seed.seedKey).toEqual(seed.steps);
      expect(seed.name, seed.seedKey).not.toMatch(/reel|carousel|youtube|podcast|email|\bad\b/i);
      expect(["narrative", "persuasion", "argument"], seed.seedKey).toContain(seed.role);
      expect(seed.pairsWith, seed.seedKey).toBeTruthy();
    }
    for (const key of ORIGINAL_SEED_KEYS) expect(SEED_FRAMEWORKS.some((s) => s.seedKey === key), key).toBe(true);
    for (const key of RETIRED_SEED_KEYS) expect(SEED_FRAMEWORKS.some((s) => s.seedKey === key), key).toBe(false);
    const byRole = (role: string) => SEED_FRAMEWORKS.filter((s) => s.role === role).length;
    expect([byRole("narrative"), byRole("persuasion"), byRole("argument")]).toEqual([9, 8, 4]);
  });

  it("seeds no starter rules: every former starter is retired", () => {
    expect(SEED_RULES).toEqual([]);
    expect(missingRuleSeeds([])).toEqual([]);
    for (const key of ["priority", "write-like-you-talk", "lead-with-what-is", "no-engagement-bait", "revise-the-thought"]) {
      expect(RETIRED_RULE_SEED_KEYS, key).toContain(key);
    }
  });

  it("planRuleSeedSync drops untouched starters, keeps edited ones and the user's own, adds nothing", () => {
    const owned: RuleSeedRecord[] = [
      { id: "a", seedKey: "write-like-you-talk", name: "Write like you talk", text: "x", createdAt: 1005, updatedAt: 1005 },
      { id: "b", seedKey: "loops", name: "Loops", text: "y", createdAt: 1, updatedAt: 1 },
      { id: "edited", seedKey: "picturable", name: "Mine", text: "Keep this.", createdAt: 1, updatedAt: 2 },
      { id: "own", name: "My rule", text: "Mine too.", createdAt: 5, updatedAt: 5 },
    ];
    const plan = planRuleSeedSync(owned, ["write-like-you-talk", "loops", "picturable"]);
    expect(plan.retireIds.sort()).toEqual(["a", "b"]);
    expect(plan.refresh).toEqual([]);
    expect(plan.adopt).toEqual([]);
    expect(plan.toAdd).toEqual([]);
    expect(ruleSeedAt("priority")).toBe(1000);
  });

  it("missingSeeds returns only what the user has not been given", () => {
    expect(missingSeeds([])).toHaveLength(21);
    const rest = missingSeeds(["pas", "spine"]);
    expect(rest).toHaveLength(19);
    expect(rest.some((s) => s.seedKey === "pas" || s.seedKey === "spine")).toBe(false);
    expect(missingSeeds(SEED_FRAMEWORKS.map((s) => s.seedKey))).toEqual([]);
  });

  it("extraFrameworkCopyIds keeps one copy per starter", () => {
    const seed = SEED_FRAMEWORKS[0]!;
    expect(extraFrameworkCopyIds([
      { id: "a", seedKey: seed.seedKey, name: seed.name, summary: seed.summary, steps: seed.steps, createdAt: 1, updatedAt: 1 },
      { id: "b", seedKey: seed.seedKey, name: seed.name, summary: seed.summary, steps: seed.steps, createdAt: 2, updatedAt: 2 },
    ]).sort()).toEqual(["b"]);
  });

  it("extraFrameworkCopyIds keeps the current seed over an older wording", () => {
    const seed = SEED_FRAMEWORKS.find((s) => s.seedKey === "i-was-wrong")!;
    expect(extraFrameworkCopyIds([
      {
        id: "old",
        seedKey: seed.seedKey,
        name: seed.name,
        summary: seed.summary,
        steps: [...seed.steps.slice(0, -1), "A question back to the audience"],
        createdAt: 1,
        updatedAt: 1,
      },
      { id: "fresh", seedKey: seed.seedKey, name: seed.name, summary: seed.summary, steps: seed.steps, createdAt: 2, updatedAt: 2 },
    ])).toEqual(["old"]);
  });
});
