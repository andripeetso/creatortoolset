import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConnectResult, LocalAiRow, LocalAiView } from "@contracts/local-ai";
import { AiPanelView, anyConnected, rowView } from "./AiPanel";

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
  renderToStaticMarkup(
    <AiPanelView view={v} results={{}} phases={{}} onAction={() => {}} onInstall={() => {}} onRefresh={() => {}} {...over} />,
  );

const claude = row({ id: "claude", name: "Claude Code" });
const codex = row({ id: "codex", name: "Codex", version: "codex-cli 0.50.0", signedIn: false });

describe("the agents list: one row each, the one action each needs", () => {
  it("a found, signed-in Claude Code offers Use existing CLI, with its logo and the one-line description", () => {
    const html = panel(view([claude]));
    expect(html).toContain("Claude Code");
    expect(html).toContain("Code with your Claude subscription.");
    expect(html).toContain("Use existing CLI");
    expect(html).toContain("<svg");
  });

  it("a signed-out Codex says Continue with ChatGPT, and a Claude Code that is not on the Mac says where it looked, with Install", () => {
    const html = panel(view([codex]));
    expect(html).toContain("Continue with ChatGPT");
    expect(html).toContain("Code with your ChatGPT subscription.");
    const missing = panel(view([]));
    expect(missing).toContain("Not found · Claude Code (");
    expect(missing).toContain("was not found on PATH.");
    expect(missing).toContain("Install");
  });

  it("Gemini CLI has no Install button: it installs on its own", () => {
    const missing = panel(view([]));
    expect(missing).toContain("Gemini CLI");
    expect(missing.match(/ Install<\/button>/g)?.length ?? 0).toBe(2); // Claude Code and Codex only
  });

  it("a connected agent shows a quiet check, never a Ready or Connected label", () => {
    const html = panel(view([row({ id: "claude", name: "Claude Code", connected: true, lastCheck: { ok: true, at: 1, ms: 5 } })]));
    expect(html).toContain('aria-label="Claude Code is connected"');
    expect(html).not.toContain("Ready");
    expect(html).not.toContain("Connected ✓");
    expect(html).not.toContain("Use existing CLI");
  });

  it("never offers an API key, and always has Check again", () => {
    const html = panel(view([claude, codex]));
    expect(html).not.toMatch(/api key/i);
    expect(html).toContain("Check again");
  });

  it("asks the owner of a server that is not this computer to connect its AI, with no rows", () => {
    const html = panel(view([], false));
    expect(html).toContain("Ask the owner of this server to connect the AI it runs on.");
    expect(html).not.toContain("Use existing CLI");
  });

  it("shows the desktop apps as text only, with no action", () => {
    const html = panel(view([{ ...claude, id: "claude-desktop", kind: "desktop", name: "Claude desktop" } as LocalAiRow]));
    expect(html).toContain("Claude desktop");
    expect(html).toContain("The Claude app.");
    expect(html).not.toContain("Use existing CLI");
  });
});

describe("what a row does, in order", () => {
  it("not signed in: Sign in, with the Terminal line before any click", () => {
    const v = rowView(row({ id: "claude", name: "Claude Code", signedIn: false }), undefined, undefined);
    expect(v.button).toEqual({ label: "Sign in", action: "signin" });
    expect(v.line).toContain("A Terminal window opens");
  });

  it("signed in but not connected: Use existing CLI, and no connected state", () => {
    const v = rowView(claude, undefined, undefined);
    expect(v.button).toEqual({ label: "Use existing CLI", action: "connect" });
    expect(v.connected).toBeFalsy();
  });

  it("while checking: a disabled button and the time warning", () => {
    expect(rowView(claude, undefined, "connecting")).toMatchObject({ button: { label: "Checking…", disabled: true }, line: "Checking. This can take up to a minute." });
  });

  it("after Sign in: the Terminal line while it waits", () => {
    expect(rowView(claude, undefined, "signingIn").line).toContain("Sign in there, then come back here");
  });

  it("after three minutes still out: asks for Check again", () => {
    expect(rowView(claude, undefined, "timedOut").button).toEqual({ label: "Check again", action: "check" });
  });

  it("a failed answer shows the plain line and keeps the raw text for Details", () => {
    const failed: ConnectResult = { state: "failed", signedIn: true, answered: false, message: "It took too long to answer. Try again.", raw: "timed out" };
    const v = rowView(claude, failed, undefined);
    expect(v.line).toBe("It didn't answer: It took too long to answer. Try again.");
    expect(v.raw).toBe("timed out");
    expect(v.connected).toBeFalsy();
  });

  it("connected earlier but signed out now: says so, and never shows Connected", () => {
    const v = rowView(row({ id: "claude", name: "Claude Code", connected: true, signedIn: false }), undefined, undefined);
    expect(v.line).toBe("Connected, but not signed in right now. Sign in again.");
    expect(v.connected).toBeFalsy();
  });
});

describe("anyConnected", () => {
  it("counts a saved passing check or this session's ready result, for any agent, never a bare probe", () => {
    expect(anyConnected(view([claude]), {})).toBe(false);
    expect(anyConnected(view([row({ id: "claude", name: "Claude Code", connected: true })]), {})).toBe(true);
    expect(anyConnected(view([codex]), { codex: { state: "ready", signedIn: true, answered: true } })).toBe(true);
    expect(anyConnected(view([claude]), { claude: { state: "failed", signedIn: true, answered: false } })).toBe(false);
  });
});
