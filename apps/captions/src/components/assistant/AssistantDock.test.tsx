import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
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
  expect(html(reply)).toContain("Working for 1m");
});

it("folds the steps into one row: the current step while working, the count once done", () => {
  const steps = ["Checking what's set up", "Looking at the edits", "Checking on the job"];
  const html = (m: AssistantMessage) => renderToStaticMarkup(<MemoryRouter><Message m={m} onView={() => {}} /></MemoryRouter>);
  const live = html({ id: "r", role: "assistant", text: "", at: Date.now(), status: "thinking", steps });
  expect(live).toContain("<summary");
  expect(live).toContain("Checking on the job…");
  expect(live).not.toContain("Checking what&#x27;s set up…");
  const done = html({ id: "r", role: "assistant", text: "Done.", at: Date.now(), status: "done", steps } as AssistantMessage);
  expect(done).toContain("3 steps");
  expect(html({ id: "r", role: "assistant", text: "Done.", at: Date.now(), status: "done", steps, took: 72_400 } as AssistantMessage)).toContain("Worked for 1m 12s");
});

describe("a reply a usage limit stopped", () => {
  it("is said only by the bar over the box, unless the person sent again into the limit", async () => {
    const { quietLimit } = await import("./AssistantDock");
    const u = (id: string) => ({ id, role: "user" as const, text: "go", at: 1 });
    const limited = (id: string) => ({ id, role: "assistant" as const, text: "429", at: 2, status: "error" as const, limit: { until: 9 } });
    const all = [u("1"), { id: "2", role: "assistant" as const, text: "ok", at: 2, status: "done" as const }, u("3"), limited("4"), u("5"), limited("6")];
    expect(quietLimit(all, 3)).toBe(true);
    expect(quietLimit(all, 5)).toBe(false);
    expect(quietLimit(all, 1)).toBe(false);
  });
});
