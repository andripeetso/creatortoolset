// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { markSave, SaveMark } from "./page-action";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SaveMark", () => {
  it("says Saving while a save runs, Saved after, and nothing on a fresh page or after a failure", async () => {
    const el = document.body.appendChild(document.createElement("div"));
    const root = createRoot(el);
    act(() => root.render(<SaveMark page="/settings/a" />));
    expect(el.textContent).toBe("");

    let done!: () => void;
    let p!: Promise<void>;
    act(() => void (p = markSave(new Promise<void>((r) => (done = r)))));
    expect(el.textContent).toBe("Saving");
    await act(async () => (done(), await p));
    expect(el.textContent).toBe("Saved");

    act(() => root.render(<SaveMark page="/settings/b" />));
    expect(el.textContent).toBe("");

    await act(async () => void (await markSave(Promise.reject(new Error("x"))).catch(() => {})));
    expect(el.textContent).toBe("");
    act(() => root.unmount());
  });
});
