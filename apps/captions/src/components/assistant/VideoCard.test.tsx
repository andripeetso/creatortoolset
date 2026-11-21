// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMedia } from "@contracts/assistant";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const confirmDialog = vi.fn();
vi.mock("@/lib/dialogs", () => ({ confirmDialog: (...a: unknown[]) => confirmDialog(...a) }));
const { VideoCards } = await import("./VideoCard");

const cut: AssistantMedia = { id: "review:a1:2", kind: "video", title: "Tiny tumbles · Draft 2", src: "/p", href: "/review/a1?v=2", cut: { asset: "a1", n: 2, next: "B-roll", editor: "/editor/e1/v1" } };
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const show = (media: AssistantMedia[]) => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter><VideoCards media={media} /></MemoryRouter>));
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
  it("plays with Open in Review, Open in Editor and Approve (saying what it starts); a plain video keeps Open and no buttons", () => {
    const el = show([cut, { ...cut, id: "v", cut: undefined }]);
    expect(buttons()).toEqual(["Approve · add B-roll"]);
    const links = [...el.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([
      ["Tiny tumbles · Draft 2", "/review/a1?v=2"], ["Open in Review", "/review/a1?v=2"], ["Open in Editor", "/editor/e1/v1"],
      ["Tiny tumbles · Draft 2", "/review/a1?v=2"], ["Open ", "/review/a1?v=2"],
    ]);
  });

  it("a cut without its timeline has no Open in Editor", () => {
    const el = show([{ ...cut, cut: { asset: "a1", n: 2 } }]);
    expect([...el.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Tiny tumbles · Draft 2", "Open in Review"]);
    expect(buttons()).toEqual(["Approve"]);
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
});
