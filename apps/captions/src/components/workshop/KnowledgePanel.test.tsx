// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import type { KnowledgeSource } from "@contracts/knowledge";
import { KnowledgePanel } from "./KnowledgePanel";

// Context files as files: an empty list, a row per file (name, type, size, date or state), a folder row, the viewer.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let sources: KnowledgeSource[] = [];
vi.mock("@/lib/local-cache", () => ({ useCachedList: () => ({ items: sources, setItems: () => {}, error: null }) }));

const file = (id: string, more: Partial<KnowledgeSource>): KnowledgeSource => ({ id, owner: "tiny", name: `${id}.md`, chars: 1200, status: "read", createdAt: 1, updatedAt: 1, ...more });
const draw = (readOnly = false) => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() =>
    root.render(
      <MemoryRouter>
        <KnowledgePanel readOnly={readOnly} />
      </MemoryRouter>,
    ),
  );
  return host;
};
const buttons = (el: HTMLElement) => [...el.querySelectorAll("button")].map((b) => b.textContent || b.getAttribute("aria-label"));
afterEach(() => document.body.replaceChildren());

it("no files: the title, Add and one line", () => {
  sources = [];
  const el = draw();
  expect(el.textContent).toBe("Context files AddNo context filesDrop files or a folder here");
  // Add opens one window: drop or choose files or a folder, a link, or pasted text
  act(() => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Add"))!.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector("h2")?.textContent).toBe("Add context files");
  expect(buttons(dialog as HTMLElement).map((b) => b?.trim())).toEqual(["Choose files", "Choose a folder", "Add", "Paste text", "Close"]);
});

it("a row is a file: name, type, size, and the date or where its reading is; a folder is a row that opens", () => {
  sources = [
    file("voice", { kind: "brand", about: "How Tiny Acrobatics writes", chars: 8800, createdAt: new Date(2026, 5, 13).getTime() }),
    file("book", { status: "queued", waitUntil: new Date(2026, 0, 1, 14, 5).getTime() }),
    file("scan", { status: "failed", error: "The file has no text" }),
    file("kit/one", { name: "kit/one.md" }),
    file("kit/two", { name: "kit/two.md", status: "reading" }),
  ];
  const el = draw();
  const voice = [...el.querySelectorAll("button")].find((b) => b.textContent === "voiceMD")!;
  // what the AI filed it as is the hover text, not a line in the list
  expect(voice.querySelector("[title]")?.getAttribute("title")).toBe("How Tiny Acrobatics writes");
  expect(voice.closest("div")!.textContent).toBe("voiceMD8.8kBJun 13");
  expect(el.textContent).not.toContain("About the brand");
  expect(el.textContent).toMatch(/Resumes \S*(2|14)[:.]05/);
  expect(el.textContent).toContain("Not read");
  expect(el.textContent).toContain("kit2.4kB1 of 2 read");
  // the folder closes and opens
  const kit = [...el.querySelectorAll("button")].find((b) => b.textContent === "kit")!;
  act(() => kit.click());
  expect(el.textContent).not.toContain("oneMD");
  act(() => kit.click());
  expect(el.textContent).toContain("oneMD");
  expect(el.textContent).toContain("5 files · 2 read · 1 failed · under 1% of the workspace's context used");
});

it("a click opens the file to read, as a document or as its source", async () => {
  sources = [file("voice", {}), file("notes", {})];
  vi.stubGlobal("fetch", vi.fn(async () => new Response("# Voice\n\nShort lines.")));
  const el = draw();
  await act(async () => [...el.querySelectorAll("button")].find((b) => b.textContent === "voiceMD")!.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(fetch).toHaveBeenCalledWith("/api/workshop/sources/voice/text");
  expect(dialog.querySelector("h1")?.textContent).toBe("Voice");
  act(() => (dialog.querySelector('[aria-label="Source"]') as HTMLButtonElement).click());
  expect(dialog.querySelector("pre")?.textContent).toBe("# Voice\n\nShort lines.");
  vi.unstubAllGlobals();
});

it("read only: the list and opening a file, no Add and no menus", () => {
  sources = [file("voice", {})];
  expect(buttons(draw(true))).toEqual(["voiceMD"]);
});
