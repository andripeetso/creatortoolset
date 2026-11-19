// The editor's keys, Resolve's Edit page with the owner's own on top: one table, chord → what it does. A chord is the
// modifiers in the order ⌘ ⌥ ⇧ (Ctrl counts as ⌘) and then the key. Letters come from e.key (any layout), but with ⌥
// a Mac types another character (⌥Y gives "¥"), so then the key's place (e.code) names it; digits, comma and period
// always come from their place (⇧1 is "!", ⌥⇧1 is "⁄", ⇧, is "<").

export type KeyAction =
  | "play" | "stop" | "forward" | "reverse"
  | "save" | "undo" | "redo" | "split" | "copy" | "cut" | "paste" | "duplicate" | "selectAll" | "deselect"
  | "selectForward" | "selectBack" | "rippleStart" | "rippleEnd" | "delete" | "rippleDelete" | "enable"
  | "markIn" | "markOut" | "clearMarks" | "toolSelect" | "toolTrim" | "toolBlade" | "snap" | "linkedSelection"
  | "nudgeBack" | "nudgeBack5" | "nudgeOn" | "nudgeOn5"
  | "frameBack" | "frameOn" | "secondBack" | "secondOn" | "prevEdit" | "nextEdit" | "start" | "end"
  | "zoomIn" | "zoomOut" | "zoomFit" | "mediaPool" | "inspector"
  | `lock:V${number}`;

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

export function chordOf(e: KeyLike): string {
  const name = !e.altKey && /^[a-z]$/i.test(e.key) ? e.key.toUpperCase()
    : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3)
    : /^Digit\d$/.test(e.code) ? e.code.slice(5)
    : e.code === "Comma" ? "," : e.code === "Period" ? "."
    : e.key === " " ? "Space" : e.key;
  return `${e.metaKey || e.ctrlKey ? "⌘" : ""}${e.altKey ? "⌥" : ""}${e.shiftKey ? "⇧" : ""}${name}`;
}

export const KEYS: Record<string, KeyAction> = {
  Space: "play", "2": "play", K: "stop", L: "forward", "3": "forward", J: "reverse", "1": "reverse",
  "⌘S": "save", "⌘Z": "undo", "⌘⇧Z": "redo",
  W: "split", "⌘B": "split", "⌘\\": "split",
  "⌘C": "copy", "⌘X": "cut", "⌘V": "paste", "⌘D": "duplicate", "⌘A": "selectAll", Escape: "deselect",
  "⌥Y": "selectForward", "⌘⌥Y": "selectBack",
  Q: "rippleStart", E: "rippleEnd",
  S: "rippleDelete", Delete: "rippleDelete", "⇧Delete": "rippleDelete", "⇧Backspace": "rippleDelete", Backspace: "delete",
  D: "enable",
  I: "markIn", O: "markOut", "⌥X": "clearMarks",
  A: "toolSelect", T: "toolTrim", B: "toolBlade", N: "snap", "⌘⇧L": "linkedSelection",
  ",": "nudgeBack", "⇧,": "nudgeBack5", ".": "nudgeOn", "⇧.": "nudgeOn5",
  ArrowLeft: "frameBack", ArrowRight: "frameOn", "⇧ArrowLeft": "secondBack", "⇧ArrowRight": "secondOn",
  ArrowUp: "prevEdit", ArrowDown: "nextEdit", Home: "start", End: "end",
  "=": "zoomIn", "+": "zoomIn", "⇧+": "zoomIn", "⌘=": "zoomIn", "⌘+": "zoomIn", "⌘⇧+": "zoomIn",
  "-": "zoomOut", "⌘-": "zoomOut", "\\": "zoomFit", "⇧Z": "zoomFit",
  Tab: "mediaPool", "⇧Tab": "inspector",
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`⌥⇧${n}`, `lock:V${n}` as const])),
};

export const keyAction = (e: KeyLike): KeyAction | null => KEYS[chordOf(e)] ?? null;
