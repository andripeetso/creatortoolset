import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConnectResult, LocalAiRow, LocalAiView } from "@contracts/local-ai";
import { AiPanelView, anyConnected, codexRowView, rowView, type AiPanelViewProps } from "./AiPanel";

const row = (over: Partial<LocalAiRow> = {}): LocalAiRow => ({
  id: "claude",
  name: "Claude Code",
  kind: "cli",
  found: true,
  version: "2.1.319 (Claude Code)",
  signedIn: true,
  connected: false,
  mcp: "off",
  ...over,
});
const view = (rows: LocalAiRow[], local = true): LocalAiView => ({ local, rows });
const noop = () => {};
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

function html(v: LocalAiView | null, extra: Partial<AiPanelViewProps> = {}) {
  return decode(
    renderToStaticMarkup(
      <AiPanelView view={v} talk="both" results={{}} phases={{}} mcp={{}} onAction={noop} onAdd={noop} onRefresh={noop} {...extra} />,
    ),
  );
}

const failed = (raw?: string): ConnectResult => ({
  state: "failed",
  signedIn: true,
  answered: false,
  message: "It took too long to answer. Try again.",
  raw,
});

describe("step 4 rows", () => {
  it("lists nothing and shows how to get Claude Code when no CLI is on this Mac", () => {
    const h = html(view([row({ found: false })]));
    expect(h).toContain("How to get Claude Code");
    expect(h).not.toContain("Found on this Mac");
    expect(h).not.toContain(">Connect<");
  });

  it("a CLI that is not signed in shows the Terminal line before any click, and nothing is connected", () => {
    const h = html(view([row({ signedIn: false })]));
    expect(h).toContain("Not signed in yet.");
    expect(h).toContain("A Terminal window opens. That's normal: sign in there with your browser, then come back.");
    expect(h).toContain(">Sign in<");
    expect(h).not.toContain("Connected");
    expect(h).not.toContain("Signed in ✓");
  });

  it("signed in but not connected: Connect, the plan the CLI reported, no Connected label", () => {
    const h = html(view([row({ signedIn: true, plan: "claude_max5" })]));
    expect(h).toContain("Signed in. Ready to connect.");
    expect(h).toContain(">Connect<");
    expect(h).toContain("Plan: Claude Max 5x, read from Claude Code.");
    expect(h).toContain("Wrong? Change it in Settings → Setup → Your plan.");
    expect(h).not.toContain("Connected ✓");
  });

  it("no plan line when the CLI reports none", () => {
    expect(html(view([row({ signedIn: true })]))).not.toContain("Plan:");
  });

  it("connected: answer time and both ticks", () => {
    const h = html(view([row({ connected: true, signedIn: true, lastCheck: { ok: true, at: 1, ms: 2300 } })]));
    expect(h).toContain("Connected.");
    expect(h).toContain("Answered in 2.3 s.");
    expect(h).toContain("Connected ✓");
    expect(h).toContain("Signed in ✓");
    expect(h).toContain("Answers ✓");
    expect(h).toContain("Manage in Settings → Your AI");
  });

  it("connected earlier but signed out now: says so, and never shows Connected", () => {
    const h = html(view([row({ connected: true, signedIn: false })]));
    expect(h).toContain("Connected, but not signed in right now. Sign in again.");
    expect(h).not.toContain("Connected ✓");
    expect(h).toContain(">Sign in<");
  });

  it("a failed answer shows the plain line and keeps the raw text under Details", () => {
    const h = html(view([row()]), { results: { claude: failed("Claude: Not logged in · Please run /login") } });
    expect(h).toContain("It didn't answer: It took too long to answer. Try again.");
    expect(h).toContain("Answers ✗");
    expect(h).toContain("Details");
    expect(h.indexOf("Please run /login")).toBeGreaterThan(h.indexOf("Details"));
    expect(h).not.toContain("Connected ✓");
  });

  it("while checking: the disabled button and the time warning", () => {
    const h = html(view([row()]), { phases: { claude: "connecting" } });
    expect(h).toContain("Checking. This can take up to a minute.");
    expect(h).toContain("Checking…");
    expect(h).toContain("disabled");
  });

  it("after Sign in: the Terminal line while it waits", () => {
    const h = html(view([row({ signedIn: false })]), { phases: { claude: "signingIn" } });
    expect(h).toContain("A Terminal window opened. Sign in there, then come back here. This page checks by itself.");
  });

  it("after three minutes still out: asks for Check", () => {
    const h = html(view([row({ signedIn: false })]), { phases: { claude: "timedOut" } });
    expect(h).toContain("Still not signed in. Sign in in the Terminal window, then press Check.");
    expect(h).toContain(">Check<");
  });
});

describe("the Creator Toolset action", () => {
  it("appears under a connected row on the both and chat paths, never on the app path", () => {
    const connected = row({ connected: true, signedIn: true, lastCheck: { ok: true, at: 1, ms: 900 } });
    expect(html(view([connected]), { talk: "both" })).toContain("Let Claude Code use Creator Toolset");
    expect(html(view([connected]), { talk: "chat" })).toContain("Let Claude Code use Creator Toolset");
    expect(html(view([connected]), { talk: "app" })).not.toContain("Creator Toolset");
  });

  it("does not appear on a row that is not connected", () => {
    expect(html(view([row({ signedIn: true })]))).not.toContain("Let Claude Code use Creator Toolset");
  });

  it("shows added once the entry is there", () => {
    const h = html(view([row({ connected: true, signedIn: true, mcp: "added" })]));
    expect(h).toContain("Added to Claude Code ✓");
    expect(h).not.toContain("Let Claude Code use Creator Toolset");
  });

  it("Codex too old: says it needs an update, with the command behind Details", () => {
    const h = html(
      view([row({ id: "codex", name: "Codex", connected: true, signedIn: true, mcp: "update", updateCommand: "npm install -g @openai/codex@latest" })]),
    );
    expect(h).toContain("Codex needs an update before it can use Creator Toolset.");
    expect(h).toContain("npm install -g @openai/codex@latest");
  });

  it("a failed add says the AI is still connected", () => {
    const connected = row({ connected: true, signedIn: true, lastCheck: { ok: true, at: 1, ms: 900 } });
    const h = html(view([connected]), { mcp: { claude: { message: "it couldn't write its settings." } } });
    expect(h).toContain("Creator Toolset couldn't be added to Claude Code: it couldn't write its settings. Your AI is still connected.");
    expect(h).toContain("Try again");
  });
});

describe("Codex is never the app's AI", () => {
  const codex = (over: Partial<LocalAiRow> = {}) => row({ id: "codex", name: "Codex", version: "codex-cli 0.39.0", mcp: "off", ...over });
  const LINE = "Codex can use Creator Toolset from your own chats. The app's own AI runs on Claude Code for now.";

  it("app path: the plain line, no Connect and no Sign in", () => {
    const h = html(view([codex({ signedIn: false })]), { talk: "app" });
    expect(h).toContain(LINE);
    expect(h).not.toContain(">Connect<");
    expect(h).not.toContain(">Sign in<");
    expect(h).not.toContain("Terminal window opens");
  });

  it("own-AI paths: signed out gets Sign in (never Connect); signed in gets the Creator Toolset action", () => {
    const out = html(view([codex({ signedIn: false })]), { talk: "both" });
    expect(out).toContain(LINE);
    expect(out).toContain(">Sign in<");
    expect(out).not.toContain(">Connect<");
    const signed = html(view([codex({ signedIn: true })]), { talk: "chat" });
    expect(signed).toContain("Let Codex use Creator Toolset");
    expect(signed).not.toContain(">Connect<");
    expect(signed).not.toContain(">Sign in<");
  });

  it("a saved connection never shows Codex as connected", () => {
    expect(anyConnected(view([codex({ connected: true })]), { codex: { state: "ready", signedIn: true, answered: true } })).toBe(false);
    expect(codexRowView(codex({ signedIn: true }), "app").button).toBeNull();
  });

  it("app path with only Codex found: says Claude Code runs the app's AI, with the install steps", () => {
    const h = html(view([codex({ signedIn: true })]), { talk: "app" });
    expect(h).toContain("Creator Toolset's own AI runs on Claude Code. Claude Code isn't on this Mac yet.");
    expect(h).toContain("How to get Claude Code");
    expect(h).not.toContain(">Connect<");
  });

  it("the ChatGPT and claude.ai footer is gone, on every path", () => {
    for (const talk of ["app", "both", "chat"] as const) {
      expect(html(view([row()]), { talk })).not.toContain("can't reach this Mac");
      expect(html(view([]), { talk })).not.toContain("can't reach this Mac");
    }
  });
});

describe("other shapes", () => {
  it("with the Mac app off: only the Mac app line, no rows", () => {
    const h = html(view([], false));
    expect(h).toContain("Open the Creator Toolset Mac app to connect your AI.");
    expect(h).not.toContain("Found on this Mac");
  });

  it("desktop apps are text only, with no Connect button", () => {
    const h = html(
      view([row({ id: "claude-desktop", name: "Claude desktop", kind: "desktop", mcp: "n/a", signedIn: null })]),
    );
    expect(h).toContain("Also on this Mac");
    expect(h).toContain("Claude desktop");
    expect(h).not.toContain(">Connect<");
  });

  it("anyConnected counts a saved check or this session's ready result, never a bare probe", () => {
    expect(anyConnected(view([row({ connected: true })]), {})).toBe(true);
    expect(anyConnected(view([row()]), {})).toBe(false);
    expect(anyConnected(view([row()]), { claude: { state: "ready", signedIn: true, answered: true } })).toBe(true);
    expect(anyConnected(null, {})).toBe(false);
  });

  it("rowView never reports Connected after a failed answer", () => {
    expect(rowView(row({ connected: true, signedIn: true }), failed(), undefined).connected).toBeUndefined();
  });
});
