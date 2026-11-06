import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

export const DESK_KEY = "workshop-desk";
export const ISLANDS = ["writing", "cowork", "content"] as const;
export type IslandId = (typeof ISLANDS)[number];
export type Geometry = "stacked" | "columns";
/** Panel id → percentage (0–100), same shape as react-resizable-panels. */
export type GroupLayout = Record<string, number>;

export const STACKED_ORDER: IslandId[] = ["writing", "cowork", "content"];
export const COLUMNS_ORDER: IslandId[] = ["cowork", "writing", "content"];
export const ISLAND_LABEL: Record<IslandId, string> = {
  writing: "Writing",
  cowork: "Cowork",
  content: "Content",
};

export interface DeskSnapshot {
  geometry: Geometry;
  order: IslandId[];
  hidden: IslandId[];
  orderTouched: boolean;
}

export interface DeskLayout extends DeskSnapshot {
  /** When set, only this island is shown; Esc restores `beforeFocus`. */
  focus: IslandId | null;
  beforeFocus: DeskSnapshot | null;
  sizes: Record<string, GroupLayout>;
}

export const DEFAULT_DESK: DeskLayout = {
  geometry: "stacked",
  order: [...STACKED_ORDER],
  // Browse / Read is a drawer, closed until it's wanted
  hidden: ["content"],
  orderTouched: false,
  focus: null,
  beforeFocus: null,
  sizes: {},
};

const isIsland = (v: unknown): v is IslandId => ISLANDS.includes(v as IslandId);

export function normalizeOrder(raw: unknown): IslandId[] {
  const seen: IslandId[] = [];
  if (Array.isArray(raw)) {
    for (const id of raw) {
      if (isIsland(id) && !seen.includes(id)) seen.push(id);
    }
  }
  for (const id of ISLANDS) if (!seen.includes(id)) seen.push(id);
  return seen;
}

function normalizeHidden(raw: unknown, order: IslandId[]): IslandId[] {
  if (!Array.isArray(raw)) return [];
  const hidden = raw.filter(isIsland).filter((id, i, a) => a.indexOf(id) === i);
  const visible = order.filter((id) => !hidden.includes(id));
  return visible.length ? hidden : [];
}

function snapshotOf(d: DeskSnapshot): DeskSnapshot {
  return { geometry: d.geometry, order: [...d.order], hidden: [...d.hidden], orderTouched: d.orderTouched };
}

export function parseDesk(raw: unknown): DeskLayout {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_DESK, order: [...STACKED_ORDER], sizes: {} };
  const o = raw as Record<string, unknown>;
  const geometry: Geometry = o.geometry === "columns" ? "columns" : "stacked";
  const order = normalizeOrder(o.order);
  const hidden = normalizeHidden(o.hidden, order);
  const orderTouched = o.orderTouched === true;
  const focus = isIsland(o.focus) ? o.focus : null;
  const beforeFocus =
    o.beforeFocus && typeof o.beforeFocus === "object"
      ? (() => {
          const b = o.beforeFocus as Record<string, unknown>;
          const bo = normalizeOrder(b.order);
          return {
            geometry: b.geometry === "columns" ? ("columns" as const) : ("stacked" as const),
            order: bo,
            hidden: normalizeHidden(b.hidden, bo),
            orderTouched: b.orderTouched === true,
          };
        })()
      : null;
  const sizes: Record<string, GroupLayout> = {};
  if (o.sizes && typeof o.sizes === "object") {
    for (const [k, v] of Object.entries(o.sizes as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const g: GroupLayout = {};
      for (const [id, n] of Object.entries(v as Record<string, unknown>)) {
        if (typeof n === "number" && Number.isFinite(n)) g[id] = n;
      }
      if (Object.keys(g).length) sizes[k] = g;
    }
  }
  return { geometry, order, hidden, orderTouched, focus, beforeFocus, sizes };
}

export function loadDesk(storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): DeskLayout {
  try {
    const raw = storage?.getItem(DESK_KEY);
    return raw ? parseDesk(JSON.parse(raw)) : { ...DEFAULT_DESK, order: [...STACKED_ORDER], sizes: {} };
  } catch {
    return { ...DEFAULT_DESK, order: [...STACKED_ORDER], sizes: {} };
  }
}

export function saveDesk(layout: DeskLayout, storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage): void {
  try {
    storage?.setItem(DESK_KEY, JSON.stringify(layout));
  } catch {
    /* private mode */
  }
}

export function visibleIslands(layout: DeskLayout): IslandId[] {
  if (layout.focus) return [layout.focus];
  const vis = layout.order.filter((id) => !layout.hidden.includes(id));
  return vis.length ? vis : [...STACKED_ORDER];
}

/** Stacked geometry: first two in `order` stack, the third is the full-height side. */
export function stackedSlots(layout: DeskLayout): { stack: IslandId[]; side: IslandId | null } {
  const hidden = new Set(layout.focus ? ISLANDS.filter((id) => id !== layout.focus) : layout.hidden);
  const stack = layout.order.slice(0, 2).filter((id) => !hidden.has(id));
  const sideId = layout.order[2];
  const side = sideId && !hidden.has(sideId) ? sideId : null;
  return { stack, side };
}

export function leaveFocus(layout: DeskLayout): DeskLayout {
  if (!layout.focus) return layout;
  const prev = layout.beforeFocus;
  if (!prev) return { ...layout, focus: null, beforeFocus: null };
  return { ...layout, ...prev, order: [...prev.order], hidden: [...prev.hidden], focus: null, beforeFocus: null };
}

export function enterFocus(layout: DeskLayout, id: IslandId = "writing"): DeskLayout {
  if (layout.focus === id) return leaveFocus(layout);
  const base = layout.focus ? leaveFocus(layout) : layout;
  return { ...base, focus: id, beforeFocus: snapshotOf(base) };
}

export function setGeometry(layout: DeskLayout, geometry: Geometry): DeskLayout {
  const live = layout.focus ? leaveFocus(layout) : layout;
  if (live.geometry === geometry) return live;
  const order = live.orderTouched ? live.order : geometry === "columns" ? [...COLUMNS_ORDER] : [...STACKED_ORDER];
  return { ...live, geometry, order };
}

export function moveIsland(layout: DeskLayout, id: IslandId, dir: -1 | 1): DeskLayout {
  const live = layout.focus ? layout : layout;
  if (live.focus) return live;
  const at = live.order.indexOf(id);
  const to = at + dir;
  if (at < 0 || to < 0 || to >= live.order.length) return live;
  const order = [...live.order];
  const swap = order[to]!;
  order[to] = order[at]!;
  order[at] = swap;
  return { ...live, order, orderTouched: true };
}

/** Drop `from` onto `to` in `order` (same index math as the writing beat list). */
export function reorderIslands(layout: DeskLayout, from: IslandId, to: IslandId): DeskLayout {
  if (layout.focus || from === to) return layout;
  const order = [...layout.order];
  const i = order.indexOf(from);
  const j = order.indexOf(to);
  if (i < 0 || j < 0) return layout;
  const [item] = order.splice(i, 1);
  order.splice(j, 0, item!);
  return { ...layout, order, orderTouched: true };
}

export function hideIsland(layout: DeskLayout, id: IslandId): DeskLayout {
  const live = layout.focus ? leaveFocus(layout) : layout;
  if (live.hidden.includes(id)) return live;
  if (visibleIslands({ ...live, focus: null }).length <= 1) return live;
  return { ...live, hidden: [...live.hidden, id] };
}

export function showIsland(layout: DeskLayout, id: IslandId): DeskLayout {
  const live = layout.focus ? leaveFocus(layout) : layout;
  return { ...live, hidden: live.hidden.filter((h) => h !== id) };
}

export function rememberSizes(layout: DeskLayout, groupId: string, sizes: GroupLayout): DeskLayout {
  return { ...layout, sizes: { ...layout.sizes, [groupId]: sizes } };
}

export function defaultGroupLayout(kind: "columns" | "stack-h" | "stack-v", ids: string[]): GroupLayout {
  if (ids.length <= 1) return ids[0] ? { [ids[0]]: 100 } : {};
  if (kind === "columns") {
    if (ids.length === 3) {
      const preset = { cowork: 26, writing: 42, content: 32 };
      const out: GroupLayout = {};
      let used = 0;
      for (const id of ids) {
        const n = preset[id as IslandId] ?? Math.round(100 / ids.length);
        out[id] = n;
        used += n;
      }
      const last = ids[ids.length - 1]!;
      out[last] += 100 - used;
      return out;
    }
    const share = Math.round(100 / ids.length);
    const out: GroupLayout = {};
    ids.forEach((id, i) => {
      out[id] = i === ids.length - 1 ? 100 - share * (ids.length - 1) : share;
    });
    return out;
  }
  if (kind === "stack-h") {
    return ids.length === 2 ? { [ids[0]!]: 48, [ids[1]!]: 52 } : defaultGroupLayout("columns", ids);
  }
  return ids.length === 2 ? { [ids[0]!]: 58, [ids[1]!]: 42 } : defaultGroupLayout("columns", ids);
}

export function groupLayout(layout: DeskLayout, groupId: string, kind: "columns" | "stack-h" | "stack-v", ids: string[]): GroupLayout {
  const saved = layout.sizes[groupId];
  if (saved && ids.every((id) => typeof saved[id] === "number")) return saved;
  return defaultGroupLayout(kind, ids);
}

export function useDeskLayout(): [DeskLayout, Dispatch<SetStateAction<DeskLayout>>] {
  const [desk, setDesk] = useState<DeskLayout>(() => loadDesk());
  useEffect(() => {
    saveDesk(desk);
  }, [desk]);
  return [desk, setDesk];
}
