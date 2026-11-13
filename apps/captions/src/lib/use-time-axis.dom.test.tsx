// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTimeAxis } from "./use-time-axis";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The axis on a scroller. happy-dom lays nothing out, so the scroller's width is given here.
let viewWidth = 1000;
type Axis = ReturnType<typeof useTimeAxis>;
let axis: Axis;
function Probe(p: { seconds: number; maxPps: number; startPps?: number }) {
  const scroller = useRef<HTMLDivElement>(null);
  axis = useTimeAxis({ scroller, seconds: p.seconds, maxPps: p.maxPps, startPps: p.startPps, now: () => 0 });
  return <div ref={scroller} />;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  viewWidth = 1000;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => viewWidth });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const show = (p: { seconds: number; maxPps: number; startPps?: number }) => act(async () => root.render(<Probe {...p} />));

describe("the time axis on a scroller", () => {
  it("opens on the whole length, and zooms no further than the widest a second gets", async () => {
    await show({ seconds: 20, maxPps: 200 });
    expect(axis.pps).toBe(50); // 1000 px for 20 s
    expect(axis.maxZoom).toBe(4);
    await act(async () => axis.zoomBy(1.5));
    expect(axis.pps).toBe(75);
    await act(async () => axis.zoomTo(99));
    expect(axis.pps).toBe(200);
    await act(async () => axis.zoomTo(0));
    expect(axis.pps).toBe(50);
  });

  it("with a starting width it opens at that, on the whole length when that is wider, and again for a new length", async () => {
    await show({ seconds: 50, maxPps: 300, startPps: 60 });
    expect(axis.pps).toBe(60); // fitted it would be 20
    await act(async () => axis.zoomBy(2));
    expect(axis.pps).toBe(120);
    // a new clip opens at the starting width again; a short one on its whole length
    await show({ seconds: 100, maxPps: 150, startPps: 60 });
    expect(axis.pps).toBe(60);
    await show({ seconds: 5, maxPps: 300, startPps: 60 });
    expect(axis.pps).toBe(200);
  });

  it("stays under the widest a second gets when that drops under the zoom it had", async () => {
    await show({ seconds: 20, maxPps: 400 });
    await act(async () => axis.zoomTo(8));
    expect(axis.pps).toBe(400);
    await show({ seconds: 20, maxPps: 100 });
    expect(axis.pps).toBe(100);
    // and the next step out starts from there, not from the zoom it had
    await act(async () => axis.zoomBy(0.5));
    expect(axis.pps).toBe(50);
  });

  it("takes = - and \\ as zoom keys and no other key", async () => {
    await show({ seconds: 20, maxPps: 400 });
    const key = (k: string) => new KeyboardEvent("keydown", { key: k });
    let took = false;
    await act(async () => void (took = axis.key(key("="))));
    expect([took, axis.pps]).toEqual([true, 75]);
    await act(async () => void (took = axis.key(key("\\"))));
    expect([took, axis.pps]).toEqual([true, 50]);
    await act(async () => void (took = axis.key(key("a"))));
    expect([took, axis.pps]).toEqual([false, 50]);
  });
});
