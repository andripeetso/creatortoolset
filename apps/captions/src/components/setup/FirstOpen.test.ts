import { describe, expect, it } from "vitest";
import { opensCard } from "./FirstOpen";

const view = (tools: ("instagram" | "review")[] | null, have: ("project" | "apify")[] = []) => ({ tools, have });
const base = { real: true, inSetup: false, tool: "instagram" as const, dismissed: null };

describe("the setup card over a tool", () => {
  it("opens every time a tool that still needs something is opened, until it is set up", () => {
    expect(opensCard({ ...base, view: view(["instagram"]) })).toBe(true);
    expect(opensCard({ ...base, view: view(["instagram"], ["project"]) })).toBe(true); // still no way to read posts
    expect(opensCard({ ...base, view: view(["instagram"], ["project", "apify"]) })).toBe(false);
  });

  it("uses Home's rule for whose tool it is: every tool until the person has picked some", () => {
    expect(opensCard({ ...base, view: view(null) })).toBe(true);
    expect(opensCard({ ...base, view: view(["review"]) })).toBe(false);
  });

  it("stays closed for the visit after Not now, and for a tool that needs nothing, a guest, or the setup window", () => {
    expect(opensCard({ ...base, view: view(null), dismissed: "instagram" })).toBe(false);
    expect(opensCard({ ...base, view: view(null), dismissed: "review" })).toBe(true); // closed on another tool
    expect(opensCard({ ...base, tool: "review", view: view(null) })).toBe(false);
    expect(opensCard({ ...base, tool: null, view: view(null) })).toBe(false);
    expect(opensCard({ ...base, real: false, view: view(null) })).toBe(false);
    expect(opensCard({ ...base, inSetup: true, view: view(null) })).toBe(false);
    expect(opensCard({ ...base, view: null })).toBe(false);
  });
});
