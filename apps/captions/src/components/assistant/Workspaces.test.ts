import { describe, expect, it } from "vitest";
import { initials } from "./Workspaces";
import { START_POOL, startSuggestions } from "./WorkPicker";

describe("a workspace's mark", () => {
  it("is the first letters of its first two words, else its first two letters", () => {
    expect(initials("Tiny Acrobatics")).toBe("TA");
    expect(initials("Healthy Holistic Homes")).toBe("HH");
    expect(initials("moo")).toBe("MO");
    expect(initials("  ")).toBe("?");
  });
});

describe("a new chat's suggestions", () => {
  it("are three, the same for one chat, carry on with the newest work first, and name the workspace", () => {
    const a = startSuggestions("chat-1", "Tiny Acrobatics", "Spring reel");
    expect(a).toHaveLength(3);
    expect(a[0]).toBe('Carry on with "Spring reel"');
    expect(startSuggestions("chat-1", "Tiny Acrobatics", "Spring reel")).toEqual(a);
    const sets = new Set(Array.from({ length: 20 }, (_, i) => startSuggestions(`chat-${i}`).join("|")));
    expect(sets.size).toBeGreaterThan(5);
    const all = Array.from({ length: 50 }, (_, i) => startSuggestions(`c${i}`, "Tiny Acrobatics")).flat();
    expect(all).toContain("Find my next content idea for Tiny Acrobatics");
    expect(all.every((s) => START_POOL.includes(s) || s.endsWith("for Tiny Acrobatics"))).toBe(true);
  });
});
