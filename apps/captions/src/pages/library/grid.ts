import { useEffect, useRef } from "react";

/**
 * The Media Library grid's keys and paging (LibraryPage.tsx): Escape in steps, ⌘A, the next page as the end nears, and
 * where each file of a drop is on this Mac.
 */

/** A window (the clip, a menu, the settings, a question) is open: Escape and ⌘A are its own. */
const layerOpen = () => !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || !!t.closest("input, textarea, select"));

/**
 * Escape takes one step back per press: an open window closes first (it handles its own Escape), then each step in
 * order runs until one says it did something (clears the picks, then the search).
 */
export function useEscapeSteps(steps: (() => boolean)[]) {
  const live = useRef(steps);
  live.current = steps;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // a window's own Escape runs first (it marks the key as taken) and the window is still on the page while it does
      if (e.key !== "Escape" || e.defaultPrevented || layerOpen()) return;
      live.current.some((step) => step());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** ⌘A (Ctrl+A) picks every clip shown; in a text field, or with a window open, it is that one's own. */
export function useSelectAll(all: () => void) {
  const live = useRef(all);
  live.current = all;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "a" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || typing(e.target) || layerOpen()) return;
      e.preventDefault();
      live.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Whether this browser tells the page when the end of the list comes near; without it the page shows Load more. */
export const watchesEnd = () => typeof IntersectionObserver !== "undefined";

/**
 * The element to put after the list: when it comes within a screen of view, `more` loads the next page. Watched again
 * for each new cursor, so a short page (some clips left out for this viewer) that leaves it in view loads the one after.
 */
export function useEndOfList(more: () => void, cursor: string | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  const live = useRef(more);
  live.current = more;
  useEffect(() => {
    const el = ref.current;
    if (!el || !cursor || !watchesEnd()) return;
    const io = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && live.current(), { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor]);
  return ref;
}

/**
 * Where each dropped file is on this Mac, from the drop's Finder items (lib/thisMac droppedOnMac): a loose file by its
 * name, a file inside a dropped folder by that folder's path and its own path in the drop. Only when exactly one item
 * matches; a file with none uploads. A wrong guess is safe: the server checks the path and the size, and refuses.
 */
export function macPaths(files: File[], items: { path: string; folder: boolean }[]): Map<File, string> {
  const nfc = (s: string) => s.normalize("NFC");
  const named = (folder: boolean, name: string) => {
    const same = items.filter((x) => x.folder === folder && nfc(x.path.split("/").pop() ?? "") === nfc(name));
    return same.length === 1 ? same[0].path : undefined;
  };
  const out = new Map<File, string>();
  for (const f of files) {
    const [top, ...rest] = (f.webkitRelativePath || f.name).split("/");
    const at = rest.length ? named(true, top) : named(false, top);
    if (at) out.set(f, rest.length ? `${at}/${rest.join("/")}` : at);
  }
  return out;
}
