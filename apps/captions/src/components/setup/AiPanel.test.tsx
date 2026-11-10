import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConnectResult, LocalAiRow, LocalAiView } from "@contracts/local-ai";
import type { ProviderSettings, ProvidersView } from "@contracts/providers";
import { AiPanelView, AnswerPicker, anyConnected, rowView } from "./AiPanel";

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
  text(
    renderToStaticMarkup(
      <AiPanelView view={v} results={{}} phases={{}} onAction={() => {}} onInstall={() => {}} {...over} />,
    ),
  );

const claude = row({ id: "claude", name: "Claude Code" });
const codex = row({ id: "codex", name: "Codex", version: "codex-cli 0.50.0", signedIn: false });
const gemini = row({ id: "gemini", name: "Gemini CLI", version: "0.9.1", signedIn: null });
const desktop = (id: "claude-desktop" | "chatgpt-desktop", name: string) => ({ ...claude, id, kind: "desktop", name, signedIn: null }) as LocalAiRow;

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

  it("a missing AI has one Install button, and the one plain line that says what it does", () => {
    const html = panel(view([]));
    expect(html).toContain("Install ChatGPT's coding helper on this Mac, then sign in with your ChatGPT account.");
    expect(html).toContain("Install Claude Code on this Mac, then sign in with your Claude account.");
    expect(html.match(/>Install<\/button>/g)?.length ?? 0).toBe(2);
  });

  it("a signed-out ChatGPT has one Sign in button and says what it does", () => {
    const html = panel(view([codex]));
    expect(html).toContain("Sign in with your ChatGPT account.");
    expect(html).toContain(">Sign in</button>");
  });

  it("a signed-in Claude that is not yet connected has one Use it button and says what it does", () => {
    const html = panel(view([claude]));
    expect(html).toContain("Checks it works, then lets Creator Toolset use it.");
    expect(html).toContain(">Use it</button>");
  });

  it("a connected AI shows a quiet check, never a Ready or Connected label", () => {
    const html = panel(view([row({ id: "claude", name: "Claude Code", connected: true, lastCheck: { ok: true, at: 1, ms: 5 } })]));
    expect(html).toContain('aria-label="Claude is connected"');
    expect(html).toContain("Makes this the AI that answers in the app.");
    expect(html).not.toContain("Ready");
    expect(html).not.toContain(">Connected");
  });

  it("the AI that answers in the app says so, with a disabled In use button", () => {
    const html = panel(view([row({ id: "claude", name: "Claude Code", connected: true, lastCheck: { ok: true, at: 1, ms: 5 } })]), { appAi: "local-claude" });
    expect(html).toContain("This is the AI that answers in the app.");
    expect(html).toContain("In use");
  });
});

describe("the desktop apps: a row each when installed, text only", () => {
  it("shows the installed desktop app with its one line and no button", () => {
    const html = panel(view([desktop("claude-desktop", "Claude desktop")]));
    expect(html).toContain("Claude app");
    expect(html).toContain("Can't be set up from here yet. Use Claude above.");
    expect(html).not.toContain(">Use it<");
  });

  it("shows no desktop row when the app is not installed", () => {
    const html = panel(view([]));
    expect(html).not.toContain("Claude app");
    expect(html).not.toContain("Installed on this Mac.");
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
    expect(html).not.toContain(">Use it<");
  });
});

describe("the app's AI: which one answers, and the picker", () => {
  const connected = (id: "claude" | "codex", name: string) => row({ id, name, connected: true, lastCheck: { ok: true, at: 1, ms: 5 } });
  const settings = (instances: ProviderSettings["instances"], def: ProviderSettings["default"]): ProviderSettings => ({ instances, default: def, jobs: {} });
  const inst = (id: string, driver: "claude" | "codex", name: string) => ({ id, driver, name, enabled: true, device: "dev_1" });

  it("a connected AI that does not answer yet offers Use it, and the one that answers says In use", () => {
    const html = panel(view([connected("claude", "Claude Code"), connected("codex", "Codex")]), { appAi: "local-claude", onUseForApp: () => {} });
    expect(html.match(/>Use it<\/button>/g)?.length ?? 0).toBe(1);
    expect(html.match(/>In use<\/button>/g)?.length ?? 0).toBe(1);
  });

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

describe("what a row does, in order", () => {
  it("not signed in: Sign in, with its line before any click", () => {
    const v = rowView(codex, undefined, undefined);
    expect(v.button).toEqual({ label: "Sign in", action: "signin" });
    expect(v.line).toBe("Sign in with your ChatGPT account. Needs ChatGPT Plus or higher.");
  });

  it("signed in but not connected: Use it runs the check, and no check mark", () => {
    const v = rowView(claude, undefined, undefined);
    expect(v.button).toEqual({ label: "Use it", action: "connect" });
    expect(v.connected).toBeFalsy();
  });

  it("while checking: a disabled button and the time warning", () => {
    expect(rowView(claude, undefined, "connecting")).toMatchObject({ button: { label: "Checking…", disabled: true }, line: "Checking. This can take up to a minute." });
  });

  it("after Sign in: the browser line while it waits", () => {
    expect(rowView(claude, undefined, "signingIn").line).toContain("Waiting for you to finish in your browser");
  });

  it("after three minutes still out: offers Sign in again, never a Check button", () => {
    expect(rowView(claude, undefined, "timedOut").button).toEqual({ label: "Sign in", action: "signin" });
  });

  it("a failed answer shows the plain line and keeps the raw text for Details", () => {
    const failed: ConnectResult = { state: "failed", signedIn: true, answered: false, message: "It took too long to answer. Try again.", raw: "timed out" };
    const v = rowView(claude, failed, undefined);
    expect(v.line).toBe("It didn't answer: It took too long to answer. Try again.");
    expect(v.raw).toBe("timed out");
    expect(v.connected).toBeFalsy();
  });

  it("connected earlier but signed out now: says so, with Sign in, and no check mark", () => {
    const v = rowView(row({ id: "claude", name: "Claude Code", connected: true, signedIn: false }), undefined, undefined);
    expect(v.line).toBe("Signed out since last time. Sign in with your Claude account again.");
    expect(v.button).toEqual({ label: "Sign in", action: "signin" });
    expect(v.connected).toBeFalsy();
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

describe("install: a progress line while it runs, one plain sentence when it fails", () => {
  it("the row says it is installing, and its button waits", () => {
    const html = panel(view([]), { installing: "claude" });
    expect(html).toContain("Installing Claude Code. This can take a few minutes.");
    expect(html).toContain("Installing…");
  });

  it("a failed install: one sentence, the output under Details, and Copy install command", () => {
    const html = panel(view([]), {
      installMsg: { message: "Couldn't install Claude Code. Check the internet connection, then try again.", raw: "curl: (6) Could not resolve host", line: "curl -fsSL https://claude.ai/install.sh | bash" },
    });
    expect(html).toContain("Check the internet connection, then try again.");
    expect(html).toContain("curl: (6) Could not resolve host");
    expect(html).toContain("Copy install command");
  });
});

describe("the banned words", () => {
  it("the rows, the desktop apps and a failed install say none of CLI, PATH, Terminal, API key or MCP", () => {
    const html = panel(view([codex, claude, gemini, desktop("claude-desktop", "Claude desktop"), desktop("chatgpt-desktop", "ChatGPT desktop")]), {
      results: { codex: { state: "failed", signedIn: false, answered: false, message: "It took too long to answer. Try again.", raw: "timed out" } },
      installMsg: { message: "Couldn't install Claude Code. Try again.", raw: "curl: (6) Could not resolve host", line: "curl -fsSL https://claude.ai/install.sh | bash" },
      appAi: "local-claude",
    });
    expect(html).toContain("ChatGPT");
    expect(html).not.toMatch(/\bCLI\b/);
    expect(html).not.toMatch(/\bPATH\b/);
    expect(html).not.toMatch(/Terminal/);
    expect(html).not.toMatch(/api key/i);
    expect(html).not.toMatch(/\bMCP\b/);
  });
});
