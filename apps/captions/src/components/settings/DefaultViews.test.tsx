// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAuth } from "@/lib/auth";
import { pageView, persistDefaultView } from "@/components/browse/views";
import { DefaultViews } from "./AppearanceSection";

// Settings → Appearance → Default view: a row for each tool the person has, its value read live, Reset only when
// something differs from ours.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
beforeEach(() => localStorage.clear());
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = undefined;
});
function render(off: string[] = [], role: "admin" | "user" = "admin") {
  useAuth.setState({ required: false, me: { username: "tiny", role, cloud: false, off: off as never } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<DefaultViews />));
  return host;
}
const rows = (el: HTMLElement) => [...el.querySelectorAll("[role=combobox]")].map((c) => [c.getAttribute("aria-label")?.replace(": default view", ""), c.textContent]);

describe("Default view", () => {
  it("a row for each tool the account has, at ours; no Reset", () => {
    const el = render();
    expect(rows(el)).toEqual([
      ["Review", "Cards"],
      ["Finals", "Cards"],
      ["AI Editor", "List"],
      ["Caption Studio", "Cards"],
      ["Story Splitter", "List"],
      ["Video Notes", "List"],
      ["Guide Builder", "List"],
    ]); // the Screen Recorder's row is the Mac app's only
    expect(el.textContent).not.toContain("Reset");
  });

  it("a tool switched off for the account has no row", () => {
    const el = render(["editor", "media"], "user");
    const names = rows(el).map((r) => r[0]);
    expect(names).not.toContain("AI Editor");
    expect(names).not.toContain("Finals");
    expect(names).toContain("Review");
  });

  it("follows a change live, shows Reset, and Reset puts it back", () => {
    const el = render();
    act(() => persistDefaultView("review", "list"));
    expect(rows(el)[0]).toEqual(["Review", "List"]);
    expect(pageView("review")).toBe("list");
    const reset = [...el.querySelectorAll("button")].find((b) => b.textContent === "Reset")!;
    act(() => reset.click());
    expect(rows(el)[0]).toEqual(["Review", "Cards"]);
    expect(el.textContent).not.toContain("Reset");
  });
});
