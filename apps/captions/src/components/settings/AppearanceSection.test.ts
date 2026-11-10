import { describe, expect, it } from "vitest";
import { DEFAULT_TOOLS, TOOLS, type Tool } from "@contracts/tools";
import { switchableTools, toolsAfter } from "./AppearanceSection";

describe("Home tools on Appearance", () => {
  const mine: readonly Tool[] = TOOLS;

  it("lists only the tools that are switched, never the always-on ones", () => {
    const extras = switchableTools(mine);
    expect(extras.length).toBe(mine.length - DEFAULT_TOOLS.length);
    for (const t of DEFAULT_TOOLS) expect(extras).not.toContain(t);
  });

  it("turning one on keeps the always-on tools and what is already on, in the account's order", () => {
    const extra = switchableTools(mine)[0];
    const on = toolsAfter(mine, [], extra, true);
    for (const t of DEFAULT_TOOLS) expect(on).toContain(t);
    expect(on).toContain(extra);
    expect(on).toEqual(mine.filter((t) => on.includes(t)));
  });

  it("turning one off drops only that tool", () => {
    const [a, b] = switchableTools(mine);
    const value = [...DEFAULT_TOOLS, a, b];
    const off = toolsAfter(mine, value, a, false);
    expect(off).not.toContain(a);
    expect(off).toContain(b);
    expect(off.length).toBe(value.length - 1);
  });
});
