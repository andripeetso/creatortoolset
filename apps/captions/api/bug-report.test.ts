import { describe, expect, it, vi } from "vitest";

vi.mock("./plugins.gen", () => ({ serverPlugins: [] }));
const { diagnosticsOf, reportOf, unhome } = await import("./bug-report");
import type { ProvidersView } from "../contracts/providers";
import type { SessionUser } from "./users";

const NOW = 1_800_000_000_000;
const view = {
  using: "own",
  own: { instances: [{ id: "claude", driver: "claude", name: "Claude (Tiny)", enabled: true, home: "/Users/tiny/.claude-work", device: "d1" }] },
  workspace: null,
  checks: { "tiny:claude": { ok: false, at: NOW - 120_000, ms: 900, error: "spawn /Users/tiny/.local/bin/claude ENOENT" } },
  devices: [{ id: "d1", owner: "tiny", name: "Tiny's Mac", createdAt: 0, online: true, version: "0.40.0", report: { at: NOW, drivers: [{ driver: "claude", installed: true, version: "2.1.0", path: "/Users/tiny/x", signedIn: false }], homes: [] } }],
} as unknown as ProvidersView;
const user = { username: "tiny", role: "admin" } as SessionUser;

describe("bug report", () => {
  it("writes home folders as ~", () => {
    expect(unhome("at /Users/tiny/.claude and /home/pi/x")).toBe("at ~/.claude and ~/x");
  });

  it("carries each provider's last test and its computer, never a name or a path outside ~", () => {
    const d = diagnosticsOf(view, "tiny", NOW);
    expect(d.providers[0]).toMatchObject({ driver: "claude", computer: 1, accountFolder: "~/.claude-work", lastTest: { ok: false, minutesAgo: 2, error: "spawn ~/.local/bin/claude ENOENT" } });
    expect(d.computers[0]!.ai![0]).toEqual({ driver: "claude", installed: true, version: "2.1.0", signedIn: false, plan: undefined });
    expect(JSON.stringify(d)).not.toMatch(/Tiny|\/Users\//);
  });

  it("needs the person's words and refuses a wrong kind", () => {
    const d = diagnosticsOf(view, "tiny", NOW);
    expect(reportOf({ kind: "bug" }, user, d, "ab")).toMatch(/what is required/);
    expect(reportOf({ kind: "rant", what: "x" }, user, d, "ab")).toMatch(/kind/);
    expect(reportOf({ what: "Sign in never finishes\nmore" }, user, d, "ab")).toMatchObject({ ref: "ab", kind: "bug", title: "Sign in never finishes" });
  });
});
