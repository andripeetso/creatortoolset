import { describe, expect, it } from "vitest";
import { mergeEdit, stackEdits, type ItemEdit } from "@contracts/edit-timeline";
import { ReviewSlotBridge } from "@/lib/review-slots";
import type { ReviewSlotContext } from "@/lib/plugin";
import ReviewEdits from "@/components/ReviewEdits";
import {
  EMPTY_PENDING,
  freshHist,
  histChange,
  histRedo,
  histUndo,
  layOn,
  sentForm,
  sentOf,
  type Hist,
  type Pending,
} from "./edit-history";

// The Review panel's rules: what the undo keys walk, what the comment box carries, and what stays on the timeline
// after a send. The panel itself needs a DOM, which the public checkout does not have, so the rules live in the pure
// module and the panel's wiring (⌘Z through the bridge, clearing on send) is run here against the same functions.

const shot = (key: string, patch: Partial<ItemEdit>): ItemEdit[] => mergeEdit([], key, `Shot ${key}`, patch);
const hole = { id: "h1", track: "V2", rec: 100, len: 50, look: "card" as const };

describe("edit history", () => {
  it("makes one step per real change, and none for a no-op", () => {
    const h = histChange(freshHist([] as ItemEdit[]), (l) => mergeEdit(l, "a", "Shot a", { zoom: 1.2 }));
    expect(h.past).toHaveLength(1);
    expect(histChange(h, (l) => l)).toBe(h);
  });

  it("walks back and forth, and a new edit after an undo drops the redo steps", () => {
    let h = freshHist([] as ItemEdit[]);
    h = histChange(h, (l) => mergeEdit(l, "a", "Shot a", { zoom: 1.2 }));
    h = histChange(h, (l) => mergeEdit(l, "b", "Shot b", { zoom: 1.5 }));
    h = histUndo(h);
    expect(h.now.map((e) => e.key)).toEqual(["a"]);
    h = histRedo(h);
    expect(h.now.map((e) => e.key)).toEqual(["a", "b"]);
    h = histUndo(h);
    h = histChange(h, (l) => mergeEdit(l, "c", "Shot c", { zoom: 2 }));
    expect(h.future).toEqual([]);
    expect(histRedo(h)).toBe(h);
  });

  it("does nothing at the ends of the history", () => {
    const f = freshHist([] as ItemEdit[]);
    expect(histUndo(f)).toBe(f);
    expect(histRedo(f)).toBe(f);
  });
});

describe("what the comment box carries", () => {
  it("gives one chip per edit and a chip for the placeholder, and the payload with it", () => {
    const edits = shot("a", { zoom: 1.2 });
    const form = sentForm(edits, edits, hole, 25);
    expect(form.chips).toHaveLength(2);
    expect(form.chips[1]).toBe("Placeholder on V2");
    expect(form.payload).toEqual({ edits, hole });
  });

  it("sends no payload when there is nothing to send", () => {
    expect(sentForm([], [], null, 25)).toEqual({ chips: [], payload: null });
  });

  it("sends the edits without a placeholder when none is drawn", () => {
    const edits = shot("a", { zoom: 1.2 });
    expect(sentForm(edits, edits, null, 25).payload).toEqual({ edits });
  });
});

describe("what was sent stays on the timeline", () => {
  it("stacks the sent edits oldest first (a later edit of an item wins whole, as stackEdits does) and keeps the sent placeholders with their comment", () => {
    const first = shot("V2:10", { move: 12 });
    const second = shot("V2:10", { head: 4 });
    const { edits, holes } = sentOf([
      { id: "c1", data: { edits: first } },
      { id: "c2", data: { edits: second, hole: { track: "A2", rec: 5, len: 20 } } },
      { id: "c3", data: { edits: [], hole: { track: "X9", rec: 0, len: 5 } } },
    ]);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ key: "V2:10", head: 4 });
    expect(edits[0].move).toBeUndefined();
    expect(holes).toEqual([{ id: "c2", track: "A2", rec: 5, len: 20 }]);
  });

  it("starts an item a sent comment already edited from where that left it", () => {
    const sent = shot("a", { move: 12, split: [30] });
    const list = layOn(sent, [], "a", "Shot a", { zoom: 2 });
    expect(list[0]).toMatchObject({ move: 12, zoom: 2 });
    expect(list[0].split).toBeUndefined();
  });

  it("keeps the sent edit in the plan when a new unsent edit is added to it", () => {
    const sent = shot("a", { move: 12 });
    const plan = stackEdits([sent, shot("b", { zoom: 1.1 })]);
    expect(plan.map((e) => e.key)).toEqual(["a", "b"]);
  });
});

describe("the panel's wiring through the bridge", () => {
  // the same reducer the panel runs: its own ⌘Z history is registered once with the bridge
  it("⌘Z and ⇧⌘Z walk the panel's edits through the bridge, and the newest plug-in gets them", () => {
    const bridge = new ReviewSlotBridge();
    const { composer, history } = bridge.bind("tl");
    let hist: Hist<Pending> = freshHist(EMPTY_PENDING);
    history.register({ undo: () => (hist = histUndo(hist)), redo: () => (hist = histRedo(hist)) });
    hist = histChange(hist, (p) => ({ ...p, edits: mergeEdit(p.edits, "a", "Shot a", { zoom: 1.3 }) }));
    composer.setPayload({ edits: hist.now.edits });
    expect(bridge.payload()).toEqual({ tl: { edits: hist.now.edits } });

    expect(bridge.history(false)).toBe(true);
    expect(hist.now.edits).toEqual([]);
    expect(bridge.history(true)).toBe(true);
    expect(hist.now.edits.map((e) => e.key)).toEqual(["a"]);
  });

  it("a sent comment clears the panel's pending work, its chips and its payload", () => {
    const bridge = new ReviewSlotBridge();
    const { composer } = bridge.bind("tl");
    let hist: Hist<Pending> = freshHist(EMPTY_PENDING);
    composer.onSent(() => (hist = freshHist(EMPTY_PENDING)));
    composer.setPending(["Shot a"]);
    composer.setPayload({ edits: shot("a", { zoom: 1.3 }) });
    composer.setNeedsText("Say what goes in the placeholder");
    bridge.sent();
    expect(hist.now).toEqual(EMPTY_PENDING);
    expect(bridge.pendingLabels()).toEqual([]);
    expect(bridge.payload()).toBeUndefined();
    expect(bridge.textNeeded()).toBeNull();
  });

  it("a placeholder holds the send until there are words for it", () => {
    const bridge = new ReviewSlotBridge();
    const { composer } = bridge.bind("tl");
    composer.setNeedsText("Say what goes in the placeholder");
    expect(bridge.textNeeded()).toBe("Say what goes in the placeholder");
    composer.setNeedsText(null);
    expect(bridge.textNeeded()).toBeNull();
  });
});

describe("the panel's gate", () => {
  it("shows nothing on a version with no timeline; an imported timeline (no AI edit) gets the panel", () => {
    const base = { version: { n: 2, timeline: true }, composer: null } as unknown as ReviewSlotContext;
    expect(ReviewEdits({ ...base, version: { n: 2, timeline: true } } as unknown as ReviewSlotContext)).not.toBeNull();
    expect(ReviewEdits({ ...base, version: { n: 2, timeline: false, edit: { project: "p", draft: "d" } } } as unknown as ReviewSlotContext)).toBeNull();
  });
});
