import { useSyncExternalStore } from "react";
import type { BrowseView } from "./Bar";

/**
 * Which view each tool's list opens in: cards ("grid") or rows ("list"). Kept on this device like the theme. The
 * person's pick on a page (its switch) is that page's; Settings → Appearance sets what a page opens with until then,
 * and `view` is ours.
 */
export const BROWSE_VIEWS = {
  review: { label: "Review", view: "grid" },
  finals: { label: "Finals", view: "grid" },
  editor: { label: "AI Editor", view: "list" },
  captions: { label: "Caption Studio", view: "grid" },
  stories: { label: "Story Splitter", view: "list" },
  notes: { label: "Video Notes", view: "list" },
  guides: { label: "Guide Builder", view: "list" },
  recorder: { label: "Screen Recorder", view: "grid" },
} as const satisfies Record<string, { label: string; view: BrowseView }>;
export type BrowseTool = keyof typeof BROWSE_VIEWS;
export const BROWSE_TOOLS = Object.keys(BROWSE_VIEWS) as BrowseTool[];

const EVENT = "browse-view-change";
// Caption Studio kept its pick under this key before the others had one
const pickKey = (t: BrowseTool) => (t === "captions" ? "cap-projects-view" : `browse:view:${t}`);
const defaultKey = (t: BrowseTool) => `appearance:view:${t}`;

function read(key: string): BrowseView | null {
  try {
    const v = localStorage.getItem(key);
    return v === "grid" || v === "list" ? v : null;
  } catch {
    return null;
  }
}
function write(key: string, v: BrowseView | null) {
  try {
    if (v) localStorage.setItem(key, v);
    else localStorage.removeItem(key);
  } catch {
    /* storage off (a private window): the choice holds for this visit */
  }
  window.dispatchEvent(new Event(EVENT));
}
const subscribe = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
};

/** What a page opens with when the person has not picked there: Appearance's choice, else ours. */
export const defaultView = (t: BrowseTool): BrowseView => read(defaultKey(t)) ?? BROWSE_VIEWS[t].view;
/** The view a page shows. */
export const pageView = (t: BrowseTool): BrowseView => read(pickKey(t)) ?? defaultView(t);

/** A page's view and its switch: a pick is remembered for that page. */
export function useBrowseView(t: BrowseTool): [BrowseView, (v: BrowseView) => void] {
  const view = useSyncExternalStore(subscribe, () => pageView(t), () => BROWSE_VIEWS[t].view);
  return [view, (v) => write(pickKey(t), v)];
}

/** Settings → Appearance. The newest choice wins: setting a tool's default drops the pick made on its page. */
export function persistDefaultView(t: BrowseTool, v: BrowseView) {
  write(pickKey(t), null);
  write(defaultKey(t), v === BROWSE_VIEWS[t].view ? null : v);
}
/** Every tool back to ours, the picks made on pages too. */
export function resetDefaultViews() {
  for (const t of BROWSE_TOOLS) {
    write(pickKey(t), null);
    write(defaultKey(t), null);
  }
}
/** Settings' rows: every tool's default, live. */
export function useDefaultViews(): Record<BrowseTool, BrowseView> {
  const key = useSyncExternalStore(
    subscribe,
    () => BROWSE_TOOLS.map(defaultView).join(","),
    () => BROWSE_TOOLS.map((t) => BROWSE_VIEWS[t].view).join(","),
  );
  const views = key.split(",") as BrowseView[];
  return Object.fromEntries(BROWSE_TOOLS.map((t, i) => [t, views[i]])) as Record<BrowseTool, BrowseView>;
}

/** A sort kept on this device (one key per page), falling back to the first option. */
export function storedSort<S extends string>(key: string, options: readonly S[]): S {
  try {
    const v = localStorage.getItem(key) as S | null;
    return v && options.includes(v) ? v : options[0];
  } catch {
    return options[0];
  }
}
export function persistSort(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage off: the sort holds for this visit */
  }
}

/** A to Z, numbers in order ("Take 2" before "Take 10"). */
export const byName = (x: { name: string }, y: { name: string }) => x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: "base" });
/** The search box's words found in any of `texts`. */
export const matches = (q: string, ...texts: (string | undefined)[]) => {
  const needle = q.trim().toLowerCase();
  return !needle || texts.some((t) => t?.toLowerCase().includes(needle));
};
