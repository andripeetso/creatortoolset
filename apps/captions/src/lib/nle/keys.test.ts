import { describe, expect, it } from "vitest";
import { bind, chordLabel, chordOf, chordsOf, commandOfKey, conflict, keyAction, keymap, KEYS, RESOLVE_KEYS } from "./keys";

const k = (key: string, code: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) =>
  ({ key, code, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift });

describe("editor keys", () => {
  it("plain Y does nothing; ⌥Y forward, ⌥⌘Y backward (⌥ makes e.key ¥ on a Mac); ⌘Y nothing", () => {
    expect(keyAction(k("y", "KeyY"))).toBeNull();
    expect(keyAction(k("¥", "KeyY", { alt: true }))).toBe("selectForward");
    expect(keyAction(k("¥", "KeyY", { alt: true, meta: true }))).toBe("selectBack");
    expect(keyAction(k("y", "KeyY", { meta: true }))).toBeNull();
  });

  it("Q W E ripple start, split, ripple end; 1 2 3 and J K L play", () => {
    expect(["q", "w", "e"].map((c) => keyAction(k(c, `Key${c.toUpperCase()}`)))).toEqual(["rippleStart", "split", "rippleEnd"]);
    expect(["1", "2", "3"].map((d) => keyAction(k(d, `Digit${d}`)))).toEqual(["reverse", "play", "forward"]);
    expect(["c", "r"].map((c) => keyAction(k(c, `Key${c.toUpperCase()}`)))).toEqual(["split", "toolStretch"]);
    expect(keyAction(k(" ", "Space"))).toBe("play");
    expect(keyAction(k("k", "KeyK"))).toBe("stop");
  });

  it("S, forward Delete and ⇧Backspace ripple; Backspace leaves the gap", () => {
    expect(keyAction(k("s", "KeyS"))).toBe("rippleDelete");
    expect(keyAction(k("Delete", "Delete"))).toBe("rippleDelete");
    expect(keyAction(k("Backspace", "Backspace", { shift: true }))).toBe("rippleDelete");
    expect(keyAction(k("Backspace", "Backspace"))).toBe("delete");
  });

  it("⌥⇧1..9 lock V1..V9 though ⌥⇧1 types ⁄", () => {
    expect(chordOf(k("⁄", "Digit1", { alt: true, shift: true }))).toBe("⌥⇧1");
    expect(keyAction(k("⁄", "Digit1", { alt: true, shift: true }))).toBe("lock:V1");
    expect(keyAction(k("·", "Digit9", { alt: true, shift: true }))).toBe("lock:V9");
    expect(keyAction(k("!", "Digit1", { shift: true }))).toBeNull();
  });

  it("zoom, panels, nudge, Ctrl as ⌘", () => {
    expect(keyAction(k("=", "Equal", { meta: true }))).toBe("zoomIn");
    expect(keyAction(k("-", "Minus", { meta: true }))).toBe("zoomOut");
    expect(keyAction(k("Z", "KeyZ", { shift: true }))).toBe("zoomFit");
    expect(keyAction(k("Tab", "Tab"))).toBe("mediaPool");
    expect(keyAction(k("Tab", "Tab", { shift: true }))).toBe("inspector");
    expect(keyAction(k("<", "Comma", { shift: true }))).toBe("nudgeBack5");
    expect(keyAction(k("z", "KeyZ", { ctrl: true, shift: true }))).toBe("redo");
    expect(keyAction(k("b", "KeyB", { meta: true }))).toBe("split");
    expect(keyAction(k("b", "KeyB"))).toBe("toolBlade");
  });
});

describe("source viewer and loop keys", () => {
  it("⌥I / ⌥O clear In / Out though ⌥ types another letter; F9 insert, F10 overwrite; ⌘/ loop", () => {
    expect(keyAction(k("ˆ", "KeyI", { alt: true }))).toBe("clearIn");
    expect(keyAction(k("ø", "KeyO", { alt: true }))).toBe("clearOut");
    expect(keyAction(k("F9", "F9"))).toBe("insertEdit");
    expect(keyAction(k("F10", "F10"))).toBe("overwriteEdit");
    expect(keyAction(k("/", "Slash", { meta: true }))).toBe("loop");
    expect(keyAction(k("/", "Slash"))).toBeNull();
  });

  it("M marker, ⇧↑ ⇧↓ previous and next marker, ⌘T cross dissolve", () => {
    expect(keyAction(k("m", "KeyM"))).toBe("addMarker");
    expect(keyAction(k("ArrowUp", "ArrowUp", { shift: true }))).toBe("prevMarker");
    expect(keyAction(k("ArrowDown", "ArrowDown", { shift: true }))).toBe("nextMarker");
    expect(keyAction(k("t", "KeyT", { meta: true }))).toBe("addDissolve");
  });

  it("the person's changes change what a key runs: a chord given to another command, one taken off, one added", () => {
    const map = keymap("default", { X: "cut", W: "", "⌥⇧K": "lock:V3" });
    expect(commandOfKey(k("x", "KeyX"), map)).toEqual({ id: "cut", params: {} });
    expect(commandOfKey(k("x", "KeyX"))).toBeNull();
    expect(commandOfKey(k("w", "KeyW"), map)).toBeNull();
    expect(commandOfKey(k("w", "KeyW"))).toEqual({ id: "split", params: {} });
    expect(commandOfKey(k("˚", "KeyK", { alt: true, shift: true }), map)).toEqual({ id: "lock", params: { track: 3 } });
    expect(commandOfKey(k("b", "KeyB", { meta: true }), map)).toEqual({ id: "split", params: {} });
  });

  it("bind keeps only what differs from the preset; a taken chord is a conflict naming the other command", () => {
    expect(bind("default", {}, "X", "cut")).toEqual({ X: "cut" });
    expect(bind("default", { X: "cut" }, "X", "")).toEqual({});
    expect(bind("default", {}, "W", "")).toEqual({ W: "" });
    expect(bind("default", { W: "" }, "W", "split")).toEqual({});
    const map = keymap("default", {});
    expect(conflict(map, "⌘T", "cut")).toBe("addDissolve");
    expect(conflict(map, "⌘T", "addDissolve")).toBeNull();
    expect(conflict(map, "X", "cut")).toBeNull();
    expect(chordsOf(keymap("default", bind("default", {}, "⌘T", "cut")), "addDissolve")).toEqual([]);
  });

  it("the DaVinci Resolve preset: Resolve's own keys, none of the owner's", () => {
    const r = keymap("resolve");
    for (const c of ["Q", "W", "E", "S", "1", "2", "3", "Tab", "⇧Tab", "⌥⇧1"]) expect(r[c], c).toBeUndefined();
    expect(keyAction(k("{", "BracketLeft", { meta: true, shift: true }), r)).toBe("rippleStart");
    expect(keyAction(k("}", "BracketRight", { meta: true, shift: true }), r)).toBe("rippleEnd");
    expect(keyAction(k("a", "KeyA", { meta: true, shift: true }), r)).toBe("deselect");
    expect(keyAction(k("Delete", "Delete"), r)).toBe("rippleDelete");
    expect(keyAction(k("Backspace", "Backspace"), r)).toBe("delete");
    expect(chordsOf(r, "split")).toEqual(["⌘B", "⌘\\"]);
    // what both share is the same, and ⌘⌥K opens Keyboard Customization in both
    for (const c of ["⌘Z", "⌥Y", "⌘⌥Y", "I", "O", "M", "⌘T", "F9", "⇧Z", "⌘⌥K"]) expect(RESOLVE_KEYS[c], c).toBe(KEYS[c]);
    expect(keyAction(k("˚", "KeyK", { meta: true, alt: true }))).toBe("keyboard");
  });

  it("labels a chord as a Mac menu does", () => {
    expect(["⌘⇧Z", "⌘⌥K", "Backspace", "⇧ArrowUp", "⌥⇧3", "S", "⌘X"].map(chordLabel)).toEqual(["⇧⌘Z", "⌥⌘K", "⌫", "⇧↑", "⌥⇧3", "S", "⌘X"]);
  });
});
