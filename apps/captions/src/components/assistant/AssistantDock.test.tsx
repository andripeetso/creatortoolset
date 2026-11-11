import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { AssistantView } from "@contracts/assistant";
import { NoToolsNote } from "./AssistantDock";

const view = (provider: AssistantView["provider"], aiName: string, tools: boolean) => ({ id: "c", provider, aiName, tools, messages: [], past: [], pending: null, navigate: null }) as AssistantView;

it("says 'no app tools' only for an AI that has none", () => {
  expect(renderToStaticMarkup(<NoToolsNote view={view("other", "OpenCode", false)} />)).toContain("OpenCode · no app tools");
  expect(renderToStaticMarkup(<NoToolsNote view={view("other", "Codex", true)} />)).toBe("");
  expect(renderToStaticMarkup(<NoToolsNote view={view("claude", "Claude Code", true)} />)).toBe("");
  expect(renderToStaticMarkup(<NoToolsNote view={null} />)).toBe("");
});
