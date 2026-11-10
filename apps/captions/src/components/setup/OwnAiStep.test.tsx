import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LocalAiRow, LocalAiView } from "@contracts/local-ai";

// the screen reads what Settings → Headless access reads; here that data is given, and the real rows render it
const data = vi.hoisted(() => ({ next: null as unknown }));
vi.mock("@/components/settings/OwnAiSection", async (real) => ({ ...(await real<typeof import("@/components/settings/OwnAiSection")>()), useOwnAi: () => data.next }));
const { OwnAiStep } = await import("./OwnAiStep");

const app = (id: "claude" | "codex" | "gemini", name: string, over: Partial<LocalAiRow> = {}): LocalAiRow => ({ id, name, kind: "cli", found: true, version: "1.2.3", signedIn: true, connected: false, mcp: "off", ...over });
const show = (local: LocalAiView | null, keys: unknown[] | null = [], error: string | null = null) => {
  data.next = { keys, local, error, load: () => {}, disconnect: async () => {} };
  return renderToStaticMarkup(<OwnAiStep />).replaceAll("&#x27;", "'");
};
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]);

describe("setup's AI apps screen, after In my own AI or Both", () => {
  it("lists Claude Code and Codex found on this computer, each with one Install button", () => {
    const html = show({ local: true, rows: [app("claude", "Claude Code"), app("codex", "Codex"), app("gemini", "Gemini CLI", { mcp: "n/a" })] });
    expect(html).toContain("Claude Code");
    expect(html).toContain("Codex");
    expect(html).not.toContain("Gemini");
    expect(buttons(html)).toEqual(["Install", "Install"]);
  });

  it("an app that must sign in or update first says so, with Install waiting behind it", () => {
    const html = show({ local: true, rows: [app("claude", "Claude Code", { signedIn: false }), app("codex", "Codex", { mcp: "update" })] });
    expect(buttons(html)).toEqual(["Sign in", "Install", "Update", "Install"]);
  });

  it("an app it is installed in says Installed, with no Install button", () => {
    const html = show({ local: true, rows: [app("claude", "Claude Code", { mcp: "added" })] }, [{ id: "k1", name: "Claude Code", at: 1, last4: "abcd" }]);
    expect(html).toContain("Installed");
    expect(buttons(html)).not.toContain("Install");
  });

  it("with no AI app on this computer it says where to do it later, in one line, and shows no button", () => {
    const html = show({ local: true, rows: [] });
    expect(html).toContain("Settings → Headless access");
    expect(buttons(html)).toEqual([]);
  });

  it("on a server that is not this computer it lists Claude Code and Codex with Install, done by the Mac app", () => {
    const html = show({ local: false, rows: [] });
    expect(html).toContain("Claude Code");
    expect(html).toContain("Codex");
    expect(buttons(html)).toEqual(["Install", "Install"]);
  });

  it("never shows a line to run in Terminal, whatever the computer has", () => {
    for (const html of [
      show({ local: true, rows: [app("claude", "Claude Code"), app("codex", "Codex", { mcp: "update" })] }),
      show({ local: true, rows: [] }),
      show({ local: false, rows: [] }),
    ]) {
      expect(html).not.toMatch(/Terminal|mcp add|claude mcp|codex mcp|Bearer|<pre/);
    }
  });
});
