import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { MacReport, ProviderInstance } from "@contracts/providers";
import { ProviderDetail } from "./ProviderDetail";
import { hasCustomEndpoint, providerStatus } from "./ProviderInstanceCard";

const signedIn = { driver: "claude" as const, installed: true, version: "2.1.319", signedIn: true, plan: "max" };
const base = { enabled: true, runs: true, online: true, report: true };

describe("providerStatus", () => {
  it("says what applies first: off, not run by the app, offline, not installed, failed check, signed out", () => {
    expect(providerStatus({ ...base, enabled: false, found: signedIn })).toEqual({ tone: "neutral", text: "" });
    expect(providerStatus({ ...base, runs: false }).text).toBe("Not in the Mac app yet");
    expect(providerStatus({ ...base, online: false, found: signedIn }).text).toBe("Computer offline");
    expect(providerStatus({ ...base, found: { driver: "codex", installed: false } })).toEqual({ tone: "attention", text: "Not installed", action: "install" });
    expect(providerStatus({ ...base, found: signedIn, check: { ok: false, ms: 0, error: "Timed out", at: 1 } })).toEqual({ tone: "broken", text: "Didn't answer", action: "test" });
    // a computer that did not pick the request up is not the AI failing
    expect(providerStatus({ ...base, found: signedIn, check: { ok: false, ms: 0, error: "Sam's Mac did not pick up the request", at: 1 } }).text).toBe("Computer didn't answer");
    // a failure about signing in gets its fix on the row
    expect(providerStatus({ ...base, found: signedIn, check: { ok: false, ms: 0, error: "Not logged in · run /login", at: 1 } }).action).toBe("sign-in");
    // an account with no plan for this AI: setup's sentence, and no Test again that cannot help
    const noPlan = "Codex: To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.";
    expect(providerStatus({ ...base, found: signedIn, check: { ok: false, ms: 0, error: noPlan, at: 1 } })).toEqual({ tone: "attention", text: "Codex needs ChatGPT Plus or higher, which this account doesn't have." });
  });

  it("trusts a passing check newer than the computer's report over a 'not signed in' in that report", () => {
    const signedOut = { driver: "codex" as const, installed: true, signedIn: false };
    expect(providerStatus({ ...base, found: signedOut, reportAt: 100, check: { ok: true, ms: 0, at: 200 } }).text).toBe("");
    expect(providerStatus({ ...base, found: signedOut, reportAt: 300, check: { ok: true, ms: 0, at: 200 } }).text).toBe("Not signed in");
    expect(providerStatus({ ...base, found: { driver: "codex", installed: true, signedIn: false } })).toEqual({ tone: "attention", text: "Not signed in", action: "sign-in" });
  });

  it("a passing check with a note (a plan limit) reads as the note, with nothing to press", () => {
    const note = "Weekly limit reached, resets Friday 09:00";
    expect(providerStatus({ ...base, found: signedIn, check: { ok: true, ms: 0, at: 1, note } })).toEqual({ tone: "neutral", text: note });
  });

  it("shows the plan for a signed-in tool, and nothing when it is fine and has no plan (no 'Ready' label)", () => {
    expect(providerStatus({ ...base, found: signedIn }).text).toBe("Claude Max 5x plan");
    // the report's whole words ("max default_claude_max_20x") read as the plan's name
    expect(providerStatus({ ...base, found: { driver: "claude", installed: true, signedIn: true, plan: "max default_claude_max_20x" } }).text).toBe("Claude Max 20x plan");
    expect(providerStatus({ ...base, found: { driver: "claude", installed: true, signedIn: true } }).text).toBe("");
    expect(providerStatus({ ...base, report: false, check: { ok: true, ms: 900, at: 1 } }).text).toBe("");
  });
});

describe("hasCustomEndpoint", () => {
  const report: MacReport = {
    at: 1,
    drivers: [],
    homes: [{ driver: "claude", home: "/Users/me/.claude-hub", customEndpoint: true }],
  };
  const inst: ProviderInstance = { id: "claude_hub", driver: "claude", name: "Claude (hub)", enabled: true, device: "mac1", home: "/Users/me/.claude-hub" };
  it("matches the Claude folder by its last name", () => {
    expect(hasCustomEndpoint(report, inst)).toBe(true);
    expect(hasCustomEndpoint(report, { ...inst, home: "/Users/me/.claude-work" })).toBe(false);
  });
});

const detail = (inst: ProviderInstance, extra: Partial<Parameters<typeof ProviderDetail>[0]> = {}) => {
  const status = { tone: "neutral" as const, text: "" };
  return renderToStaticMarkup(
    <MemoryRouter>
      <ProviderDetail
        inst={inst}
        status={status}
        checking={false}
        canTest
        used={[]}
        models={[]}
        selection={{ model: "", effort: "xhigh" }}
        onChange={() => {}}
        onTest={() => {}}
        onRemove={() => {}}
        {...extra}
      />
    </MemoryRouter>,
  );
};

describe("ProviderDetail", () => {
  it("shows only the Advanced fields the Mac reads for the tool: Codex has a folder, not a program or variable names", () => {
    const html = detail({ id: "codex", driver: "codex", name: "Codex", enabled: true, device: "mac1" });
    expect(html).toContain("Advanced");
    expect(html).toContain('aria-label="Account folder"');
    expect(html).not.toContain('aria-label="Program"');
    expect(html).not.toContain('aria-label="Variable names"');
  });

  it("gives a tool with no folder, program or variables no Advanced section at all", () => {
    const html = detail({ id: "grok", driver: "grok", name: "Grok", enabled: true, device: "mac1" });
    expect(html).not.toContain("Advanced");
  });

  it("says the tool's own default instead of an empty model list", () => {
    expect(detail({ id: "grok", driver: "grok", name: "Grok", enabled: true, device: "mac1" })).toContain("Uses the tool&#x27;s own default");
  });

  it("the Status row rests on what is true, with no button to press; only a failed check offers the retry", () => {
    const html = detail({ id: "codex", driver: "codex", name: "Codex", enabled: true, device: "mac1" });
    expect(html).not.toContain(">Test<");
    expect(html).not.toContain(">Test again<");
    expect(html).toContain("Not tested yet");
    expect(html).not.toContain("Checking…");
    const failed = detail(
      { id: "codex", driver: "codex", name: "Codex", enabled: true, device: "mac1" },
      { status: { tone: "broken" as const, text: "Didn't answer", action: "test" as const } },
    );
    expect(failed).toContain(">Test again<");
    const answered = detail(
      { id: "codex", driver: "codex", name: "Codex", enabled: true, device: "mac1" },
      { check: { ok: true, ms: 3700, model: "claude-opus-5-5", at: Date.now() - 180_000 } },
    );
    expect(answered).toContain("Answered 3 min ago · Claude Opus 5.5 · 3.7 s");
  });

  it("offers Sign in only when the status asks for it and the page can open it", () => {
    const inst: ProviderInstance = { id: "codex", driver: "codex", name: "Codex", enabled: true, device: "mac1" };
    const status = { tone: "attention" as const, text: "Not signed in", action: "sign-in" as const };
    expect(detail(inst, { status, onSignIn: () => {} })).toContain(">Sign in<");
    expect(detail(inst, { status })).not.toContain(">Sign in<");
  });
});
