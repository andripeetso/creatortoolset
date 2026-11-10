import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { LocalAiRow, LocalAiView } from "@contracts/local-ai";
import { ConnectAiRows } from "./OwnAiSection";

const row = (over: Partial<LocalAiRow> & Pick<LocalAiRow, "id" | "name">): LocalAiRow => ({
  kind: "cli", found: true, signedIn: true, connected: true, mcp: "off", ...over,
});

const render = (view: LocalAiView, failed = {}) =>
  renderToStaticMarkup(<ConnectAiRows view={view} busy={null} failed={failed} onAdd={() => {}} />);

it("asks for the Mac app only where the page is not on the Mac (never for a paired Mac)", () => {
  expect(render({ local: false, rows: [] })).toContain("Connect your AI from the Mac app");
  expect(render({ local: true, rows: [row({ id: "claude", name: "Claude Code" })] })).not.toContain("Mac app");
});

it("offers Connect for an AI app not added yet, and says Connected once it is", () => {
  const off = render({ local: true, rows: [row({ id: "claude", name: "Claude Code" })] });
  expect(off).toContain("Connect");
  expect(off).not.toContain("Connected");
  expect(render({ local: true, rows: [row({ id: "claude", name: "Claude Code", mcp: "added" })] })).toContain("Connected");
});

it("shows Codex's update command as the line under it, and a failed add with Try again", () => {
  const old = render({ local: true, rows: [row({ id: "codex", name: "Codex", mcp: "update", updateCommand: "npm install -g @openai/codex@latest" })] });
  expect(old).toContain("Needs an update first");
  expect(old).toContain("npm install -g @openai/codex@latest");
  const failed = render({ local: true, rows: [row({ id: "claude", name: "Claude Code" })] }, { claude: "the CLI said no" });
  expect(failed).toContain("Couldn&#x27;t add it: the CLI said no");
  expect(failed).toContain("Try again");
});
