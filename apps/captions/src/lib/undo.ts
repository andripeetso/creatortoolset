import { toast } from "sonner";

/**
 * Taking a move back. A page that makes a move with an opposite (a status, a place, the trash) calls undoable() once the
 * server has it, with how to take it back. A notice says what happened ("3 cleared") with an Undo button for a few
 * seconds. While it shows, ⌘Z (Ctrl+Z) or the button takes back the newest moves of one kind together; the kind before
 * them is next. Once the notice is gone the keys are the page's own again.
 */

interface Move {
  what: string;
  count: number;
  back: () => unknown;
}

/** How long the notice stays after the newest move. */
export const UNDO_MS = 6000;

let live: Move[] = [];
let expiry: ReturnType<typeof setTimeout> | undefined;
/** the notice on screen */
let shown: string | null = null;
let made = 0;
/** A new notice owns ⌘Z even in a text field, until another key is pressed or text changes: then the field has its own undo back. */
let claimed = false;
/** A held key takes back once. */
let held = false;

/** "Cleared" for one, "3 cleared" for more. */
export const noticeText = (what: string, count: number) => (count > 1 ? `${count} ${what}` : what.charAt(0).toUpperCase() + what.slice(1));

/** The newest moves of one kind: what one Undo takes back. */
function newest(): Move[] {
  const last = live.at(-1);
  if (!last) return [];
  let from = live.length - 1;
  while (from > 0 && live[from - 1].what === last.what) from--;
  return live.slice(from);
}

/** The key to say on the button: none on a phone. */
const keys = () =>
  typeof navigator === "undefined" ? "" : /Mac/.test(navigator.platform) ? " ⌘Z" : /iP|Android/.test(navigator.userAgent) ? "" : " Ctrl+Z";

function show() {
  const group = newest();
  if (!group.length) {
    const id = shown;
    shown = null;
    if (id) toast.dismiss(id);
    return;
  }
  // a notice already up changes its words in place; one that was taken down is never brought back under its old name
  const id = (shown ??= `undo-${++made}`);
  toast(noticeText(group[0].what, group.reduce((n, m) => n + m.count, 0)), {
    id,
    duration: Infinity,
    position: "bottom-center",
    action: {
      label: `Undo${keys()}`,
      onClick: (e) => {
        e.preventDefault(); // the notice stays for the moves before these, or goes by itself
        undoLatest();
      },
    },
    // swiped away: what is not on screen can't be taken back by a key
    onDismiss: () => {
      if (shown === id) forget();
    },
  });
}

function forget() {
  live = [];
  clearTimeout(expiry);
  show();
}

/**
 * This move can be taken back. `what` is what happened, small and in the past ("cleared", "moved to trash"); `count`
 * how many things it moved; `back` puts them where they were (a rejected promise is said as "Could not undo").
 */
export function undoable(what: string, back: () => unknown, count = 1) {
  live.push({ what, count, back });
  claimed = true;
  clearTimeout(expiry);
  expiry = setTimeout(forget, UNDO_MS);
  show();
}

/** Takes back the newest moves of one kind. False when there is nothing to take back. */
export function undoLatest(): boolean {
  const group = newest();
  if (!group.length) return false;
  live = live.slice(0, live.length - group.length);
  if (!live.length) clearTimeout(expiry);
  show();
  void (async () => {
    const failed: unknown[] = [];
    // newest first, one after the other: a thing moved twice ends where it started
    for (const m of group.reverse()) {
      try {
        await m.back();
      } catch (e) {
        failed.push(e);
      }
    }
    if (failed.length) toast.error("Could not undo", { description: failed[0] instanceof Error ? failed[0].message : String(failed[0]) });
  })();
  return true;
}

const MODIFIERS = new Set(["Meta", "Control", "Shift", "Alt"]);

const inField = (t: unknown) => {
  const el = t as { tagName?: string; isContentEditable?: boolean } | null;
  return !!el && (el.isContentEditable === true || /^(INPUT|TEXTAREA)$/.test(el.tagName ?? ""));
};

type Key = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "repeat" | "target" | "preventDefault" | "stopImmediatePropagation">;

/**
 * Every key press, before the page's own handlers. With no notice up it does nothing at all, so an editor's own ⌘Z is
 * untouched. With one up, ⌘Z takes the move back and the page never hears the key (one undo, never two).
 */
export function undoKey(e: Key) {
  if (!e.repeat) held = false;
  const z = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z";
  if (!z) {
    if (!MODIFIERS.has(e.key)) claimed = false;
    return;
  }
  if (held) {
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  if (!live.length || (inField(e.target) && !claimed)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  held = true;
  undoLatest();
}

if (typeof window !== "undefined") {
  window.addEventListener("keydown", undoKey, true);
  window.addEventListener("input", () => void (claimed = false), true);
}
