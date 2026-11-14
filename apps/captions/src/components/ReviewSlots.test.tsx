import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Star } from "lucide-react";
import type { Me } from "@/lib/auth";
import { defineWebPlugin, reviewSlotsFor, type ReviewSlotContext } from "@/lib/plugin";
import { ReviewSlotBridge } from "@/lib/review-slots";
import { PLUGIN_PAYLOAD_MAX, payloadError } from "@contracts/review-payload";
import { ReviewActionButtons, ReviewPanelSlots, type ReviewBaseContext } from "./ReviewSlots";

// A test plug-in with a panel and a button, both behind one gate, plus an open button with the same label
// as a second plug-in's, to check that the keys stay apart.
const TinyPanel = ({ version }: { version: { n: number } }) => <p>Tiny panel v{version.n}</p>;
const tiny = defineWebPlugin({
  id: "tiny",
  review: {
    panels: [{ id: "panel", gate: "tiny-gate", panel: TinyPanel }],
    actions: [{ label: "Tiny action", icon: Star, gate: "tiny-gate", onRun: () => {} }],
  },
});
const other = defineWebPlugin({
  id: "other",
  review: { actions: [{ label: "Tiny action", onRun: () => {} }] },
});

const member = (off: string[] = []): Me => ({ username: "member", role: "user", cloud: false, off });
const admin = (): Me => ({ username: "admin-user", role: "admin", cloud: false, off: [] });

const ctx = (o: { manage?: boolean; status?: string; removed?: boolean } = {}): ReviewBaseContext =>
  ({
    asset: { id: "a1" },
    version: { n: 2, status: o.status ?? "ready", removed: o.removed ?? false },
    manage: o.manage ?? true,
    api: {},
    reload: async () => {},
    player: { video: () => null, seek: () => {}, pause: () => {} },
  }) as unknown as ReviewBaseContext;

const bind = (pluginId: string) => ({ ...new ReviewSlotBridge().bind(pluginId), sent: [] });

describe("Review plug-in slots on the page", () => {
  const slots = (me: Me | null) => reviewSlotsFor(me, [tiny, other]);

  it("shows the panel and the button to a manager on a ready version", () => {
    const s = slots(admin());
    const panels = renderToStaticMarkup(<ReviewPanelSlots slots={s.panels} ctx={ctx()} bind={bind} />);
    const buttons = renderToStaticMarkup(<ReviewActionButtons actions={s.actions} ctx={ctx()} bind={bind} />);
    expect(panels).toContain("Tiny panel v2");
    expect(buttons.match(/aria-label="Tiny action"/g)).toHaveLength(2);
  });

  it("leaves a gated panel or button out for a guest or a member with the gate off", () => {
    const guest = slots(null);
    expect(guest.panels).toEqual([]);
    expect(guest.actions.map((a) => a.key)).toEqual(["other/Tiny action"]);

    const off = slots(member(["tiny-gate"]));
    expect(off.panels).toEqual([]);
    expect(off.actions.map((a) => a.key)).toEqual(["other/Tiny action"]);
    expect(renderToStaticMarkup(<ReviewPanelSlots slots={off.panels} ctx={ctx()} bind={bind} />)).toBe("");
  });

  it("hides every slot from a viewer who cannot manage the video, even an admin", () => {
    const s = slots(admin());
    expect(renderToStaticMarkup(<ReviewPanelSlots slots={s.panels} ctx={ctx({ manage: false })} bind={bind} />)).toBe("");
    expect(renderToStaticMarkup(<ReviewActionButtons actions={s.actions} ctx={ctx({ manage: false })} bind={bind} />)).toBe("");
  });

  it("hides every slot on a version that is not ready or was removed", () => {
    const s = slots(admin());
    for (const c of [ctx({ status: "processing" }), ctx({ removed: true })]) {
      expect(renderToStaticMarkup(<ReviewPanelSlots slots={s.panels} ctx={c} bind={bind} />)).toBe("");
      expect(renderToStaticMarkup(<ReviewActionButtons actions={s.actions} ctx={c} bind={bind} />)).toBe("");
    }
  });

  it("gives two plug-in buttons with the same label different keys", () => {
    const keys = slots(admin()).actions.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["tiny/Tiny action", "other/Tiny action"]);
  });

  it("passes each panel the slot functions bound to its own plug-in", () => {
    const seen: ReviewSlotContext[] = [];
    const Probe = (p: ReviewSlotContext) => {
      seen.push(p);
      return null;
    };
    const probe = defineWebPlugin({ id: "probe", review: { panels: [{ id: "p", panel: Probe }] } });
    const bridge = new ReviewSlotBridge();
    renderToStaticMarkup(<ReviewPanelSlots slots={reviewSlotsFor(admin(), [probe]).panels} ctx={ctx()} bind={(id) => ({ ...bridge.bind(id), sent: [] })} />);
    expect(seen).toHaveLength(1);
    seen[0].composer.setPayload({ edits: 1 });
    expect(bridge.payload()).toEqual({ probe: { edits: 1 } });
  });
});

describe("ReviewSlotBridge", () => {
  it("keeps each plug-in's chips and payload under its own id, and clears them when sent", () => {
    let changes = 0;
    const b = new ReviewSlotBridge(() => changes++);
    const a = b.bind("tiny-acrobatics");
    const o = b.bind("other");
    let sent = 0;
    a.composer.onSent(() => sent++);
    a.composer.setPending(["Moved V1 by 12 frames", "Trimmed A1"]);
    a.composer.setPayload({ edits: [{ key: "V1:1", label: "x", move: 12 }] });
    o.composer.setPayload({ note: 1 });
    expect(b.pendingLabels()).toEqual(["Moved V1 by 12 frames", "Trimmed A1"]);
    expect(b.payload()).toEqual({ "tiny-acrobatics": { edits: [{ key: "V1:1", label: "x", move: 12 }] }, other: { note: 1 } });
    expect(changes).toBeGreaterThan(0);
    b.sent();
    expect(sent).toBe(1);
    expect(b.pendingLabels()).toEqual([]);
    expect(b.payload()).toBeUndefined();
  });

  it("sends ⌘Z to the newest registered plug-in, and a removed one gets nothing", () => {
    const b = new ReviewSlotBridge();
    const calls: string[] = [];
    expect(b.history(false)).toBe(false);
    const first = b.bind("first").history.register({ undo: () => calls.push("first:undo"), redo: () => calls.push("first:redo") });
    const second = b.bind("second").history.register({ undo: () => calls.push("second:undo"), redo: () => calls.push("second:redo") });
    b.history(false);
    b.history(true);
    second();
    b.history(false);
    first();
    expect(b.history(false)).toBe(false);
    expect(calls).toEqual(["second:undo", "second:redo", "first:undo"]);
  });

  it("holds a send that needs words until the plug-in lifts it or the comment goes out", () => {
    const b = new ReviewSlotBridge();
    const a = b.bind("tiny-acrobatics");
    expect(b.textNeeded()).toBeNull();
    a.composer.setNeedsText("Say what goes in the placeholder");
    expect(b.textNeeded()).toBe("Say what goes in the placeholder");
    a.composer.setNeedsText(null);
    expect(b.textNeeded()).toBeNull();
    a.composer.setNeedsText("Say what goes in the placeholder");
    b.sent();
    expect(b.textNeeded()).toBeNull();
  });

  it("refuses a payload that is not a small object of short plug-in ids", () => {
    expect(payloadError(undefined)).toBeUndefined();
    expect(payloadError({ "tiny-acrobatics": { edits: [] } })).toBeUndefined();
    expect(payloadError([1])).toBe("plugins must be an object");
    expect(payloadError({ "Bad Id": {} })).toBe("bad plug-in id");
    expect(payloadError({ x: "a".repeat(PLUGIN_PAYLOAD_MAX) })).toBe("The plug-in data is too big");
    expect(payloadError(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`p${i}`, 1])))).toBe("too many plug-ins on one comment");
  });
});
