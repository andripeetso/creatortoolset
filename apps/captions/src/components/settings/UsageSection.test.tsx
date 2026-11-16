import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance, ProvidersView } from "@contracts/providers";
import type { SetupView } from "@contracts/tools";
import { linesOf, PlanLimits } from "./UsageSection";
import type { ThisMacState } from "./ThisMacSection";

afterEach(() => vi.unstubAllGlobals());

const inst = { id: "claude", driver: "claude", name: "Claude", enabled: true, device: "dev_1" } as ProviderInstance;
// a Mac with the Claude CLI installed and no sign-in state: what a Mac app posts while its limits switch is off
const mac = { id: "dev_1", name: "Studio", online: true, version: "2.0", report: { drivers: [{ driver: "claude", installed: true }] } };
const view = { limits: [], devices: [mac], own: { instances: [inst] }, workspace: null } as unknown as ProvidersView;
const setup = (over: Partial<SetupView> = {}) => ({ tools: null, plan: null, detected: null, done: false, have: [], mcpTo: [], ...over }) as SetupView;
const bridge = (over: Partial<ThisMacState> = {}) => ({ answer: "", aiOn: true, running: 0, lastError: null, notice: null, paired: true, problem: null, servers: [], ...over }) as ThisMacState;
const page = (b: ThisMacState | null, s: SetupView | null = setup()) => renderToStaticMarkup(<PlanLimits view={view} now={0} bridge={b} setup={s} />);
const thisMac = () => vi.stubGlobal("document", { documentElement: { dataset: { macDevice: "dev_1" } } });

describe("plan limits that are off on a Mac", () => {
  it("in a browser, names the fix in words and offers no button", () => {
    const html = page(null);
    expect(html).toContain("Plan limits off");
    expect(html).toContain("Turn on plan limits in the Mac app on Studio.");
    expect(html).not.toContain(">Turn on</button>");
  });

  it("in the Mac app, this Mac's row turns the switch on from the row", () => {
    thisMac();
    const html = page(bridge({ limits: false }));
    expect(html).toContain("Plan limits off");
    expect(html).toContain(">Turn on</button>");
    expect(html).not.toContain("in the Mac app on");
  });

  it("once the switch is on, this Mac says how long the first reading takes", () => {
    thisMac();
    const html = page(bridge({ limits: true }));
    expect(html).toContain("The first reading takes up to five minutes.");
    expect(html).not.toContain(">Turn on</button>");
  });

  it("an older Mac app (no switch in its state) keeps the one-line instruction", () => {
    thisMac();
    const html = page(bridge());
    expect(html).toContain("Turn on plan limits in the Mac app on Studio.");
    expect(html).not.toContain(">Turn on</button>");
  });
});

describe("the plan", () => {
  // the plan a big job warns by is planToWarnBy's (the pick, else the plan the AI names), tested in lib/plan-warning.test.ts
  it("is shown when nothing names the plan, and when the AI names it", () => {
    expect(page(null, setup())).toContain('aria-label="Plan"');
    expect(page(null, setup({ detected: "chatgpt_plus" }))).toContain('aria-label="Plan"');
  });
});

describe("activity by workspace", () => {
  const row = (label: string, calls: number, workspace?: string) => ({ hour: "2026-11-16T09", label, scope: "sam", instance: "claude", calls, tokens: calls * 10, costUsd: calls, ...(workspace ? { workspace } : {}) });
  const v = { usage: [row("Workshop", 2, "brand-one"), row("Workshop", 3, "brand-two"), row("Workshop", 4), row("Assistant", 1, "brand-two")], own: { instances: [inst] }, workspace: null } as unknown as ProvidersView;
  const calls = (workspace: string | null) => Object.fromEntries(linesOf(v, 0, workspace).map((l) => [l.tool, l.calls]));

  it("All workspaces counts every call, the ones recorded with no workspace too", () => {
    expect(calls(null)).toEqual({ Workshop: 9, Assistant: 1 });
  });

  it("one workspace counts only the calls made in it", () => {
    expect(calls("brand-two")).toEqual({ Workshop: 3, Assistant: 1 });
    expect(calls("brand-one")).toEqual({ Workshop: 2 });
  });
});

describe("an AI that is not signed in", () => {
  it("is amber on its computer, with no button to another page", () => {
    const codex = { id: "codex", driver: "codex", name: "Codex", enabled: true, device: "dev_2" } as ProviderInstance;
    const studio = { id: "dev_2", name: "Studio", online: true, version: "2.0", report: { drivers: [{ driver: "codex", installed: true, signedIn: false }], homes: [] } };
    const v = { limits: [], devices: [studio], own: { instances: [codex] }, workspace: null } as unknown as ProvidersView;
    const html = renderToStaticMarkup(<MemoryRouter><PlanLimits view={v} now={0} bridge={null} setup={setup()} /></MemoryRouter>);
    expect(html).toContain("Not signed in");
    expect(html).not.toContain("Providers");
  });
});

describe("a server AI's login", () => {
  it("is titled with the AI's own name, never 'Team', and its plan is read where it is", () => {
    // the admin's own Mac can hold the server's login: the instances say which set it answers
    const studio = { id: "ws_1", name: "Studio", owner: "sam", online: true, report: { drivers: [{ driver: "claude", installed: true, plan: "max" }], homes: [] } };
    const login = { driver: "claude", label: "sam", state: "ok", at: 0, device: "ws_1", online: true, instances: ["workspace:claude_hub"], windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 38, resetsAt: 3_600_000 }] };
    const v = { limits: [login], devices: [studio], own: null, workspace: { settings: { instances: [{ id: "claude_hub", name: "Claude (hub)" }] } } } as unknown as ProvidersView;
    const html = renderToStaticMarkup(<PlanLimits view={v} now={0} bridge={null} setup={setup()} />);
    expect(html).toContain("Claude (hub)");
    expect(html).not.toContain("Team");
    expect(html).not.toContain("sam");
    expect(html).toContain("Claude Max 5x plan");
  });

  it("names a ChatGPT plan from Codex's own reading", () => {
    const login = { driver: "codex", label: "default", state: "ok", plan: "chatgpt_plus", at: 0, device: "dev_1", online: true, instances: ["sam:codex"], windows: [] };
    const v = { limits: [login], devices: [{ ...mac, report: { drivers: [], homes: [] } }], own: null, workspace: null } as unknown as ProvidersView;
    expect(renderToStaticMarkup(<PlanLimits view={v} now={0} bridge={null} setup={setup()} />)).toContain("ChatGPT Plus plan");
  });
});

describe("an AI with no plan reading", () => {
  it("says why in one quiet line, with no heading", () => {
    const studio = { id: "dev_1", name: "Studio", online: true, report: { drivers: [{ driver: "claude", installed: true }], homes: [] } };
    const login = { driver: "claude", label: "default", state: "no_login", at: 0, device: "dev_1", online: true, instances: ["dev_1:claude"], windows: [] };
    const v = { limits: [login], devices: [studio], own: null, workspace: null } as unknown as ProvidersView;
    const html = renderToStaticMarkup(<PlanLimits view={v} now={0} bridge={null} setup={setup()} />);
    expect(html).toContain("No Claude sign-in in this account folder.");
    expect(html).not.toContain("No plan reading");
  });
});
