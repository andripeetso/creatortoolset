import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import type { AssistantMessage, AssistantView } from "@contracts/assistant";
import { Message, NoToolsNote } from "./AssistantDock";

const view = (provider: AssistantView["provider"], aiName: string, tools: boolean) => ({ id: "c", provider, aiName, tools, messages: [], past: [], pending: null, navigate: null }) as AssistantView;

it("says 'no app tools' only for an AI that has none", () => {
  expect(renderToStaticMarkup(<NoToolsNote view={view("other", "OpenCode", false)} />)).toContain("OpenCode · no app tools");
  expect(renderToStaticMarkup(<NoToolsNote view={view("other", "Codex", true)} />)).toBe("");
  expect(renderToStaticMarkup(<NoToolsNote view={view("claude", "Claude Code", true)} />)).toBe("");
  expect(renderToStaticMarkup(<NoToolsNote view={null} />)).toBe("");
});

it("a reply that waits says what it waits for, not that it is working", () => {
  const reply = { id: "r", role: "assistant", text: "", at: Date.now() - 60_000, status: "thinking" } as const;
  const html = (m: AssistantMessage) => renderToStaticMarkup(<MemoryRouter><Message m={m} onView={() => {}} /></MemoryRouter>);
  const waiting = html({ ...reply, wait: { for: "videos", videos: 1, text: "Waiting for a video to upload" } });
  expect(waiting).toContain("Waiting for a video to upload");
  expect(waiting).not.toContain("Working");
  expect(html(reply)).toContain("Working · 1:00");
});
