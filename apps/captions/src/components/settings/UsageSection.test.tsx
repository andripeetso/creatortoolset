import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance, ProvidersView } from "@contracts/providers";
import type { SetupView } from "@contracts/tools";
import { PlanLimits } from "./UsageSection";
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
    expect(html).toContain("Plan limits are off on this Mac.");
    expect(html).toContain("Open the Mac app on Studio");
    expect(html).not.toContain(">Turn on</button>");
  });

  it("in the Mac app, this Mac's row turns the switch on from the row", () => {
    thisMac();
    const html = page(bridge({ limits: false }));
    expect(html).toContain("Plan limits are off on this Mac.");
    expect(html).toContain(">Turn on</button>");
    expect(html).not.toContain("Open the Mac app");
  });

  it("once the switch is on, this Mac says a reading is on its way", () => {
    thisMac();
    const html = page(bridge({ limits: true }));
    expect(html).toContain("No reading yet.");
    expect(html).not.toContain(">Turn on</button>");
  });

  it("an older Mac app (no switch in its state) keeps the one-line instruction", () => {
    thisMac();
    const html = page(bridge());
    expect(html).toContain("Turn on Read this Mac&#x27;s Claude and Codex limits under This Mac.");
    expect(html).not.toContain(">Turn on</button>");
  });
});

describe("your plan", () => {
  it("is asked when no reading tells the plan", () => {
    expect(page(null, setup({ plan: "claude_pro" }))).toContain("Your plan");
  });

  it("is not asked when a reading already tells it", () => {
    expect(page(null, setup({ detected: "claude_max5" }))).not.toContain("Your plan");
  });
});

describe("an AI that is not signed in", () => {
  it("is amber on its computer, with a way to Providers", () => {
    const codex = { id: "codex", driver: "codex", name: "Codex", enabled: true, device: "dev_2" } as ProviderInstance;
    const studio = { id: "dev_2", name: "Studio", online: true, version: "2.0", report: { drivers: [{ driver: "codex", installed: true, signedIn: false }], homes: [] } };
    const v = { limits: [], devices: [studio], own: { instances: [codex] }, workspace: null } as unknown as ProvidersView;
    const html = renderToStaticMarkup(<MemoryRouter><PlanLimits view={v} now={0} bridge={null} setup={setup()} /></MemoryRouter>);
    expect(html).toContain("Not signed in on Studio, so there is no plan to read.");
    expect(html).toContain("Open Providers");
  });
});

describe("a team's login", () => {
  it("is labelled as the team's, not with a person's name", () => {
    // the admin's own Mac can hold the team's login: the instances say whose it is
    const studio = { id: "ws_1", name: "Studio", owner: "sam", online: true, report: { drivers: [{ driver: "claude", installed: true, plan: "Max" }], homes: [] } };
    const login = { driver: "claude", label: "sam", state: "ok", at: 0, device: "ws_1", online: true, instances: ["workspace:claude_hub"], windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 38, resetsAt: 3_600_000 }] };
    const v = { limits: [login], devices: [studio], own: null, workspace: null } as unknown as ProvidersView;
    const html = renderToStaticMarkup(<PlanLimits view={v} now={0} bridge={null} setup={setup()} />);
    expect(html).toContain("Claude · Team");
    expect(html).not.toContain("Claude · sam");
  });
});
