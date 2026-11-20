// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMedia } from "@contracts/assistant";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const confirmDialog = vi.fn();
vi.mock("@/lib/dialogs", () => ({ confirmDialog: (...a: unknown[]) => confirmDialog(...a) }));
const { AskChanges, VideoCards } = await import("./VideoCard");

const cut: AssistantMedia = { id: "review:a1:2", kind: "video", title: "Tiny tumbles · v2", src: "/p", href: "/review/a1?v=2", cut: { asset: "a1", n: 2, next: "B-roll" } };
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const show = (media: AssistantMedia[], ask = vi.fn()) => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter><AskChanges.Provider value={ask}><VideoCards media={media} /></AskChanges.Provider></MemoryRouter>));
  return host;
};
const buttons = () => [...host!.querySelectorAll("button")].map((b) => b.textContent);
const press = (i: number) => act(async () => void host!.querySelectorAll("button")[i]!.click());
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  vi.unstubAllGlobals();
  confirmDialog.mockReset();
});

describe("a ready cut in the chat", () => {
  it("plays with Review ›, Approve left (saying what it starts) and Request changes right; a plain video keeps Open and no buttons", () => {
    const el = show([cut, { ...cut, id: "v", cut: undefined }]);
    expect(buttons()).toEqual(["Approve · add B-roll", "Request changes"]);
    expect([...el.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Tiny tumbles · v2", "Review ", "Tiny tumbles · v2", "Open "]);
  });

  it("Approve approves that version itself; an unblurred cut asks first, as Review does", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      return body.asFilmed ? new Response("{}") : new Response(JSON.stringify({ error: "Approve it as filmed?", code: "not_blurred" }), { status: 409 });
    }));
    confirmDialog.mockResolvedValue(true);
    show([cut]);
    await press(0);
    expect(calls).toEqual([{ status: "approved", version: 2 }, { status: "approved", version: 2, asFilmed: true }]);
    expect(buttons()[0]).toBe("Approved");
  });

  it("Request changes hands the chat box its question; nothing is sent", async () => {
    const ask = vi.fn();
    vi.stubGlobal("fetch", vi.fn());
    show([cut], ask);
    await press(1);
    expect(ask).toHaveBeenCalledWith(cut);
    expect(fetch).not.toHaveBeenCalled();
  });
});
