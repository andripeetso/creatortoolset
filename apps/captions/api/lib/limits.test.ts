import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { limitsFor, parseLimits, saveLimits } from "./limits";

// What the Mac app's claudeWindows / codexWindows send (values made up; the shapes are the providers' own).
const claude = {
  driver: "claude",
  home: "/Users/tester/.claude-work",
  isDefault: false,
  label: "work",
  state: "ok",
  windows: [
    { id: "five_hour", label: "Session", kind: "session", usedPercent: 25, resetsAt: 1794113400350, windowMs: 18_000_000 },
    { id: "seven_day", label: "Weekly", kind: "weekly", usedPercent: 49, resetsAt: 1794700000000, windowMs: 604_800_000 },
  ],
};
const codex = {
  driver: "codex",
  home: "/Users/tester/.codex",
  isDefault: true,
  label: "default",
  state: "ok",
  windows: [{ id: "primary", label: "Monthly", kind: "monthly", usedPercent: 13, resetsAt: 1795206641000, windowMs: 2_592_000_000 }],
};

describe("parseLimits", () => {
  it("keeps every identity and window a Mac sends, as they were sent", () => {
    expect(parseLimits({ identities: [claude, codex] })).toEqual([claude, codex]);
  });

  it("drops what it cannot read: an unknown driver or state, no folder, a window over 100 %, a window with no name", () => {
    const out = parseLimits({
      identities: [
        { ...claude, driver: "grok" },
        { ...claude, state: "great" },
        { ...claude, home: "" },
        { ...codex, windows: [{ id: "primary", label: "Monthly", usedPercent: 250 }, { id: "x", usedPercent: 3 }, codex.windows[0]] },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.windows).toEqual([codex.windows[0]]);
  });

  it("keeps a signed-out or unreadable identity with its message and no windows", () => {
    const out = parseLimits({ identities: [{ driver: "claude", home: "/Users/tester/.claude-x", label: "x", state: "error", error: "HTTP 500", windows: [] }] });
    expect(out).toEqual([{ driver: "claude", home: "/Users/tester/.claude-x", isDefault: false, label: "x", state: "error", error: "HTTP 500", windows: [] }]);
  });

  it("anything that is not a report is no identities", () => {
    expect(parseLimits(null)).toEqual([]);
    expect(parseLimits({ identities: "many" })).toEqual([]);
  });
});

describe("limitsFor", () => {
  const ONLINE = (d: string) => d === "mac-a";

  it("gives each identity once, with every instance that runs on it; an instance without a folder is the default one", () => {
    saveLimits("mac-a", { identities: [claude, codex] }, 1000);
    const out = limitsFor(
      [
        { key: "me:claude_a", driver: "claude", device: "mac-a", home: claude.home },
        { key: "me:claude_b", driver: "claude", device: "mac-a", home: claude.home },
        { key: "me:codex", driver: "codex", device: "mac-a" },
      ],
      ONLINE,
    );
    expect(out).toEqual([
      { driver: "claude", label: "work", state: "ok", windows: claude.windows, at: 1000, device: "mac-a", online: true, instances: ["me:claude_a", "me:claude_b"] },
      { driver: "codex", label: "default", state: "ok", windows: codex.windows, at: 1000, device: "mac-a", online: true, instances: ["me:codex"] },
    ]);
  });

  it("an instance whose Mac has not reported, or whose folder is not in the report, has no limits", () => {
    saveLimits("mac-a", { identities: [claude] }, 1000);
    expect(limitsFor([{ key: "me:codex", driver: "codex", device: "mac-b" }], ONLINE)).toEqual([]);
    expect(limitsFor([{ key: "me:codex", driver: "codex", device: "mac-a" }], ONLINE)).toEqual([]);
  });

  it("a later report replaces the earlier one for that device", () => {
    saveLimits("mac-c", { identities: [codex] }, 1);
    saveLimits("mac-c", { identities: [{ ...codex, state: "signed_out", windows: [] }] }, 2);
    const [only] = limitsFor([{ key: "me:codex", driver: "codex", device: "mac-c" }], () => false);
    expect(only).toMatchObject({ state: "signed_out", at: 2, online: false });
  });
});

describe("saved readings", () => {
  it("a restart keeps the last reading: it is written to DATA_DIR/limits.json and read back", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "limits-restart-"));
    process.env.DATA_DIR = dir;
    vi.resetModules();
    const first = await import("./limits");
    first.saveLimits("mac-r", { identities: [codex] }, 42);
    expect(JSON.parse(readFileSync(path.join(dir, "limits.json"), "utf-8"))["mac-r"].at).toBe(42);
    vi.resetModules();
    const again = await import("./limits");
    const [only] = again.limitsFor([{ key: "me:codex", driver: "codex", device: "mac-r" }], () => true);
    expect(only).toMatchObject({ state: "ok", at: 42, windows: codex.windows });
  });
});
