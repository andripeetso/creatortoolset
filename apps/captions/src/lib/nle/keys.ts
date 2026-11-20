// The editor's keys, Resolve's Edit page with the owner's own on top: one table, chord → what it does. A chord is the
// modifiers in the order ⌘ ⌥ ⇧ (Ctrl counts as ⌘) and then the key. Letters come from e.key (any layout), but with ⌥
// a Mac types another character (⌥Y gives "¥"), so then the key's place (e.code) names it; digits, comma and period
// always come from their place (⇧1 is "!", ⌥⇧1 is "⁄", ⇧, is "<"), and so do [ and ].
// Keyboard Customization (⌘⌥K) lays the person's own changes over one of two presets: chord → command id, "" = none.

export type KeyAction =
  | "play" | "stop" | "forward" | "reverse"
  | "save" | "undo" | "redo" | "split" | "copy" | "cut" | "paste" | "duplicate" | "selectAll" | "deselect"
  | "selectForward" | "selectBack" | "rippleStart" | "rippleEnd" | "delete" | "rippleDelete" | "enable"
  | "markIn" | "markOut" | "clearMarks" | "toolSelect" | "toolTrim" | "toolBlade" | "snap" | "linkedSelection"
  | "nudgeBack" | "nudgeBack5" | "nudgeOn" | "nudgeOn5"
  | "frameBack" | "frameOn" | "secondBack" | "secondOn" | "prevEdit" | "nextEdit" | "start" | "end"
  | "zoomIn" | "zoomOut" | "zoomFit" | "mediaPool" | "inspector"
  | `lock:V${number}`
  | "clearIn" | "clearOut" | "insertEdit" | "overwriteEdit" | "loop"
  | "addMarker" | "prevMarker" | "nextMarker" | "addDissolve" | "keyboard";

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

export function chordOf(e: KeyLike): string {
  const name = !e.altKey && /^[a-z]$/i.test(e.key) ? e.key.toUpperCase()
    : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3)
    : /^Digit\d$/.test(e.code) ? e.code.slice(5)
    : e.code === "Comma" ? "," : e.code === "Period" ? "." : e.code === "BracketLeft" ? "[" : e.code === "BracketRight" ? "]"
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
  "⌥I": "clearIn", "⌥O": "clearOut", F9: "insertEdit", F10: "overwriteEdit", "⌘/": "loop",
  M: "addMarker", "⇧ArrowUp": "prevMarker", "⇧ArrowDown": "nextMarker", "⌘T": "addDissolve", "⌘⌥K": "keyboard",
};

/** Resolve's own Mac keys for the commands the editor has (the Edit page's defaults, no keys of the owner's). */
export const RESOLVE_KEYS: Record<string, KeyAction> = {
  Space: "play", K: "stop", L: "forward", J: "reverse",
  "⌘S": "save", "⌘Z": "undo", "⌘⇧Z": "redo", "⌘B": "split", "⌘\\": "split",
  "⌘C": "copy", "⌘X": "cut", "⌘V": "paste", "⌘A": "selectAll", "⌘⇧A": "deselect",
  "⌥Y": "selectForward", "⌘⌥Y": "selectBack", "⌘⇧[": "rippleStart", "⌘⇧]": "rippleEnd",
  Backspace: "delete", Delete: "rippleDelete", "⇧Backspace": "rippleDelete", D: "enable",
  I: "markIn", O: "markOut", "⌥X": "clearMarks", "⌥I": "clearIn", "⌥O": "clearOut",
  A: "toolSelect", T: "toolTrim", B: "toolBlade", N: "snap", "⌘⇧L": "linkedSelection",
  ",": "nudgeBack", "⇧,": "nudgeBack5", ".": "nudgeOn", "⇧.": "nudgeOn5",
  ArrowLeft: "frameBack", ArrowRight: "frameOn", "⇧ArrowLeft": "secondBack", "⇧ArrowRight": "secondOn",
  ArrowUp: "prevEdit", ArrowDown: "nextEdit", Home: "start", End: "end",
  "⌘=": "zoomIn", "⌘+": "zoomIn", "⌘-": "zoomOut", "⇧Z": "zoomFit",
  F9: "insertEdit", F10: "overwriteEdit", "⌘/": "loop",
  M: "addMarker", "⇧ArrowUp": "prevMarker", "⇧ArrowDown": "nextMarker", "⌘T": "addDissolve", "⌘⌥K": "keyboard",
};

export type KeyPreset = "default" | "resolve";
export const PRESETS: Record<KeyPreset, Record<string, string>> = { default: KEYS, resolve: RESOLVE_KEYS };
/** The person's own changes: chord → command id ("lock:V3" for a track's lock), "" = the chord does nothing. */
export type KeyOverrides = Record<string, string>;

/** The keys in force: the preset with the person's changes over it. */
export function keymap(preset: KeyPreset = "default", over: KeyOverrides = {}): Record<string, string> {
  const m = { ...(PRESETS[preset] ?? KEYS) };
  for (const [c, id] of Object.entries(over)) if (id) m[c] = id; else delete m[c];
  return m;
}

/** The changes after `chord` is given to `id` (what had it loses it), or (id "") taken off. */
export function bind(preset: KeyPreset, over: KeyOverrides, chord: string, id: string): KeyOverrides {
  const base = PRESETS[preset] ?? KEYS;
  const next = { ...over };
  if ((base[chord] ?? "") === id) delete next[chord];
  else next[chord] = id;
  return next;
}

/** The other command `chord` runs now, or null when it is free or already `id`'s. */
export const conflict = (map: Record<string, string>, chord: string, id: string): string | null =>
  map[chord] && map[chord] !== id ? map[chord] : null;

/** Every chord that runs `id`, in the table's order. */
export const chordsOf = (map: Record<string, string>, id: string): string[] => Object.keys(map).filter((c) => map[c] === id);

const NAMES: Record<string, string> = {
  Backspace: "⌫", Delete: "⌦", Escape: "Esc", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Tab: "⇥", Home: "↖", End: "↘",
};
/** A chord as a Mac menu writes it: ⌥ ⇧ ⌘ before the key (⇧⌘Z), arrows and ⌫ as signs. */
export function chordLabel(chord: string): string {
  const m = /^(⌘?)(⌥?)(⇧?)(.+)$/.exec(chord);
  if (!m) return chord;
  return `${m[2]}${m[3]}${m[1]}${NAMES[m[4]] ?? m[4]}`;
}

export const keyAction = (e: KeyLike, map: Record<string, string> = KEYS): string | null => map[chordOf(e)] || null;

/** The command (commands.ts) a key's entry runs, with its params. */
export const commandOf = (a: string): { id: string; params: Record<string, number> } =>
  a.startsWith("lock:V") ? { id: "lock", params: { track: Number(a.slice(6)) } } : { id: a, params: {} };

/** What a key press runs with the keys in force (the preset and the person's changes); null when it runs nothing. */
export function commandOfKey(e: KeyLike, map: Record<string, string> = KEYS): { id: string; params: Record<string, number> } | null {
  const a = keyAction(e, map);
  return a ? commandOf(a) : null;
}
