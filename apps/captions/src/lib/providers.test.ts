import { describe, expect, it } from "vitest";
import type { ProvidersView } from "@contracts/providers";
import { aiAnswerer } from "./providers";

const view = (device: string | undefined, online: boolean, enabled = true): ProvidersView => ({
  workspace: {
    editable: true,
    settings: {
      instances: [{ id: "claude", driver: "claude", name: "Claude", enabled, device }],
      default: { instance: "claude", model: "", effort: "xhigh" },
      jobs: {},
    },
  },
  own: null,
  using: "workspace",
  devices: [
    { id: "d1", owner: "admin", name: "Studio", createdAt: 0, online },
    { id: "d2", owner: "admin", name: "Laptop", createdAt: 0, online: true },
  ],
  checks: {},
  models: {},
  usage: [],
});

describe("aiAnswerer", () => {
  it("names this Mac, another Mac, or none", () => {
    expect(aiAnswerer(view("d1", true), "d1")).toBe("This Mac (Studio) answers your AI.");
    expect(aiAnswerer(view("d1", false), "d1")).toContain("its runner is off");
    expect(aiAnswerer(view("d1", true), "d2")).toBe("Studio, another Mac, answers your AI.");
    expect(aiAnswerer(view("d1", false))).toContain("It is offline");
    expect(aiAnswerer(view(undefined, true), "d1")).toMatch(/^No Mac answers/);
    expect(aiAnswerer(view("d1", true, false), "d1")).toMatch(/^No Mac answers/);
    expect(aiAnswerer({ ...view("d1", true), using: "none" }, "d1")).toMatch(/^No Mac answers/);
  });
});
