import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("keeps Tailwind 3's bare outline (its style) beside a width, and lets a later style win", () => {
    expect(cn("absolute outline outline-1 outline-[#0d99ff]")).toBe("absolute outline outline-1 outline-[#0d99ff]");
    expect(cn("outline outline-2")).toBe("outline outline-2");
    expect(cn("outline outline-dashed")).toBe("outline-dashed");
    expect(cn("outline-1 outline-2")).toBe("outline-2");
  });
});
