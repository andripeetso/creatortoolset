import { describe, expect, it, vi, afterEach } from "vitest";
import {
  COLUMNS_ORDER,
  DEFAULT_DESK,
  STACKED_ORDER,
  defaultGroupLayout,
  enterFocus,
  hideIsland,
  leaveFocus,
  loadDesk,
  moveIsland,
  parseDesk,
  reorderIslands,
  saveDesk,
  setGeometry,
  showIsland,
  stackedSlots,
  visibleIslands,
} from "./workshop-desk";

afterEach(() => vi.unstubAllGlobals());

const desk = (over: Partial<typeof DEFAULT_DESK> = {}) => ({
  ...DEFAULT_DESK,
  order: [...STACKED_ORDER],
  hidden: [],
  sizes: {},
  ...over,
});

describe("parseDesk", () => {
  it("defaults a missing payload to stacked writing / cowork, Browse / Read's drawer closed", () => {
    const d = parseDesk(null);
    expect(d.geometry).toBe("stacked");
    expect(d.order).toEqual(STACKED_ORDER);
    expect(d.hidden).toEqual(["content"]);
    expect(d.focus).toBeNull();
  });

  it("fills in missing islands and drops unknown ids", () => {
    const d = parseDesk({ geometry: "columns", order: ["cowork", "nope"], hidden: ["writing", "writing"] });
    expect(d.order).toEqual(["cowork", "writing", "content"]);
    expect(d.hidden).toEqual(["writing"]);
  });

  it("refuses to hide every island", () => {
    const d = parseDesk({ hidden: ["writing", "cowork", "content"] });
    expect(d.hidden).toEqual([]);
  });
});

describe("geometry and order", () => {
  it("uses the Stitch column order when switching to columns without a custom order", () => {
    expect(setGeometry(desk(), "columns").order).toEqual(COLUMNS_ORDER);
    expect(setGeometry(desk(), "columns").geometry).toBe("columns");
  });

  it("keeps a custom order when flipping geometry", () => {
    const moved = moveIsland(desk(), "content", -1);
    expect(moved.orderTouched).toBe(true);
    expect(setGeometry(moved, "columns").order).toEqual(moved.order);
  });

  it("swaps neighbors and no-ops at the ends", () => {
    expect(moveIsland(desk(), "writing", -1)).toEqual(desk());
    expect(moveIsland(desk(), "writing", 1).order).toEqual(["cowork", "writing", "content"]);
    expect(moveIsland(desk(), "content", 1).order).toEqual(STACKED_ORDER);
  });

  it("drops an island onto another in the header chip order", () => {
    expect(reorderIslands(desk(), "writing", "content").order).toEqual(["cowork", "content", "writing"]);
    expect(reorderIslands(desk(), "content", "writing").order).toEqual(["content", "writing", "cowork"]);
    expect(reorderIslands(desk(), "writing", "writing")).toEqual(desk());
    expect(reorderIslands(enterFocus(desk()), "writing", "content").order).toEqual(STACKED_ORDER);
  });
});

describe("hide, show, stacked slots", () => {
  it("will not hide the last visible island", () => {
    const one = hideIsland(hideIsland(desk(), "content"), "cowork");
    expect(visibleIslands(one)).toEqual(["writing"]);
    expect(hideIsland(one, "writing").hidden).toEqual(one.hidden);
  });

  it("brings a hidden island back", () => {
    expect(showIsland(hideIsland(desk(), "content"), "content").hidden).toEqual([]);
  });

  it("reads stacked order as top / bottom / side", () => {
    expect(stackedSlots(desk())).toEqual({ stack: ["writing", "cowork"], side: "content" });
    const chatSide = moveIsland(moveIsland(desk(), "cowork", 1), "cowork", 1);
    expect(stackedSlots(chatSide)).toEqual({ stack: ["writing", "content"], side: "cowork" });
  });
});

describe("focus", () => {
  it("solos writing and restores the previous desk on the way out", () => {
    const hidden = hideIsland(desk(), "content");
    const focused = enterFocus(hidden, "writing");
    expect(visibleIslands(focused)).toEqual(["writing"]);
    expect(leaveFocus(focused).hidden).toEqual(["content"]);
    expect(leaveFocus(focused).focus).toBeNull();
  });

  it("toggles off when focusing the same island again", () => {
    const once = enterFocus(desk());
    expect(enterFocus(once).focus).toBeNull();
  });

  it("leaves focus before changing geometry", () => {
    const next = setGeometry(enterFocus(desk()), "columns");
    expect(next.focus).toBeNull();
    expect(next.geometry).toBe("columns");
    expect(next.order).toEqual(COLUMNS_ORDER);
  });
});

describe("storage", () => {
  it("round-trips through localStorage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => {
        values.set(k, v);
      },
    };
    const saved = setGeometry(desk(), "columns");
    saveDesk(saved, storage);
    expect(loadDesk(storage).order).toEqual(COLUMNS_ORDER);
  });

  it("survives blocked storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadDesk().geometry).toBe("stacked");
  });
});

describe("defaultGroupLayout", () => {
  it("gives writing the middle share in three columns", () => {
    const g = defaultGroupLayout("columns", ["cowork", "writing", "content"]);
    expect(g.writing).toBe(42);
    expect(g.cowork + g.writing + g.content).toBe(100);
  });
});
