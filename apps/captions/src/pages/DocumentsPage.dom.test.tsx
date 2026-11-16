// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAuth } from "@/lib/auth";
import type { DocumentRecord } from "@/lib/documents";

// The open guide's boxes against the copies of it that come in: a change from another tab or computer, and the
// answers to the page's own saves. The server here answers a save when the test says so.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sent = vi.hoisted(() => [] as { patch: { name?: string; body?: string; guide?: { purpose: string } }; answer: (d: unknown) => void }[]);
vi.mock("@/lib/documents", async (real) => ({
  ...(await real<typeof import("@/lib/documents")>()),
  patchDocument: (_id: string, patch: (typeof sent)[number]["patch"]) => new Promise((answer) => sent.push({ patch, answer })),
}));
const { Editor } = await import("./DocumentsPage");

const guide = (purpose: string, title = "Step one") => ({
  version: 1 as const,
  purpose,
  prerequisites: [],
  verification: [],
  steps: [{ id: "s1", title, instruction: "Press the button", source: { clipId: "clip-0001", startMs: 0, endMs: 1000 }, media: [] }],
});
const record = (over: Partial<DocumentRecord>): DocumentRecord => ({ id: "guide-0001", name: "Setup", kind: "guide", prompt: "", sources: [], published: false, status: "ready", createdAt: 1, updatedAt: 1, body: "", ...over });

let root: Root;
let host: HTMLDivElement;
/** Draws the guide with this copy of it, as the page does for a change from elsewhere and for a save's answer. */
const arrives = (doc: DocumentRecord) =>
  act(() => root.render(<MemoryRouter><Editor doc={doc} owns onChange={arrives} onDeleted={() => {}} /></MemoryRouter>));
const type = (el: HTMLInputElement | HTMLTextAreaElement, text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const press = (name: string) => act(() => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name)!.click());
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const answer = async (doc: DocumentRecord) => {
  sent.at(-1)!.answer(doc);
  await wait(0);
};
const purpose = () => host.querySelector<HTMLTextAreaElement>("textarea")!;
const title = () => host.querySelector<HTMLInputElement>('input[aria-label="Document title"]')!;
const label = () => host.querySelector("span.mr-auto")!.textContent;

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  useAuth.setState({ required: false, me: { username: "owner", role: "admin", cloud: false, off: [] } });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it("what is typed and not saved yet stays in the box when the guide changes elsewhere; saved, the next change is shown", async () => {
  arrives(record({ guide: guide("Old purpose") }));
  press("Edit");
  type(purpose(), "Typed here");
  arrives(record({ guide: guide("From elsewhere") }));
  expect(purpose().value).toBe("Typed here");
  await wait(700);
  expect(sent.map((s) => s.patch.guide?.purpose)).toEqual(["Typed here"]);
  await answer(record({ guide: guide("Typed here") }));
  expect(purpose().value).toBe("Typed here");
  expect(label()).toBe("Saved");
  arrives(record({ guide: guide("From elsewhere, later") }));
  expect(purpose().value).toBe("From elsewhere, later");
});

it("a name being typed stays when the guide is renamed elsewhere, and is the name saved", async () => {
  arrives(record({ guide: guide("Purpose") }));
  type(title(), "Typed name");
  arrives(record({ name: "Renamed elsewhere", guide: guide("Purpose") }));
  expect(title().value).toBe("Typed name");
  act(() => void title().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await wait(0);
  expect(sent.map((s) => s.patch.name)).toEqual(["Typed name"]);
  await answer(record({ name: "Typed name", guide: guide("Purpose") }));
  expect(title().value).toBe("Typed name");
  arrives(record({ name: "Renamed later", guide: guide("Purpose") }));
  expect(title().value).toBe("Renamed later");
});

it("while editing, a save's answer does not rewrite the boxes: a space typed before a pause stays, a cleared step title stays empty", async () => {
  arrives(record({ guide: guide("Old purpose") }));
  press("Edit");
  const step = () => host.querySelector<HTMLInputElement>('.bg-card input:not([aria-label="Document title"])')!;
  type(purpose(), "hello ");
  type(step(), "");
  await wait(700);
  // the server stores the purpose trimmed, and keeps a step's title when it is sent empty
  await answer(record({ guide: guide("hello") }));
  expect(purpose().value).toBe("hello ");
  expect(step().value).toBe("");
  expect(label()).toBe("Saved");
  // Save ends the editing: the page shows what the server has
  press("Save");
  expect(host.textContent).toContain("Step one");
});

it("a document's text box with the caret in it takes a change from elsewhere, and does not draw its own typing again", async () => {
  arrives(record({ kind: "brief", body: "# Setup\n\nAlpha" }));
  press("Edit");
  const box = host.querySelector<HTMLElement>('[role="textbox"]')!;
  act(() => void box.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  arrives(record({ kind: "brief", body: "# Setup\n\nFrom elsewhere" }));
  expect(box.textContent).toBe("From elsewhere");
  box.innerHTML = "<p>Typed here</p>";
  const typed = box.firstChild;
  act(() => void box.dispatchEvent(new Event("input", { bubbles: true })));
  await wait(700);
  expect(sent.map((s) => s.patch.body)).toEqual(["# Setup\n\nTyped here"]);
  await answer(record({ kind: "brief", body: "# Setup\n\nTyped here" }));
  // the same paragraph, so the caret is where it was
  expect(box.firstChild).toBe(typed);
});
