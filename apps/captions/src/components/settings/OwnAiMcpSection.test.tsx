import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { LocalAiRow, LocalAiView } from "@contracts/local-ai";
import { OwnAiMcpView } from "./OwnAiMcpSection";

const row = (over: Partial<LocalAiRow> & Pick<LocalAiRow, "id" | "name">): LocalAiRow => ({
  kind: "cli", found: true, signedIn: true, connected: true, mcp: "off", ...over,
});

const render = (view: LocalAiView, failed = {}) =>
  renderToStaticMarkup(<OwnAiMcpView view={view} busy={null} failed={failed} onAdd={() => {}} />);

it("offers the button, off until clicked, for a connected CLI that has no entry yet", () => {
  const html = render({ local: true, rows: [row({ id: "claude", name: "Claude Code", version: "2.1.319" })] });
  expect(html).toContain("Let Claude Code use Creator Toolset");
  expect(html).toContain("So you can ask Claude Code to make captions");
  expect(html).not.toContain("Added ✓");
});

it("says so once the entry is added, and says what to do when the CLI is not connected", () => {
  expect(render({ local: true, rows: [row({ id: "claude", name: "Claude Code", mcp: "added" })] })).toContain("Added ✓");
  expect(render({ local: true, rows: [row({ id: "codex", name: "Codex", connected: false })] })).toContain("Connect it in Settings → Your AI first.");
});

it("explains an old Codex with its update command, and a failed add with Try again", () => {
  const old = render({ local: true, rows: [row({ id: "codex", name: "Codex", mcp: "update", updateCommand: "npm install -g @openai/codex@latest" })] });
  expect(old).toContain("Codex needs an update before it can use Creator Toolset.");
  expect(old).toContain("How to update");
  expect(old).toContain("npm install -g @openai/codex@latest");
  const failed = render({ local: true, rows: [row({ id: "claude", name: "Claude Code" })] }, { claude: "the CLI said no" });
  expect(failed).toContain("Creator Toolset couldn&#x27;t be added to Claude Code: the CLI said no. Your AI is still connected.");
  expect(failed).toContain("Try again");
});

it("asks for the Mac app when this is not the owner's Mac", () => {
  const html = render({ local: false, rows: [] });
  expect(html).toContain("Open the Creator Toolset Mac app to connect your AI.");
});
