// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantConfirm, AssistantView } from "@contracts/assistant";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const answerConfirm = vi.fn();
vi.mock("@/lib/assistant", () => ({ answerConfirm: (...a: unknown[]) => answerConfirm(...a) }));
const { ConfirmCards } = await import("./ConfirmCards");

const card = (over: Partial<AssistantConfirm> = {}): AssistantConfirm => ({ id: "q1", question: "Delete the scheduled task “Monday comments”?", at: 1, status: "waiting", ...over });
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const show = (confirms: AssistantConfirm[], onView: (v: AssistantView) => void = () => {}) => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(<ConfirmCards confirms={confirms} onView={onView} />));
  return host;
};
const press = (name: string) => act(async () => void [...host!.querySelectorAll("button")].find((b) => b.textContent === name)!.click());
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  answerConfirm.mockReset();
});

describe("the Yes / No card", () => {
  it("asks the question, sends the press and hands the dock the conversation that comes back", async () => {
    const view = { id: "c" } as AssistantView;
    answerConfirm.mockResolvedValue({ ok: true, data: view });
    const onView = vi.fn();
    expect(show([card()], onView).textContent).toContain("Delete the scheduled task “Monday comments”?");
    await press("Yes");
    expect(answerConfirm).toHaveBeenCalledWith("q1", true);
    expect(onView).toHaveBeenCalledWith(view);
  });

  it("answered, it says how it went and offers nothing more to press", () => {
    const el = show([card({ status: "done" }), card({ id: "q2", status: "no" }), card({ id: "q3", status: "failed", result: "Not found, or not this account's." })]);
    expect(el.querySelectorAll("button")).toHaveLength(0);
    expect([...el.querySelectorAll("li")].map((li) => li.textContent!.replace("Delete the scheduled task “Monday comments”?", "").trim())).toEqual(["Done", "Not done", "Not found, or not this account's."]);
  });

  it("a refused press says why and the card stays to press again", async () => {
    answerConfirm.mockResolvedValue({ ok: false, error: "Already answered" });
    const el = show([card()]);
    await press("No");
    expect(answerConfirm).toHaveBeenCalledWith("q1", false);
    expect(el.textContent).toContain("Already answered");
    expect([...el.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Yes", "No"]);
  });
});
