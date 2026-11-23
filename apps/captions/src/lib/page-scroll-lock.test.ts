// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { takesWheel } from "./page-scroll-lock";

function pane(scrollTop: number) {
  const el = document.createElement("div");
  el.style.overflowY = "scroll";
  Object.defineProperties(el, { clientHeight: { value: 100 }, scrollHeight: { value: 300 } });
  el.scrollTop = scrollTop;
  const row = el.appendChild(document.createElement("p"));
  document.body.appendChild(el);
  return row;
}

describe("takesWheel", () => {
  it("lets a pane scroll while it has room that way", () => {
    expect(takesWheel(pane(0), 0, 40)).toBe(true);
    expect(takesWheel(pane(100), 0, -40)).toBe(true);
  });

  it("drops the wheel at a pane's end, on the page and on the backdrop", () => {
    expect(takesWheel(pane(200), 0, 40)).toBe(false);
    expect(takesWheel(pane(0), 0, -40)).toBe(false);
    expect(takesWheel(document.body, 0, 40)).toBe(false);
    expect(takesWheel(document.body.appendChild(document.createElement("div")), 0, 40)).toBe(false);
  });
});
