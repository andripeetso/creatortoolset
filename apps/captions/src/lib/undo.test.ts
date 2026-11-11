import { beforeEach, describe, expect, it, vi } from "vitest";

const shown = vi.hoisted(() => ({ notice: null as { text: string; id: string } | null, errors: [] as string[] }));
vi.mock("sonner", () => {
  const toast = Object.assign(
    (text: string, opts: { id: string }) => void (shown.notice = { text, id: opts.id }),
    {
      dismiss: (id: string) => void (shown.notice?.id === id && (shown.notice = null)),
      error: (text: string) => void shown.errors.push(text),
    },
  );
  return { toast };
});

import { noticeText, UNDO_MS, undoable, undoKey, undoLatest } from "./undo";
import { SESSION_STATUSES } from "@contracts/workshop-statuses";
import { SESSION_MOVES } from "../../api/lib/workshop/types";
import { canMove } from "../../api/lib/transition";
import { statusSteps } from "./workshop";

const key = (over: Partial<Parameters<typeof undoKey>[0]> = {}) => {
  const e = { key: "z", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, target: null, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...over };
  undoKey(e);
  return e;
};
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  while (undoLatest());
  shown.errors.length = 0;
});

describe("undo", () => {
  it("says one move by its name and several by their count", () => {
    expect(noticeText("cleared", 1)).toBe("Cleared");
    expect(noticeText("moved to trash", 3)).toBe("3 moved to trash");
  });

  it("takes back the newest moves of one kind together, newest first, then the kind before them", async () => {
    const order: string[] = [];
    undoable("moved", () => void order.push("m1"));
    undoable("cleared", () => void order.push("c1"));
    undoable("cleared", () => void order.push("c2"), 4);
    expect(shown.notice?.text).toBe("5 cleared");

    expect(undoLatest()).toBe(true);
    await settle();
    expect(order).toEqual(["c2", "c1"]);
    expect(shown.notice?.text).toBe("Moved");

    expect(undoLatest()).toBe(true);
    await settle();
    expect(order).toEqual(["c2", "c1", "m1"]);
    expect(shown.notice).toBeNull();
    expect(undoLatest()).toBe(false);
  });

  it("forgets the moves when the notice goes: a later ⌘Z is the page's own", async () => {
    const back = vi.fn();
    undoable("cleared", back);
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(shown.notice).toBeNull();
    const e = key();
    expect(back).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it("⌘Z takes the move back once and keeps the key from the page, however long it is held", async () => {
    const back = vi.fn();
    undoable("cleared", back);
    undoable("moved", back);
    const first = key();
    const again = key({ repeat: true });
    await settle();
    expect(back).toHaveBeenCalledTimes(1);
    expect(first.stopImmediatePropagation).toHaveBeenCalled();
    expect(again.stopImmediatePropagation).toHaveBeenCalled();
    key();
    await settle();
    expect(back).toHaveBeenCalledTimes(2);
  });

  it("owns ⌘Z in a text field only until he types there", async () => {
    const back = vi.fn();
    const field = { tagName: "TEXTAREA" } as unknown as EventTarget;
    undoable("cleared", back);
    key({ key: "a", metaKey: false, target: field });
    const typed = key({ target: field });
    expect(back).not.toHaveBeenCalled();
    expect(typed.preventDefault).not.toHaveBeenCalled();
    // outside a field the notice's move still goes back
    key();
    await settle();
    expect(back).toHaveBeenCalledTimes(1);

    undoable("cleared", back);
    key({ target: field });
    await settle();
    expect(back).toHaveBeenCalledTimes(2);
  });

  it("says so when a move could not be taken back", async () => {
    undoable("cleared", () => Promise.reject(new Error("Not found")));
    undoLatest();
    await settle();
    expect(shown.errors).toEqual(["Could not undo"]);
  });
});

describe("a Workshop status taken back", () => {
  it("only makes moves the server allows, and ends on the status it had (a shelved session goes through Writing)", () => {
    for (const was of SESSION_STATUSES) {
      for (const now of SESSION_STATUSES) {
        if (was === now || !canMove(SESSION_MOVES, was, now)) continue; // a move the server refused has nothing to undo
        const steps = statusSteps(now, was);
        let at: (typeof SESSION_STATUSES)[number] = now;
        for (const to of steps) {
          expect(canMove(SESSION_MOVES, at, to), `${now} → ${was}: ${at} → ${to}`).toBe(true);
          at = to;
        }
        expect(at).toBe(was);
      }
    }
  });
});
