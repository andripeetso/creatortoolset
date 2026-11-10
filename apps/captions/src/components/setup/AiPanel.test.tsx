import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConnectResult, LocalAiRow, LocalAiView } from "@contracts/local-ai";
import type { ProviderSettings, ProvidersView } from "@contracts/providers";
import { AiPanelView, AnswerPicker, anyConnected, nextStep, rowView } from "./AiPanel";

/** React writes an apostrophe as &#x27; in markup; the words are what these tests check. */
const text = (html: string) => html.replaceAll("&#x27;", "'");

const row = (over: Partial<LocalAiRow> & Pick<LocalAiRow, "id" | "name">): LocalAiRow => ({
  kind: "cli",
  found: true,
  version: "2.1.319 (Claude Code)",
  signedIn: true,
  connected: false,
  mcp: "off",
  ...over,
});
const view = (rows: LocalAiRow[], local = true): LocalAiView => ({ local, rows });
const panel = (v: LocalAiView | null, over: Partial<Parameters<typeof AiPanelView>[0]> = {}) =>
  text(renderToStaticMarkup(<AiPanelView view={v} results={{}} phases={{}} onConnect={() => {}} {...over} />));

const claude = row({ id: "claude", name: "Claude Code" });
const codex = row({ id: "codex", name: "Codex", version: "codex-cli 0.50.0", signedIn: false });
const gemini = row({ id: "gemini", name: "Gemini CLI", version: "0.9.1", signedIn: null });
const connected = (id: "claude" | "codex", name: string) => row({ id, name, connected: true, lastCheck: { ok: true, at: 1, ms: 5 } });
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

describe("the rows: named by what a person knows, in order", () => {
  it("ChatGPT comes first with Codex as its small second line, then Claude with Claude Code", () => {
    const html = panel(view([claude, codex]));
    expect(html.indexOf(">ChatGPT<")).toBeGreaterThan(-1);
    expect(html.indexOf(">ChatGPT<")).toBeLessThan(html.indexOf(">Claude<"));
    expect(html).toContain(">Codex<");
    expect(html).toContain(">Claude Code<");
    expect(html).toContain("<svg");
  });

  it("shows no Gemini row unless Gemini CLI is installed", () => {
    expect(panel(view([claude, codex]))).not.toContain("Gemini");
    expect(panel(view([gemini]))).toContain(">Gemini<");
  });

  it("every state before it is connected has the same one button, Connect: nothing installed, signed out, signed in", () => {
    // nothing installed (no rows), a signed-out ChatGPT, a signed-in Claude
    expect(buttons(panel(view([])))).toEqual(["Connect", "Connect"]);
    expect(buttons(panel(view([codex, claude])))).toEqual(["Connect", "Connect"]);
    const html = panel(view([codex, claude]));
    expect(html).toContain("Uses your ChatGPT plan (Plus or higher).");
    expect(html).toContain("Uses your Claude plan (Pro or higher).");
  });

  it("never says Use it, Install, Sign in or Check on a button, and shows no Details on a row that is fine", () => {
    for (const html of [panel(view([])), panel(view([codex, claude])), panel(view([connected("claude", "Claude Code")]))]) {
      expect(html).not.toMatch(/>(Use it|In use|Install|Sign in|Check(ing…| again)?)<\/button>/);
      expect(html).not.toContain("Details");
    }
  });

  it("a connected AI shows a quiet check and no button, never a Ready or Connected label", () => {
    const html = panel(view([connected("claude", "Claude Code")]));
    expect(html).toContain('aria-label="Claude is connected"');
    expect(buttons(html)).toEqual(["Connect"]); // ChatGPT's row; Claude's has none
    expect(html).not.toContain("Ready");
    expect(html).not.toContain(">Connected");
  });

  it("lists no desktop app: a row with nothing to press is not shown", () => {
    const html = panel(view([claude, codex]));
    expect(html).not.toMatch(/Claude app|ChatGPT app|Can't be set up/);
  });
});

describe("the list", () => {
  it("never offers an API key, and has no Check button: it looks again by itself", () => {
    const html = panel(view([claude, codex]));
    expect(html).not.toMatch(/api key/i);
    expect(html).not.toContain("Check again");
  });

  it("asks the owner of a server that is not this computer to connect its AI, with no rows", () => {
    const html = panel(view([], false));
    expect(html).toContain("Ask the owner of this server to connect the AI it runs on.");
    expect(buttons(html)).toEqual([]);
  });
});

describe("the picker: which AI answers in the app, when two are connected", () => {
  const settings = (instances: ProviderSettings["instances"], def: ProviderSettings["default"]): ProviderSettings => ({ instances, default: def, jobs: {} });
  const inst = (id: string, driver: "claude" | "codex", name: string) => ({ id, driver, name, enabled: true, device: "dev_1" });

  it("the picker lists the connected AIs and the models of the one picked; nothing when none is connected", () => {
    const own = settings([inst("local-claude", "claude", "Claude Code"), inst("local-codex", "codex", "Codex")], { instance: "local-claude", model: "claude-opus-5-5", effort: "xhigh" });
    const providers = { own, models: { "local-claude": ["claude-opus-5-5", "claude-sonnet-5"] } } as unknown as ProvidersView;
    const html = renderToStaticMarkup(<AnswerPicker view={providers} onPick={() => {}} />);
    expect(html).toContain("Answers in the app");
    expect(html).toContain('aria-label="AI that answers in the app"');
    expect(html).toContain("Codex");
    expect(html).toContain("claude-sonnet-5");
    const none = { own: null, models: {} } as unknown as ProvidersView;
    expect(renderToStaticMarkup(<AnswerPicker view={none} onPick={() => {}} />)).toBe("");
  });
});

describe("anyConnected", () => {
  it("counts a saved passing check or this session's ready result, for any AI, never a bare probe", () => {
    expect(anyConnected(view([claude]), {})).toBe(false);
    expect(anyConnected(view([row({ id: "claude", name: "Claude Code", connected: true })]), {})).toBe(true);
    expect(anyConnected(view([codex]), { codex: { state: "ready", signedIn: true, answered: true } })).toBe(true);
    expect(anyConnected(view([claude]), { claude: { state: "failed", signedIn: true, answered: false } })).toBe(false);
  });
});

describe("what Connect does, one step at a time", () => {
  it("says what it is doing while it works, with the button waiting as Connecting…", () => {
    for (const phase of ["installing", "updating", "signingIn", "connecting"] as const) {
      expect(rowView("codex", codex, undefined, phase).button).toEqual({ label: "Connecting…", disabled: true });
    }
    expect(rowView("codex", undefined, undefined, "installing").line).toBe("Installing what ChatGPT needs on this Mac. This can take a few minutes.");
    expect(rowView("codex", codex, undefined, "updating").line).toBe("Updating what ChatGPT needs on this Mac. This can take a few minutes.");
    expect(rowView("claude", claude, undefined, "signingIn").line).toBe("Finish signing in in your browser.");
  });

  it("after three minutes still signed out: Connect again, never a Check button", () => {
    expect(rowView("claude", claude, undefined, "timedOut").button).toEqual({ label: "Connect" });
  });

  it("a failure is one plain sentence said once, Try again, and the program's own words under Details", () => {
    const failed: ConnectResult = { state: "failed", signedIn: true, answered: false, message: "It took too long to answer. Try again.", raw: "timed out" };
    const v = rowView("claude", claude, failed, undefined);
    expect(v.line).toBe("It took too long to answer. Try again.");
    expect(v.button).toEqual({ label: "Try again" });
    expect(v.raw).toBe("timed out");
    expect(v.connected).toBeFalsy();
    const html = panel(view([claude]), { results: { claude: failed } });
    expect(html).toContain("Details");
    expect(html).toContain("timed out");
    expect(html).not.toContain("It didn't answer: It didn't answer");
  });

  it("a plan at its limit is connected: the check mark, no button, and when it resets", () => {
    const limited: ConnectResult = { state: "ready", signedIn: true, answered: false, message: "Your Claude plan's weekly limit is reached; it resets Nov 11 at 5pm." };
    const v = rowView("claude", claude, limited, undefined);
    expect(v).toEqual({ line: "Your Claude plan's weekly limit is reached; it resets Nov 11 at 5pm.", button: null, connected: true });
  });

  it("connected earlier but signed out now: says so, with Connect, and no check mark", () => {
    const v = rowView("claude", row({ id: "claude", name: "Claude Code", connected: true, signedIn: false }), undefined, undefined);
    expect(v.line).toBe("Signed out since last time.");
    expect(v.button).toEqual({ label: "Connect" });
    expect(v.connected).toBeFalsy();
  });

  it("each missing step runs once per press: install, update, sign in; a second ask for the same step ends it", () => {
    const none = { installed: false, updated: false, signedIn: false };
    expect(nextStep("missing", none)).toBe("install");
    expect(nextStep("outdated", none)).toBe("update");
    expect(nextStep("signin", none)).toBe("signin");
    expect(nextStep("ready", none)).toBe("done");
    expect(nextStep("failed", none)).toBe("done");
    expect(nextStep("missing", { ...none, installed: true })).toBe("done");
    expect(nextStep("outdated", { ...none, updated: true })).toBe("done");
    expect(nextStep("signin", { ...none, signedIn: true })).toBe("done");
  });
});

describe("the banned words", () => {
  it("the rows and a failure say none of CLI, PATH, Terminal, API key or MCP", () => {
    const html = panel(view([codex, claude, gemini]), {
      results: { codex: { state: "failed", signedIn: false, answered: false, message: "Couldn't download Codex. Check the internet connection, then try again.", raw: "curl: (6) Could not resolve host" } },
      phases: { claude: "installing" },
    });
    expect(html).toContain("ChatGPT");
    expect(html).not.toMatch(/\bCLI\b/);
    expect(html).not.toMatch(/\bPATH\b/);
    expect(html).not.toMatch(/Terminal/);
    expect(html).not.toMatch(/api key/i);
    expect(html).not.toMatch(/\bMCP\b/);
  });
});
