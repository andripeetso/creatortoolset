import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LimitsIdentity, LimitWindow } from "@contracts/providers";
import type { AutomationView } from "@/lib/automations";
import { lastLine } from "./AutomationsSection";

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const task = (lastResult: AutomationView["lastResult"]) => ({ id: "t1", name: "Daily caption check", lastResult }) as AutomationView;
const text = (a: AutomationView, limits: LimitsIdentity[] = []) => renderToStaticMarkup(<>{lastLine(a, limits, NOW)}</>);
const claudeAt = (usedPercent: number, resetsAt?: number): LimitsIdentity => ({
  driver: "claude", label: "default", state: "ok", at: NOW, device: "mac", online: true, instances: [],
  windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent, resetsAt } as LimitWindow],
});

describe("a failed task's line", () => {
  it("says when it failed, and for a usage limit when the limit comes back", () => {
    const html = text(task({ status: "error", at: NOW - 2 * H, text: "Claude hit its usage limit before the run finished." }), [claudeAt(100, NOW + 2 * H + 9 * 60_000)]);
    expect(html).toContain("Failed 2 h ago · usage limit, resets in 2h 9m");
  });

  it("says usage limit alone when no reading knows the reset", () => {
    const html = text(task({ status: "error", at: NOW - H, text: "Claude hit its usage limit." }), [claudeAt(62, NOW + H)]);
    expect(html).toContain("Failed 1 h ago · usage limit");
    expect(html).not.toContain("resets");
  });

  it("leaves other failures as they were", () => {
    expect(text(task({ status: "error", at: NOW - H, text: "The Mac is busy." }))).toContain(">Failed 1 h ago<");
    expect(text(task({ status: "error", at: NOW - H, text: "The Mac is busy." }))).not.toContain("usage limit");
  });
});
