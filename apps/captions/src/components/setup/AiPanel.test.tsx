import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConnectResult, LocalAiRow, LocalAiView } from "@contracts/local-ai";
import type { ProviderSettings, ProvidersView } from "@contracts/providers";
import { AiPanelView, AnswerPicker, anyConnected, nextStep, rowView, withoutCommands } from "./AiPanel";

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
/** Another AI in the view: Grok and Cursor are always listed, the rest only when found. */
const other = (id: "grok" | "musecode" | "cursor" | "opencode" | "pi", over: { found?: boolean; signedIn?: boolean | null; connected?: boolean } = {}) => ({ id, found: true, signedIn: null, connected: false, ...over });
const panel = (v: LocalAiView | null, over: Partial<Parameters<typeof AiPanelView>[0]> = {}) =>
  text(renderToStaticMarkup(<AiPanelView view={v} results={{}} phases={{}} onConnect={() => {}} {...over} />));

const claude = row({ id: "claude", name: "Claude Code" });
const codex = row({ id: "codex", name: "Codex", version: "codex-cli 0.50.0", signedIn: false });
const gemini = row({ id: "gemini", name: "Gemini CLI", version: "0.9.1", signedIn: null });
const connected = (id: "claude" | "codex", name: string) => row({ id, name, connected: true, lastCheck: { ok: true, at: 1, ms: 5 } });
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1]);

describe("the rows: named by what a person knows, in order", () => {
  it("ChatGPT comes first with Codex as its small second line, then Claude with Claude Code", () => {
    const html = panel(view([claude, codex]));
    expect(html.indexOf(">ChatGPT<")).toBeGreaterThan(-1);
    expect(html.indexOf(">ChatGPT<")).toBeLessThan(html.indexOf(">Claude<"));
    expect(html).toContain(">Codex<");
    expect(html).toContain(">Claude Code<");
    expect(html).toContain("<svg");
  });

  it("always shows Google third, with Gemini as its small second line, installed or not", () => {
    for (const html of [panel(view([claude, codex])), panel(view([claude, codex, gemini]))]) {
      expect(html.indexOf(">Claude<")).toBeLessThan(html.indexOf(">Google<"));
      expect(html).toContain(">Gemini<");
      expect(html).toContain("Uses your Google AI plan (Pro or Ultra).");
    }
  });

  it("reads each state before any press, and names the button for the next real step", () => {
    // nothing on this Mac: Install on the five up front (ChatGPT, Claude, Google, Grok, Meta), the line says so
    const none = panel(view([]));
    expect(buttons(none)).toEqual(["Install", "Install", "Install", "Install", "Install", "Show more"]);
    expect(none).toContain("Not on this Mac yet. Uses your Meta plan (Everyday or higher).");
    expect(none).toContain("Not on this Mac yet. Uses your ChatGPT plan (Plus or higher).");
    expect(none).toContain("Not on this Mac yet. Uses your Grok account.");
    // installed and signed out: Sign in; installed and signed in (or not readable, Google before its sign-in file): Connect
    const some = panel({ ...view([codex, claude, row({ id: "gemini", name: "Gemini CLI", signedIn: false })]), others: [other("grok", { signedIn: false }), other("musecode", { signedIn: true })] });
    expect(buttons(some)).toEqual(["Sign in", "Connect", "Sign in", "Sign in", "Connect", "Show more"]);
    expect(some).toContain("Not signed in yet. Uses your ChatGPT plan (Plus or higher).");
    expect(some).toContain("Uses your Claude plan (Pro or higher).");
    expect(some).not.toContain("Not signed in yet. Uses your Claude plan");
    expect(rowView("gemini", gemini, undefined, undefined)).toEqual({ line: "Uses your Google AI plan (Pro or Ultra).", button: { label: "Connect" } });
  });

  it("Grok on this Mac but signed out, as its sign-in file says, reads Sign in before any press", () => {
    expect(rowView("grok", other("grok", { signedIn: false }), undefined, undefined)).toEqual({ line: "Not signed in yet. Uses your Grok account.", button: { label: "Sign in" } });
    expect(rowView("grok", other("grok", { signedIn: true }), undefined, undefined)).toEqual({ line: "Uses your Grok account.", button: { label: "Connect" } });
    expect(rowView("cursor", other("cursor", { found: false }), undefined, undefined)).toEqual({ line: "Not on this Mac yet. Uses your Cursor account.", button: { label: "Install" } });
  });

  it("up front: ChatGPT, Claude, Google, Grok, Meta; Cursor and any other AI found here behind Show more, open on a press", () => {
    const v = { ...view([claude]), others: [other("grok"), other("cursor", { found: false }), other("opencode")] };
    const closed = panel(v);
    expect([">ChatGPT<", ">Claude<", ">Google<", ">Grok<", ">Meta<"].map((n) => closed.indexOf(n)).every((at, i, all) => at > -1 && (i === 0 || at > all[i - 1]!))).toBe(true);
    expect(closed).toContain(">Muse Code<");
    expect(closed).not.toMatch(/>Cursor<|>OpenCode</);
    expect(closed).toContain('aria-expanded="false"');
    const open = panel(v, { showMore: true });
    expect(open.indexOf(">Grok<")).toBeLessThan(open.indexOf(">Cursor<"));
    expect(open.indexOf(">Cursor<")).toBeLessThan(open.indexOf(">OpenCode<"));
    expect(open).toContain("Uses OpenCode as it's set up on this Mac.");
    expect(buttons(open).at(-1)).toBe("Show less");
    // no Show more when nothing is behind it; another AI that is not on this Mac has nothing to press and is not listed
    expect(panel({ ...v, others: [other("grok"), other("cursor", { connected: true })] })).not.toContain("Show more");
    expect(panel({ ...view([claude]), others: [other("grok")] }, { showMore: true })).not.toMatch(/OpenCode|>Pi</);
  });

  it("an AI behind Show more that is connected, working or failed shows up front", () => {
    const v = { ...view([claude]), others: [other("grok"), other("cursor"), other("opencode", { connected: true })] };
    expect(panel(v)).toContain('aria-label="OpenCode is connected"');
    expect(panel(v, { phases: { cursor: "installing" } })).toContain(">Installing…<");
    expect(panel(v, { results: { cursor: { state: "failed", signedIn: true, answered: false, message: "It didn't answer. Try again." } } })).toContain("It didn't answer. Try again.");
    expect(panel(v)).not.toContain(">Cursor<");
  });

  it("never says Use it or Check on a button, and shows no Details on a row that is fine", () => {
    for (const html of [panel(view([])), panel(view([codex, claude])), panel(view([connected("claude", "Claude Code")]))]) {
      expect(html).not.toMatch(/>(Use it|In use|Check(ing…| again)?)<\/button>/);
      expect(html).not.toContain("Details");
    }
  });

  it("a connected AI shows a quiet check and no button, never a Ready or Connected label", () => {
    const html = panel({ ...view([connected("claude", "Claude Code")]), others: [other("grok")] });
    expect(html).toContain('aria-label="Claude is connected"');
    expect(buttons(html)).toEqual(["Install", "Install", "Connect", "Install", "Show more"]); // ChatGPT's, Google's, Grok's and Meta's rows; Claude's has none
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

  it("before the first answer the rows are already up, each saying what it uses and claiming nothing about this Mac", () => {
    const html = panel(null);
    for (const name of ["ChatGPT", "Claude", "Google", "Grok", "Meta"]) expect(html).toContain(`>${name}<`);
    expect(html).toContain("Uses your ChatGPT plan (Plus or higher).");
    expect(html).not.toMatch(/Looking for|Not on this Mac|Not signed in/);
    // nothing to press on a row until its state is known; Show more is there as it will be
    expect(buttons(html).filter((b) => /Install|Sign in|Connect|Try again/.test(b))).toEqual([]);
    expect(html).toContain("Show more");
  });

  it("before the first answer an account this server connects no AI for has its line at once, with no rows", () => {
    const html = panel(null, { own: false });
    expect(html).toContain("Ask the owner of this server");
    expect(html).not.toContain(">ChatGPT<");
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
    // another AI on this Mac counts the same way
    expect(anyConnected({ ...view([claude]), others: [other("opencode", { connected: true })] }, {})).toBe(true);
    expect(anyConnected({ ...view([claude]), others: [other("grok")] }, { grok: { state: "ready", signedIn: null, answered: true } })).toBe(true);
  });
});

describe("what Connect does, one step at a time", () => {
  it("says what it is doing while it works, the waiting button named for the step it is on", () => {
    const labels = { installing: "Installing…", updating: "Updating…", signingIn: "Signing in…", connecting: "Connecting…" } as const;
    for (const [phase, label] of Object.entries(labels) as Array<[keyof typeof labels, string]>) {
      expect(rowView("codex", codex, undefined, phase).button).toEqual({ label, disabled: true });
    }
    expect(rowView("codex", undefined, undefined, "installing").line).toBe("Installing what ChatGPT needs on this Mac (about 110 MB). This can take a few minutes.");
    expect(rowView("codex", codex, undefined, "updating").line).toBe("Updating what ChatGPT needs on this Mac. This can take a few minutes.");
    expect(rowView("claude", claude, undefined, "signingIn").line).toBe("Finish signing in in your browser.");
    // what the install downloads is said while it runs, and a sign-in with a code to confirm shows that code
    expect(rowView("musecode", undefined, undefined, "installing").line).toBe("Installing what Meta needs on this Mac (about 470 MB). This can take a few minutes.");
    expect(rowView("musecode", other("musecode", { signedIn: false }), undefined, "signingIn", "TINY-2468")).toEqual({ line: "Confirm this code on Meta's page: TINY-2468", button: { label: "Signing in…", disabled: true } });
  });

  it("after three minutes still signed out: Sign in again, never a Check button", () => {
    expect(rowView("claude", claude, undefined, "timedOut")).toEqual({ line: "Still not signed in. Finish in your browser, or sign in again.", button: { label: "Sign in" } });
  });

  it("a check that comes back not signed in is the sign-in state, never a failure: Sign in, no red line, no Details", () => {
    // Grok's own words when it is signed out (grok 1.0.77, 2026-11-10)
    const raw = "Grok: Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\nAlternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser.";
    const signin: ConnectResult = { state: "signin", signedIn: false, answered: false, message: "Not signed in yet.", raw };
    expect(rowView("grok", other("grok", { signedIn: true }), signin, undefined)).toEqual({ line: "Not signed in yet. Uses your Grok account.", button: { label: "Sign in" } });
    const html = panel({ ...view([claude]), others: [other("grok", { signedIn: true })] }, { results: { grok: signin } });
    expect(html).not.toContain("Details");
    expect(html).not.toContain("grok login");
    expect(html).not.toContain("text-red-600");
    // Meta signed out, in its own words: Sign in, and its "run /login" never shows
    const meta: ConnectResult = { state: "signin", signedIn: false, answered: false, message: "Not signed in yet.", raw: "Muse Code: not logged in: run /login to add an API key" };
    expect(rowView("musecode", other("musecode", { signedIn: true }), meta, undefined)).toEqual({ line: "Not signed in yet. Uses your Meta plan (Everyday or higher).", button: { label: "Sign in" } });
    expect(panel({ ...view([claude]), others: [other("musecode", { signedIn: true })] }, { results: { musecode: meta } })).not.toMatch(/\/login|API key/);
    // an AI this screen can't sign in (OpenCode) says it plainly and looks again on a press
    expect(rowView("opencode", other("opencode"), signin, undefined)).toEqual({ line: "Not signed in to OpenCode on this Mac yet.", button: { label: "Connect" } });
  });

  it("no text a row shows, Details included, holds a command to run: the program's instructions are left out", () => {
    const real = [
      // Grok signed out, Cursor signed out (its print run and its editor mode), the installers' last words
      "Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\nAlternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser.",
      "Not logged in. Run `agent login` first.",
      "Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'.",
      "Grok 1.0.77 installed to /Users/x/.grok/bin/grok\n  Updated /Users/x/.grok/bin in PATH in /Users/x/.zshrc.\n\nRun 'grok' or 'agent' to get started!\n  export PATH=\"$HOME/.grok/bin:$PATH\"",
      "Next Steps\n1. Add ~/.local/bin to your PATH:\n   echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> ~/.zshrc\n   source ~/.zshrc\n2. Start using Cursor Agent:\n   agent",
    ];
    for (const raw of real) {
      const html = panel(view([claude]), { results: { claude: { state: "failed", signedIn: true, answered: false, message: "It didn't answer. Try again.", raw } } });
      expect(html).toContain("It didn't answer. Try again.");
      expect(html).not.toMatch(/`|grok login|agent login|--device-code|export PATH|source ~|echo '|\brun\b|>\s*agent\s*</i);
    }
    expect(withoutCommands(real[0])).toBe("Not signed in.");
    expect(withoutCommands(real[1])).toBe("Not logged in.");
    expect(withoutCommands("curl: (6) Could not resolve host: x.ai")).toBe("curl: (6) Could not resolve host: x.ai");
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

  it("connected earlier but signed out now: says so, with Sign in, and no check mark", () => {
    const v = rowView("claude", row({ id: "claude", name: "Claude Code", connected: true, signedIn: false }), undefined, undefined);
    expect(v.line).toBe("Signed out since last time.");
    expect(v.button).toEqual({ label: "Sign in" });
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
    const html = panel({ ...view([codex, claude, gemini]), others: [other("grok"), other("opencode")] }, {
      results: { codex: { state: "failed", signedIn: false, answered: false, message: "Couldn't download Codex. Check the internet connection, then try again.", raw: "curl: (6) Could not resolve host" } },
      phases: { claude: "installing" },
      showMore: true,
    });
    expect(html).toContain("ChatGPT");
    expect(html).not.toMatch(/\bCLI\b/);
    expect(html).not.toMatch(/\bPATH\b/);
    expect(html).not.toMatch(/Terminal/);
    expect(html).not.toMatch(/api key/i);
    expect(html).not.toMatch(/\bMCP\b/);
  });
});
