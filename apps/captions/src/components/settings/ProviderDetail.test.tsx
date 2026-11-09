import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MacReport, ProviderInstance, ProviderSettings } from "@contracts/providers";
import { ProviderDetail } from "./ProviderDetail";
import { ProviderInstanceCard, hasCustomEndpoint, providerStatus, withInstance } from "./ProviderInstanceCard";

const insts: Record<"claude" | "codex" | "gemini", ProviderInstance> = {
  claude: { id: "claude_hub", driver: "claude", name: "Claude (hub)", enabled: true, device: "mac1", home: ".claude-hub", launchArgs: ["--verbose"] },
  codex: { id: "codex", driver: "codex", name: "Codex", enabled: true, device: "mac1", binaryPath: "/opt/homebrew/bin/codex", envNames: ["OPENAI_ORG"] },
  gemini: { id: "gemini", driver: "gemini", name: "Gemini", enabled: false, device: "mac1" },
};

const signedIn = { driver: "claude" as const, installed: true, version: "2.1.319", signedIn: true, plan: "max" };

describe("providerStatus", () => {
  it("says what applies first: off, not run by the app, offline, not installed, failed check, signed out, signed in", () => {
    const base = { enabled: true, runs: true, online: true, report: true };
    expect(providerStatus({ ...base, enabled: false, found: signedIn }).text).toBe("Disabled");
    expect(providerStatus({ ...base, runs: false }).text).toBe("The Mac app doesn't run it yet");
    expect(providerStatus({ ...base, online: false, found: signedIn }).text).toBe("Mac offline");
    expect(providerStatus({ ...base, found: { driver: "codex", installed: false } }).text).toBe("Not installed on this Mac");
    expect(providerStatus({ ...base, found: signedIn, check: { ok: false, ms: 0, error: "Timed out", at: 1 } })).toEqual({ tone: "error", text: "Timed out" });
    expect(providerStatus({ ...base, found: { driver: "codex", installed: true, signedIn: false } }).text).toBe("Not signed in");
  });

  it("reads Authenticated with the plan, Ready after a passing check, and Not checked otherwise", () => {
    const base = { enabled: true, runs: true, online: true, report: true };
    expect(providerStatus({ ...base, found: signedIn }).text).toBe("Authenticated · max");
    expect(providerStatus({ ...base, found: { driver: "claude", installed: true, signedIn: true } }).text).toBe("Authenticated");
    expect(providerStatus({ ...base, report: false, check: { ok: true, ms: 900, at: 1 } }).text).toBe("Ready");
    expect(providerStatus({ ...base, found: { driver: "gemini", installed: true } }).text).toBe("Not checked");
  });
});

describe("withInstance (the switch and the detail fields save through it)", () => {
  const set: ProviderSettings = {
    instances: [insts.claude, insts.codex],
    default: { instance: "claude_hub", model: "claude-opus-5-5", effort: "xhigh" },
    jobs: {},
  };

  it("flips only the one provider's switch and keeps every other field", () => {
    const next = withInstance(set, "codex", { enabled: false });
    expect(next.instances[1]).toEqual({ ...insts.codex, enabled: false });
    expect(next.instances[0]).toBe(set.instances[0]);
    expect(next.default).toBe(set.default);
    expect(set.instances[1].enabled).toBe(true); // the input is not mutated
  });
});

describe("the list row", () => {
  it.each(["claude", "codex", "gemini"] as const)("renders the row for %s with its name, version and status", (k) => {
    const inst = insts[k];
    const html = renderToStaticMarkup(
      <ProviderInstanceCard
        inst={inst}
        status={providerStatus({ enabled: inst.enabled, runs: true, online: true, report: true, found: signedIn })}
        version="2.1.319"
        selected={false}
        readOnly={false}
        onSelect={() => {}}
        onToggle={() => {}}
      />,
    );
    expect(html).toContain(inst.name);
    expect(html).toContain("v2.1.319");
    expect(html).toContain('role="switch"');
  });

  it("hides the switch for a member, who only sees the workspace's providers", () => {
    const html = renderToStaticMarkup(
      <ProviderInstanceCard inst={insts.codex} status={{ tone: "ready", text: "Ready" }} selected readOnly where="Studio" onSelect={() => {}} onToggle={() => {}} />,
    );
    expect(html).not.toContain('role="switch"');
    expect(html).toContain("on Studio");
    expect(html).toContain('aria-pressed="true"');
  });
});

describe("the detail pane", () => {
  it.each(["claude", "codex", "gemini"] as const)("renders every section for %s", (k) => {
    const inst = insts[k];
    const html = renderToStaticMarkup(
      <ProviderDetail
        inst={inst}
        status={{ tone: "warning", text: "Not checked" }}
        checking={false}
        canCheck
        used={["the default"]}
        onChange={() => {}}
        onCheck={() => {}}
        onRemove={() => {}}
      />,
    );
    for (const s of ["Status", "Display name", "Runtime", "Binary path", "Home path", "Shadow home path", "Environment", "Used by the default."]) {
      expect(html).toContain(s);
    }
    expect(html).toContain("Add variable");
    expect(html).not.toContain("Launch arguments");
    expect(html).not.toContain("Add argument");
  });

  it("shows launch arguments for a local ACP command, and only there", () => {
    const acp: ProviderInstance = { id: "acp_local", driver: "acp", name: "Local", enabled: true, device: "mac1", acp: { command: "/usr/local/bin/my-agent", args: [] }, launchArgs: ["--verbose"] };
    const html = renderToStaticMarkup(
      <ProviderDetail inst={acp} status={{ tone: "warning", text: "Not checked" }} checking={false} canCheck used={[]} onChange={() => {}} onCheck={() => {}} onRemove={() => {}} />,
    );
    expect(html).toContain("Launch arguments");
    expect(html).toContain("--verbose");
  });

  it("names the variables but never shows values, and hides launch arguments for a non-ACP kind", () => {
    const html = renderToStaticMarkup(
      <ProviderDetail inst={insts.claude} status={{ tone: "ready", text: "Ready" }} checking={false} canCheck={false} used={[]} onChange={() => {}} onCheck={() => {}} onRemove={() => {}} />,
    );
    expect(html).not.toContain('value="--verbose"');
    expect(html).toContain("Add variable");
    expect(html).toContain("Sent as CLAUDE_CONFIG_DIR.");
  });

  it("shows the saved binary path and environment name for Codex", () => {
    const html = renderToStaticMarkup(
      <ProviderDetail inst={insts.codex} status={{ tone: "ready", text: "Ready" }} checking={false} canCheck used={[]} onChange={() => {}} onCheck={() => {}} onRemove={() => {}} />,
    );
    expect(html).toContain('value="/opt/homebrew/bin/codex"');
    expect(html).toContain('value="OPENAI_ORG"');
    expect(html).toContain("Sent as CODEX_HOME.");
  });
});

describe("the custom endpoint badge", () => {
  const report = (homes: MacReport["homes"]): MacReport => ({ at: 1, drivers: [], homes });
  const hub = "/Users/tiny/.claude-hub";

  it("is on for a Claude folder the Mac reports as a custom endpoint, matched by folder name", () => {
    expect(hasCustomEndpoint(report([{ driver: "claude", home: hub, customEndpoint: true }]), insts.claude)).toBe(true);
    expect(hasCustomEndpoint(report([{ driver: "claude", home: hub, customEndpoint: false }]), insts.claude)).toBe(false);
    expect(hasCustomEndpoint(report([{ driver: "claude", home: "/Users/tiny/.claude", customEndpoint: true }]), insts.claude)).toBe(false);
  });

  it("uses the default folder for a Claude provider with no home, and never for other drivers or without a report", () => {
    const plain: ProviderInstance = { id: "claude", driver: "claude", name: "Claude", enabled: true, device: "mac1" };
    expect(hasCustomEndpoint(report([{ driver: "claude", home: "/Users/tiny/.claude", customEndpoint: true }]), plain)).toBe(true);
    expect(hasCustomEndpoint(report([{ driver: "codex", home: "/Users/tiny/.codex", customEndpoint: true }]), insts.codex)).toBe(false);
    expect(hasCustomEndpoint(null, insts.claude)).toBe(false);
  });

  it("renders the badge with no URL, and nothing when the Mac reports no endpoint", () => {
    const status = { tone: "neutral" as const, text: "Not checked" };
    const on = renderToStaticMarkup(<ProviderInstanceCard inst={insts.claude} status={status} selected={false} readOnly customEndpoint onSelect={() => {}} onToggle={() => {}} />);
    const off = renderToStaticMarkup(<ProviderInstanceCard inst={insts.claude} status={status} selected={false} readOnly onSelect={() => {}} onToggle={() => {}} />);
    expect(on).toContain("Custom API endpoint");
    expect(on).not.toContain("gateway");
    expect(off).not.toContain("Custom API endpoint");
  });
});
