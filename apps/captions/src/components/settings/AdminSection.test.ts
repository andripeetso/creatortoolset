import { describe, expect, it } from "vitest";
import { adminMovedTo } from "./AdminSection";

describe("old Admin addresses (the page is gone: its tabs moved to where they belong)", () => {
  it("sends each tab to its new page", () => {
    expect(adminMovedTo(undefined)).toBe("/settings/team");
    expect(adminMovedTo("users")).toBe("/settings/team");
    expect(adminMovedTo("access")).toBe("/settings/team");
    expect(adminMovedTo("apps")).toBe("/settings/team");
    expect(adminMovedTo("projects")).toBe("/settings/storage");
    expect(adminMovedTo("server-keys")).toBe("/settings/keys");
    expect(adminMovedTo("ai")).toBe("/settings/keys");
  });

  it("a plug-in's old tab opens its own page", () => {
    expect(adminMovedTo("footage-access")).toBe("/settings/footage-access");
  });
});
