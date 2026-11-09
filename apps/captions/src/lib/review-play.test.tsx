import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defineWebPlugin, reviewSlotsFor, type ReviewPlayPlan, type ReviewSlotContext } from "./plugin";
import { followPlan, mutedAt } from "./review-play";
import { ReviewSlotBridge } from "./review-slots";
import { ReviewPanelSlots } from "@/components/ReviewSlots";

const plan: ReviewPlayPlan = {
  fps: 25,
  skips: [[50, 75]],
  mutes: [[100, 110]],
  holds: [{ at: 200, frames: 10 }],
  cards: [],
  frames: [],
};

describe("followPlan", () => {
  it("jumps over a skipped span when the playhead reaches it", () => {
    expect(followPlan(plan, 51 / 25, 50 / 25)).toEqual({ kind: "seek", to: 75 / 25 });
  });

  it("does nothing outside the spans", () => {
    expect(followPlan(plan, 10 / 25, 9 / 25)).toEqual({ kind: "none" });
  });

  it("holds on the named frame once, when the playhead crosses it", () => {
    expect(followPlan(plan, 200 / 25, 199 / 25)).toEqual({ kind: "hold", to: 200.5 / 25, frames: 10 });
    expect(followPlan(plan, 201 / 25, 200 / 25)).toEqual({ kind: "none" });
  });

  it("mutes inside a muted span only", () => {
    expect(mutedAt(plan, 105 / 25)).toBe(true);
    expect(mutedAt(plan, 110 / 25)).toBe(false);
    expect(mutedAt(null, 105 / 25)).toBe(false);
  });
});

describe("a plug-in's play plan on the page", () => {
  it("a test plug-in's plan reaches the page's player as a skip", () => {
    let ctx: ReviewSlotContext | undefined;
    const Panel = (p: ReviewSlotContext) => {
      ctx = p;
      return null;
    };
    const tiny = defineWebPlugin({ id: "tiny", review: { panels: [{ id: "p", panel: Panel }] } });
    const bridge = new ReviewSlotBridge();
    const slots = reviewSlotsFor({ id: "a", name: "a", role: "admin", off: [] } as never, [tiny]).panels;
    renderToStaticMarkup(<ReviewPanelSlots slots={slots} ctx={{ manage: true, version: { status: "ready", removed: false }, asset: {}, api: {}, reload: async () => {} } as never} bind={(id) => ({ ...bridge.bind(id), sent: [] })} />);
    expect(bridge.plan()).toBeNull();
    ctx!.preview.setPlan(plan);
    const merged = bridge.plan();
    expect(merged?.skips).toEqual([[50, 75]]);
    // the page's effect: the playhead just before the span lands past its end
    expect(followPlan(merged!, 51 / 25, 50 / 25)).toEqual({ kind: "seek", to: 3 });
    // a cleared plan stops the follow
    ctx!.preview.setPlan(null);
    expect(bridge.plan()).toBeNull();
  });
});
