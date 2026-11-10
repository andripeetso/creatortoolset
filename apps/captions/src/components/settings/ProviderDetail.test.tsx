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
    expect(providerStatus({ ...base, found: signedIn, check: { ok: false, ms: 0, error: "Timed out", at: 1 } })).toEqual({ tone: "broken", text: "Check failed" });
    expect(providerStatus({ ...base, found: { driver: "codex", installed: true, signedIn: false } })).toEqual({ tone: "attention", text: "Not signed in", action: "sign-in" });
  });

  it("shows the plan for a signed-in tool, and nothing when it is fine and has no plan (no 'Ready' label)", () => {
    expect(providerStatus({ ...base, found: signedIn }).text).toBe("Max plan");
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

  it("says in the Test button's tooltip that it sends one short prompt", () => {
    expect(detail({ id: "codex", driver: "codex", name: "Codex", enabled: true, device: "mac1" })).toContain("Sends one short prompt");
  });

  it("offers Sign in only when the status asks for it and the page can open it", () => {
    const inst: ProviderInstance = { id: "codex", driver: "codex", name: "Codex", enabled: true, device: "mac1" };
    const status = { tone: "attention" as const, text: "Not signed in", action: "sign-in" as const };
    expect(detail(inst, { status, onSignIn: () => {} })).toContain(">Sign in<");
    expect(detail(inst, { status })).not.toContain(">Sign in<");
  });
});
