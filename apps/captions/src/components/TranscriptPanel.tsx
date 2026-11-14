import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  FileText,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  ScrollText,
  TriangleAlert,
  X,
} from "lucide-react";
import { isEditorBusy, narrowerThanMatched, playerRef, useStudio } from "@/lib/store";
import { aiStatus, type AiStatus } from "@/lib/refine";
import { MODELS, CLOUD_MODEL_ID, cloudLabel } from "@/lib/transcribe";
import { tokenize } from "@/lib/align";
import type { Cue } from "@/lib/types";
import { ScriptDialog } from "./ScriptDialog";

/** No script fixes to show (stable, so the document isn't rebuilt). */
const NO_FIXES = new Map<number, string>();

const COMMIT_DELAY = 600;

/**
 * Descript-style transcript editor with two modes:
 *
 * - "words" (default): a normal text cursor — but each word's letters
 *   behave like a single character. The cursor can sit around words,
 *   inside punctuation, in spaces; it can never land inside a word.
 *   Typing punctuation works normally, typing letters is swallowed,
 *   Space plays/pauses from the caret's word, ⌘/Ctrl+Backspace removes
 *   the adjacent word (plain Backspace never eats words), Enter breaks
 *   the caption, and C (or double-click) re-spells the word — with a
 *   multi-word selection C first merges the words into one.
 * - "text" (pencil toggle): completely free letter-level editing.
 *
 * Both modes share one pipeline: the DOM is the live editing surface,
 * and after a pause (or on blur) it's parsed into token lines, aligned
 * against the timed words, and rebuilt. React never renders the
 * document itself, so playback highlighting can't fight the browser.
 */

type Mode = "words" | "text";

/**
 * `fixed`: word id → tooltip for words the script check (or apply-master)
 * fixed: underlined, the tooltip says what the engine heard.
 */
function buildDoc(
  root: HTMLElement,
  cues: Cue[],
  fixed: Map<number, string> = NO_FIXES,
) {
  const frag = document.createDocumentFragment();
  if (cues.length === 0) {
    const div = document.createElement("div");
    div.className = "cue-line";
    div.appendChild(document.createElement("br"));
    frag.appendChild(div);
  }
  cues.forEach((c, li) => {
    const div = document.createElement("div");
    div.className = "cue-line";
    div.dataset.start = String(c.start);
    div.dataset.end = String(c.end);
    // the caption's on-screen line breaks, drawn by CSS after the word
    // that ends each line (no DOM change, so editing reads it as before)
    const lineEnds = new Set<number>();
    if (c.lines && c.lines.reduce((a, n) => a + n, 0) === c.words.length) {
      let at = 0;
      for (const n of c.lines.slice(0, -1)) lineEnds.add((at += n) - 1);
    }
    c.words.forEach((w, wi) => {
      const s = document.createElement("span");
      s.className = lineEnds.has(wi) ? "cue-word line-end" : "cue-word";
      const title = fixed.get(w.id);
      if (title !== undefined) {
        s.classList.add("script-fixed");
        s.title = title;
      }
      s.dataset.ws = String(w.start);
      s.dataset.we = String(w.end);
      s.dataset.li = String(li);
      s.dataset.wi = String(wi);
      s.textContent = w.text;
      div.appendChild(s);
      div.appendChild(document.createTextNode(" "));
    });
    frag.appendChild(div);
  });
  root.replaceChildren(frag);
}

/**
 * The "core" of a token: the run from its first to last letter/digit.
 * The caret may sit at the core's edges but never inside it. A pure
 * punctuation token has an empty core and is fully editable.
 */
function coreRange(text: string): { cs: number; ce: number } {
  let cs = -1;
  let ce = 0;
  for (let i = 0; i < text.length; i++) {
    if (/[\p{L}\p{N}]/u.test(text[i])) {
      if (cs < 0) cs = i;
      ce = i + 1;
    }
  }
  return cs < 0 ? { cs: 0, ce: 0 } : { cs, ce };
}

/** The character adjacent to the caret within its line (crossing nodes). */
function adjacentChar(
  container: Node,
  offset: number,
  dir: -1 | 1,
): { node: Text; index: number; ch: string } | null {
  const holder =
    container instanceof HTMLElement ? container : container.parentElement;
  const line = holder?.closest(".cue-line");
  if (!line) return null;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  let n: Text | null;
  while ((n = walker.nextNode() as Text | null)) texts.push(n);
  if (!texts.length) return null;

  let flat = 0;
  if (container.nodeType === Node.TEXT_NODE) {
    const idx = texts.indexOf(container as Text);
    if (idx < 0) return null;
    for (let i = 0; i < idx; i++) flat += texts[i].data.length;
    flat += offset;
  } else {
    // element-boundary caret: resolve to the child position
    const before = Array.from(container.childNodes).slice(0, offset);
    for (const k of before) flat += (k.textContent ?? "").length;
  }
  const target = dir < 0 ? flat - 1 : flat;
  if (target < 0) return null;
  let acc = 0;
  for (const t of texts) {
    if (target < acc + t.data.length) {
      return { node: t, index: target - acc, ch: t.data[target - acc] };
    }
    acc += t.data.length;
  }
  return null;
}

/**
 * Caret position as (line index, char offset within the line). A flat
 * document offset can't distinguish "end of line N" from "start of line
 * N+1" (Range.toString() has no newlines), which matters right after
 * Enter splits a line — so the line index is tracked explicitly.
 */
function caretLinePos(root: HTMLElement): { li: number; off: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.endContainer)) return null;
  if (r.endContainer === root) {
    return {
      li: Math.max(0, Math.min(r.endOffset, root.children.length - 1)),
      off: 0,
    };
  }
  let node: Node | null = r.endContainer;
  while (node && node.parentNode !== root) node = node.parentNode;
  if (!node) return null;
  const li = Array.prototype.indexOf.call(root.children, node);
  if (li < 0) return null;
  const probe = document.createRange();
  probe.selectNodeContents(node);
  probe.setEnd(r.endContainer, r.endOffset);
  return { li, off: probe.toString().length };
}

function restoreCaretLinePos(
  root: HTMLElement,
  pos: { li: number; off: number },
) {
  if (!root.children.length) return;
  const line = root.children[Math.min(pos.li, root.children.length - 1)];
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  let remaining = pos.off;
  let last: Text | null = null;
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    last = node;
    if (remaining <= node.data.length) {
      range.setStart(node, Math.max(0, remaining));
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    remaining -= node.data.length;
  }
  if (last) range.setStart(last, last.data.length);
  else range.selectNodeContents(line);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * The line block containing the (collapsed) caret, plus whether the
 * caret sits at the block's visible start/end.
 */
function caretBlock(
  root: HTMLElement,
): { block: HTMLElement; atStart: boolean; atEnd: boolean } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.getRangeAt(0).collapsed) return null;
  const r = sel.getRangeAt(0);
  let node: Node | null = r.startContainer;
  if (!root.contains(node) || node === root) return null;
  while (node && node.parentNode !== root) node = node.parentNode;
  if (!(node instanceof HTMLElement)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(node);
  pre.setEnd(r.startContainer, r.startOffset);
  const post = document.createRange();
  post.selectNodeContents(node);
  post.setStart(r.startContainer, r.startOffset);
  return {
    block: node,
    atStart: pre.toString().trim() === "",
    atEnd: post.toString().trim() === "",
  };
}

/**
 * Merge two line blocks, keeping a space between the joined words —
 * Chrome's native block merge strips the invisible trailing space and
 * glues words together ("a" + "test" → "atest"), so we do it ourselves.
 */
function mergeBlocks(first: HTMLElement, second: HTMLElement) {
  const sel = window.getSelection();
  const range = document.createRange();
  if ((second.textContent ?? "").trim() === "") {
    second.remove();
    range.selectNodeContents(first);
    range.collapse(false);
  } else {
    if (first.textContent && !/\s$/.test(first.textContent)) {
      first.appendChild(document.createTextNode(" "));
    }
    const joinNode = second.firstChild!;
    while (second.firstChild) first.appendChild(second.firstChild);
    second.remove();
    range.selectNodeContents(joinNode);
    range.collapse(true);
  }
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** Parse the (possibly user-mangled) DOM back into token lines. */
function readLineTokens(root: HTMLElement): {
  lines: string[][];
  hasEmpty: boolean;
} {
  const lines: string[][] = [];
  let hasEmpty = false;
  let pendingText = "";
  const flushText = () => {
    const toks = tokenize(pendingText);
    if (toks.length) lines.push(toks);
    pendingText = "";
  };
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      pendingText += node.textContent ?? "";
    } else if (node instanceof HTMLElement) {
      flushText();
      const toks = tokenize(node.textContent ?? "");
      if (toks.length) lines.push(toks);
      else hasEmpty = true;
    }
  }
  flushText();
  return { lines, hasEmpty };
}

export function TranscriptPanel() {
  const status = useStudio((s) => s.status);
  const cues = useStudio((s) => s.cues);
  const model = useStudio((s) => s.model);
  const clipName = useStudio(
    (s) => s.clips.find((c) => c.id === s.activeClipId)?.name ?? "",
  );
  const [confirmRe, setConfirmRe] = useState(false);
  const engineLabel =
    model === CLOUD_MODEL_ID
      ? cloudLabel()
      : (MODELS.find((m) => m.id === model)?.label ?? model);
  const transcribing =
    status.phase === "extracting" ||
    status.phase === "loading" ||
    status.phase === "transcribing" ||
    status.phase === "checking" ||
    status.phase === "matching";
  const editorRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composingRef = useRef(false);
  const domDirtyRef = useRef(false);
  const arrowDirRef = useRef<-1 | 0 | 1>(0);
  const targetRef = useRef<{ li: number; wi: number } | null>(null);
  const lastSeekKeyRef = useRef("");

  const [mode, setMode] = useState<Mode>("words");
  const [menuOpen, setMenuOpen] = useState(false);
  const [correcting, setCorrecting] = useState<{
    li: number;
    wi: number;
    /** How many words the correction replaces (C on a selection = the run). */
    count?: number;
    /** Joined run text for multi-word corrections. */
    prefill?: string;
  } | null>(null);
  const [chip, setChip] = useState<{ top: number; left: number } | null>(null);

  // AI cadence pass (hidden when the server has no AI key; guests can't run it)
  const editorBusy = useStudio(isEditorBusy);
  const serverCaptioning = useStudio((s) => s.serverCaptioning);
  const refineError = useStudio((s) => s.refineError);
  const refineCues = useStudio((s) => s.refineCues);
  const cadenceApplied = useStudio((s) => s.cadenceApplied);
  // transcript edited after the pass — offer a re-match (a box or font
  // change re-lays out the matched thoughts on its own)
  const dirty = useStudio((s) => s.cadenceDirty);
  // …or the box got narrower than the match planned its breaks for
  const narrower = useStudio(narrowerThanMatched);
  const fitSplits = useStudio((s) => s.fitSplits);
  const fittingSplits = useStudio((s) => s.fittingSplits);
  const [ai, setAi] = useState<AiStatus | null>(null);
  useEffect(() => {
    aiStatus().then(setAi);
  }, []);

  // script check: the dialog, and the last check's fixes still in the text
  const [scriptOpen, setScriptOpen] = useState(false);
  const hasScript = useStudio((s) => s.script.trim().length > 0);
  const scriptCheckError = useStudio((s) => s.scriptCheckError);
  const allFixes = useStudio((s) =>
    s.activeClipId ? s.scriptFixes[s.activeClipId] : undefined,
  );
  const liveFixes = useMemo(() => {
    if (!allFixes) return null;
    const ids = new Set(cues.flatMap((c) => c.words.map((w) => w.id)));
    return allFixes.filter((f) => f.ids.some((id) => ids.has(id)));
  }, [allFixes, cues]);
  const fixedWords = useMemo(() => {
    if (!liveFixes?.length) return NO_FIXES;
    return new Map(
      liveFixes.flatMap((f) => {
        const title = `Fixed from ${f.from === "master" ? "the master clip" : "your script"} — heard “${f.before}”`;
        return f.ids.map((id) => [id, title] as const);
      }),
    );
  }, [liveFixes]);
  // commits run from timers set in earlier renders
  const fixedWordsRef = useRef(fixedWords);
  useEffect(() => {
    fixedWordsRef.current = fixedWords;
  });

  const isFocused = () => {
    const el = editorRef.current;
    return (
      !!el &&
      (document.activeElement === el || el.contains(document.activeElement))
    );
  };

  // ---- shared commit pipeline -------------------------------------------

  const schedule = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => commit(false), COMMIT_DELAY);
  };

  const commit = (dropEmpty: boolean) => {
    const el = editorRef.current;
    if (!el) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (composingRef.current) {
      schedule();
      return;
    }
    const { lines, hasEmpty } = readLineTokens(el);
    // an empty line under the caret means the user just pressed Enter and
    // hasn't typed yet — don't yank it away mid-edit
    if (hasEmpty && !dropEmpty) {
      schedule();
      return;
    }
    domDirtyRef.current = false;
    const changed = useStudio.getState().applyTranscript(lines);
    // the [cues] effect rebuilds on change; normalize whitespace on blur
    if (!changed && !isFocused()) {
      buildDoc(el, useStudio.getState().cues, fixedWordsRef.current);
    }
  };

  // Rebuild whenever the captions change, unless the user has uncommitted
  // typing in the DOM. Keeps the caret (by text offset) when focused.
  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (isFocused() && domDirtyRef.current) return;
    const pos = isFocused() ? caretLinePos(el) : null;
    buildDoc(el, cues, fixedWords);
    if (pos) restoreCaretLinePos(el, pos);
  }, [cues, mode, fixedWords]);

  // ---- word-mode: caret snapping + word targeting -----------------------

  // Keep the caret out of word cores; highlight (subtly) the word the
  // caret is touching, and follow it with the playhead.
  useEffect(() => {
    if (mode !== "words") return;
    const onSelChange = () => {
      const el = editorRef.current;
      if (!el) return;
      const s = window.getSelection();
      if (!s || s.rangeCount === 0) return;
      const r = s.getRangeAt(0);
      if (!el.contains(r.startContainer)) return;
      if (!r.collapsed) return; // drag selections stay free

      const node = r.startContainer;
      if (node.nodeType === Node.TEXT_NODE) {
        const { cs, ce } = coreRange((node as Text).data);
        const off = r.startOffset;
        if (ce > cs && off > cs && off < ce) {
          // inside a word core → push out in the direction of travel
          const dir = arrowDirRef.current;
          const snapped =
            dir < 0 ? cs : dir > 0 ? ce : off - cs <= ce - off ? cs : ce;
          const nr = document.createRange();
          nr.setStart(node, snapped);
          nr.collapse(true);
          s.removeAllRanges();
          s.addRange(nr);
          return; // re-fires on the snapped position
        }
      }

      // word the caret is touching (for C-correction + subtle highlight)
      const before = adjacentChar(node, r.startOffset, -1);
      const after = adjacentChar(node, r.startOffset, 1);
      const pick =
        (before && /[\p{L}\p{N}]/u.test(before.ch) && before) ||
        (after && /[\p{L}\p{N}]/u.test(after.ch) && after) ||
        before ||
        after;
      const span = pick?.node.parentElement?.closest(
        "span[data-wi]",
      ) as HTMLElement | null;
      el.querySelectorAll(".word-selected").forEach((x) =>
        x.classList.remove("word-selected"),
      );
      if (span && el.contains(span)) {
        span.classList.add("word-selected");
        targetRef.current = {
          li: Number(span.dataset.li),
          wi: Number(span.dataset.wi),
        };
        const key = `${span.dataset.li}:${span.dataset.wi}`;
        if (key !== lastSeekKeyRef.current) {
          lastSeekKeyRef.current = key;
          followRef.current = true; // a word click is a seek — track from there
          useStudio.getState().seek(Number(span.dataset.ws) + 0.001);
        }
      } else {
        targetRef.current = null;
      }
    };
    const editorEl = editorRef.current;
    document.addEventListener("selectionchange", onSelChange);
    return () => {
      document.removeEventListener("selectionchange", onSelChange);
      editorEl
        ?.querySelectorAll(".word-selected")
        .forEach((x) => x.classList.remove("word-selected"));
    };
  }, [mode]);

  // Letters may not be typed in word mode — spaces & punctuation may.
  useEffect(() => {
    const el = editorRef.current;
    if (!el || mode !== "words") return;
    const onBeforeInput = (e: InputEvent) => {
      if (
        e.inputType === "insertText" &&
        e.data &&
        /[\p{L}\p{N}]/u.test(e.data)
      ) {
        e.preventDefault();
      }
    };
    el.addEventListener("beforeinput", onBeforeInput);
    return () => el.removeEventListener("beforeinput", onBeforeInput);
  }, [mode]);

  // ---- correction popover ------------------------------------------------

  const openCorrect = (opts?: {
    li: number;
    wi: number;
    count?: number;
    prefill?: string;
  }) => {
    const el = editorRef.current;
    const wrap = wrapRef.current;
    const t = opts ?? targetRef.current;
    if (!el || !wrap || !t) return;
    const span = el.querySelector<HTMLElement>(
      `span[data-li="${t.li}"][data-wi="${t.wi}"]`,
    );
    if (!span) return;
    const sr = span.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const top = sr.top - wr.top - 30;
    setChip({
      top: top < 4 ? sr.bottom - wr.top + 4 : top,
      left: Math.max(4, Math.min(sr.left - wr.left, wr.width - 150)),
    });
    setCorrecting({
      li: t.li,
      wi: t.wi,
      count: opts?.count ?? 1,
      prefill: opts?.prefill,
    });
  };

  const applyCorrection = (text: string) => {
    const t = correcting;
    setCorrecting(null);
    if (!t) return;
    commit(true); // flush pending DOM edits first
    const lines = useStudio
      .getState()
      .cues.map((c) => c.words.map((w) => w.text));
    if (!lines[t.li]) return;
    const wi = Math.min(t.wi, lines[t.li].length - 1);
    lines[t.li].splice(wi, t.count ?? 1, ...tokenize(text));
    useStudio.getState().applyTranscript(lines);
    setTimeout(() => {
      const el = editorRef.current;
      const span = el?.querySelector<HTMLElement>(
        `span[data-li="${t.li}"][data-wi="${wi}"]`,
      );
      const tn = span?.firstChild as Text | null;
      if (el && tn) {
        el.focus();
        const r = document.createRange();
        r.setStart(tn, coreRange(tn.data).ce);
        r.collapse(true);
        const s = window.getSelection();
        s?.removeAllRanges();
        s?.addRange(r);
      }
    }, 0);
  };

  const stripPunct = (kind: "commas" | "periods") => {
    const lines = useStudio
      .getState()
      .cues.map((c) =>
        c.words
          .map((w) =>
            kind === "commas"
              ? w.text.replace(/,/g, "")
              : w.text.replace(/\.+$/g, ""),
          )
          .filter(Boolean),
      );
    useStudio.getState().applyTranscript(lines);
  };

  const toggleMode = () => {
    if (mode === "text") {
      commit(true);
      setMode("words");
    } else {
      setCorrecting(null);
      setMode("text");
    }
  };

  // Karaoke highlight + follow-scroll, applied imperatively so playback
  // never re-renders (or disturbs) the document.
  //
  // Follow rules:
  // - playing + follow on → the active cue line smooth-scrolls to the
  //   transcript's vertical center whenever it changes
  // - any wheel/touch scroll in the panel → follow off (never fights)
  // - pressing play after a pause, or clicking a word (a seek) → follow
  //   back on
  // - uncommitted typing in the DOM → no auto-scroll until it settles
  const followRef = useRef(true);
  useEffect(() => {
    let lastT = -1;
    let wasPlaying = false;
    let lastActive: HTMLElement | null = null;
    const apply = () => {
      const st = useStudio.getState();
      if (st.playing && !wasPlaying) followRef.current = true; // play resumes follow
      wasPlaying = st.playing;
      if (st.currentTime === lastT) return;
      lastT = st.currentTime;
      const el = editorRef.current;
      if (!el) return;
      const t = st.currentTime;
      let active: HTMLElement | null = null;
      for (const line of Array.from(el.children) as HTMLElement[]) {
        const cs = Number(line.dataset.start);
        const ce = Number(line.dataset.end);
        const on = Number.isFinite(cs) && t >= cs && t < ce;
        if (on) active = line;
        const was = line.classList.contains("cue-line-active");
        if (on !== was) line.classList.toggle("cue-line-active", on);
        if (on || was) {
          for (const s of Array.from(
            line.querySelectorAll<HTMLElement>("span[data-ws]"),
          )) {
            const won =
              on &&
              t >= Number(s.dataset.ws) &&
              t < Number(s.dataset.we) + 0.06;
            if (won !== s.classList.contains("word-active")) {
              s.classList.toggle("word-active", won);
            }
          }
        }
      }
      if (active && active !== lastActive) {
        lastActive = active;
        if (st.playing && followRef.current && !domDirtyRef.current) {
          // center the line inside the panel (not scrollIntoView, which
          // would drag ancestor scroll containers along)
          el.scrollTo({
            top:
              active.offsetTop - el.clientHeight / 2 + active.clientHeight / 2,
            behavior: "smooth",
          });
        }
      }
    };
    const unsub = useStudio.subscribe(apply);
    apply();
    return unsub;
  }, []);

  // user scrolling disengages follow; it re-engages on play or word click
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const off = () => {
      followRef.current = false;
    };
    el.addEventListener("wheel", off, { passive: true });
    el.addEventListener("touchmove", off, { passive: true });
    return () => {
      el.removeEventListener("wheel", off);
      el.removeEventListener("touchmove", off);
    };
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  // ---- key handling ------------------------------------------------------

  /** Delete the whole word core adjacent to the caret; false if none. */
  const deleteAdjacentCore = (dir: -1 | 1): boolean => {
    const s = window.getSelection();
    if (!s || s.rangeCount === 0 || !s.getRangeAt(0).collapsed) return false;
    const r = s.getRangeAt(0);
    const info = adjacentChar(r.startContainer, r.startOffset, dir);
    if (!info || !/[\p{L}\p{N}]/u.test(info.ch)) return false;
    const { cs, ce } = coreRange(info.node.data);
    if (!(info.index >= cs && info.index < ce)) return false;
    const del = document.createRange();
    del.setStart(info.node, cs);
    del.setEnd(info.node, ce);
    del.deleteContents();
    const nr = document.createRange();
    nr.setStart(info.node, Math.min(cs, info.node.data.length));
    nr.collapse(true);
    s.removeAllRanges();
    s.addRange(nr);
    domDirtyRef.current = true;
    schedule();
    return true;
  };

  const handleUndoKeys = (e: React.KeyboardEvent): boolean => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.stopPropagation();
      commit(true); // flush pending keystrokes as their own undo step
      const st = useStudio.getState();
      if (e.shiftKey) st.redoEdit();
      else st.undoEdit();
      return true;
    }
    return false;
  };

  const handleLineMergeKeys = (e: React.KeyboardEvent): boolean => {
    const el = editorRef.current!;
    if (e.key === "Backspace") {
      const info = caretBlock(el);
      const prev = info?.block.previousElementSibling;
      if (info?.atStart && prev instanceof HTMLElement) {
        e.preventDefault();
        mergeBlocks(prev, info.block);
        domDirtyRef.current = true;
        schedule();
        return true;
      }
    } else if (e.key === "Delete") {
      const info = caretBlock(el);
      const next = info?.block.nextElementSibling;
      if (info?.atEnd && next instanceof HTMLElement) {
        e.preventDefault();
        mergeBlocks(info.block, next);
        domDirtyRef.current = true;
        schedule();
        return true;
      }
    }
    return false;
  };

  /**
   * C with a range selection spanning ≥2 words: open the re-spell
   * popover over the run, pre-filled with the joined text — confirming
   * replaces the whole run (split-word mistranscriptions become one
   * word). The cues stay untouched until then: a joined token written
   * straight into the cues would be re-split by the next DOM commit,
   * since transcript words are whitespace-free by design.
   */
  const mergeSelectionIntoWord = (): boolean => {
    const el = editorRef.current;
    const s = window.getSelection();
    if (!el || !s || s.rangeCount === 0) return false;
    const r = s.getRangeAt(0);
    if (r.collapsed) return false;
    const spans = Array.from(
      el.querySelectorAll<HTMLElement>("span[data-wi]"),
    ).filter((sp) => {
      try {
        return r.intersectsNode(sp);
      } catch {
        return false;
      }
    });
    if (spans.length < 2) return false;
    const li = Number(spans[0].dataset.li);
    const wi = Number(spans[0].dataset.wi);
    // the popover splices the run within this one caption line; a
    // selection across lines just covers the first line's run
    const run = spans.filter((sp) => Number(sp.dataset.li) === li);
    if (run.length < 2) return false;
    const prefill = run
      .map((sp) => sp.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    // pass the target explicitly — removeAllRanges fires a
    // selectionchange that rewrites targetRef before the timeout runs
    s.removeAllRanges();
    setTimeout(() => openCorrect({ li, wi, count: run.length, prefill }), 0);
    return true;
  };

  /** True when the char adjacent to the caret is part of a word core. */
  const nearWordCore = (dir: -1 | 1): boolean => {
    const s = window.getSelection();
    if (!s || s.rangeCount === 0 || !s.getRangeAt(0).collapsed) return false;
    const r = s.getRangeAt(0);
    const info = adjacentChar(r.startContainer, r.startOffset, dir);
    if (!info || !/[\p{L}\p{N}]/u.test(info.ch)) return false;
    const { cs, ce } = coreRange(info.node.data);
    return info.index >= cs && info.index < ce;
  };

  const onWordsKeyDown = (e: React.KeyboardEvent) => {
    if (editorBusy) {
      e.preventDefault();
      return;
    }
    if (handleUndoKeys(e)) return;
    arrowDirRef.current =
      e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    // word removal always needs the modifier — plain Backspace/Delete
    // next to a word never eats it (too easy to hit while navigating)
    if (
      (e.metaKey || e.ctrlKey) &&
      e.key === "Backspace" &&
      deleteAdjacentCore(-1)
    ) {
      e.preventDefault();
      return;
    }
    if (
      (e.metaKey || e.ctrlKey) &&
      e.key === "Delete" &&
      deleteAdjacentCore(1)
    ) {
      e.preventDefault();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "Space") {
      // words are atomic here, so Space is free to mean play/pause —
      // clicking a word already seeked, so playback starts from it
      e.preventDefault();
      const v = playerRef.video;
      if (v) {
        if (v.paused) v.play();
        else v.pause();
      }
      return;
    }
    if (e.key === "Escape") {
      setCorrecting(null);
      (e.target as HTMLElement).blur();
      return;
    }
    if (e.key === "c" || e.key === "C") {
      e.preventDefault();
      e.stopPropagation();
      // a range selection merges its words first; a bare caret corrects
      // the word it touches
      if (!mergeSelectionIntoWord() && targetRef.current) openCorrect();
      return;
    }
    if (handleLineMergeKeys(e)) return;
    // plain Backspace/Delete never eats letters: swallowed next to word
    // cores, native everywhere else (spaces, punctuation, line merges)
    if (e.key === "Backspace" && nearWordCore(-1)) {
      e.preventDefault();
      return;
    }
    if (e.key === "Delete" && nearWordCore(1)) {
      e.preventDefault();
      return;
    }
    // everything else (arrows, Enter, punctuation) is native;
    // the snapper and the beforeinput letter-filter keep words atomic
  };

  const onTextKeyDown = (e: React.KeyboardEvent) => {
    if (handleUndoKeys(e)) return;
    if (handleLineMergeKeys(e)) return;
    if (e.key === "Escape") (e.target as HTMLElement).blur();
  };

  const empty = cues.length === 0;
  const isText = mode === "text";

  return (
    <div className="flex h-full flex-col border-r border-zinc-800 bg-zinc-925">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-zinc-400">
        <FileText className="h-3.5 w-3.5" /> Transcript
      </div>

      {/* toolbar */}
      <div className="flex items-center gap-1.5 border-b border-zinc-800 px-3 py-1.5">
        <button
          onClick={toggleMode}
          disabled={empty || editorBusy}
          title={
            editorBusy
              ? "Editing is paused while captions are processing"
              : isText
                ? "Done — words become atomic again"
                : "Edit words letter by letter"
          }
          className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] disabled:opacity-40 ${
            isText
              ? "border-violet-500/60 bg-violet-500/15 text-violet-300"
              : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          }`}
        >
          {isText ? (
            <Check className="h-3 w-3" />
          ) : (
            <Pencil className="h-3 w-3" />
          )}
          {isText ? "Done" : "Edit text"}
        </button>
        {ai?.available && (
          <button
            onClick={() =>
              // a narrower box only needs its long lines re-split; the
              // matched thoughts stay
              cadenceApplied && !dirty && narrower ? fitSplits() : refineCues()
            }
            disabled={empty || editorBusy || !ai.allowed || fittingSplits}
            title={
              !ai.allowed
                ? "The AI caption pass is locked for your account"
                : dirty
                  ? "The transcript changed since the cadence pass — re-group the captions to the speech rhythm"
                  : cadenceApplied && narrower
                    ? "Some lines no longer fit where the cadence match planned its breaks — match again for this box width"
                    : cadenceApplied
                    ? "Cadence is matched — resizing the box re-lays out the same thoughts. Click to match again."
                    : "AI: group captions into the thoughts as they're spoken"
            }
            className={
              cadenceApplied && !dirty && !narrower && !editorBusy
                ? "flex items-center gap-1.5 rounded-md border border-violet-500/60 bg-violet-500/15 px-2 py-1 text-[11px] font-medium text-violet-300"
                : "flex items-center gap-1.5 rounded-md bg-violet-600 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-40 disabled:hover:bg-violet-600"
            }
          >
            {cadenceApplied && !dirty && !narrower && !editorBusy ? (
              <Check className="h-3 w-3" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            {dirty
              ? "Re-match cadence"
              : cadenceApplied && narrower
                ? "Re-match for this size"
              : cadenceApplied
                ? "Cadence matched"
                : "Match cadence"}
          </button>
        )}
        <div className="flex-1" />
        {/* secondary actions under one menu — the toolbar stays one row */}
        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            title="More transcript actions"
            className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] ${
              menuOpen
                ? "border-zinc-500 bg-zinc-800 text-zinc-200"
                : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            }`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-30"
                onClick={() => setMenuOpen(false)}
              />
              <div className="absolute right-0 top-full z-40 mt-1 w-44 overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 shadow-xl">
                {ai?.available && ai.allowed && (
                  <>
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        setScriptOpen(true);
                      }}
                      title="The script you filmed from: AI uses it to fix mis-heard words"
                      className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-zinc-300 hover:bg-zinc-800"
                    >
                      <ScrollText className="h-3 w-3 shrink-0" /> Original script…
                      {hasScript && (
                        <span
                          className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-400"
                          aria-label="added"
                        />
                      )}
                    </button>
                    <div className="my-1 border-t border-zinc-800" />
                  </>
                )}
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    stripPunct("commas");
                  }}
                  disabled={empty || editorBusy}
                  className="block w-full px-3 py-1.5 text-left text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                >
                  No commas
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    stripPunct("periods");
                  }}
                  disabled={empty || editorBusy}
                  className="block w-full px-3 py-1.5 text-left text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                >
                  No periods
                </button>
                <div className="my-1 border-t border-zinc-800" />
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    if (empty) {
                      void useStudio.getState().runTranscription();
                    } else {
                      setConfirmRe(true);
                    }
                  }}
                  disabled={transcribing || editorBusy || serverCaptioning}
                  title={`Discard this transcript and generate a fresh one for ${clipName || "this clip"} with ${engineLabel} — only this clip is affected`}
                  className="block w-full px-3 py-1.5 text-left text-[11px] text-amber-300 hover:bg-amber-500/10 disabled:opacity-40"
                >
                  {transcribing
                    ? "Transcribing…"
                    : empty
                      ? "Transcribe clip"
                      : "Re-transcribe clip…"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {confirmRe && (
        <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-300">
          <span className="flex-1">
            Replace <b>{clipName || "this clip"}</b>&apos;s transcript? The old
            captions are cleared first, then a fresh transcript is generated
            with {engineLabel}. Other clips are not touched.
          </span>
          <button
            onClick={() => {
              setConfirmRe(false);
              void useStudio.getState().runTranscription();
            }}
            className="shrink-0 rounded bg-amber-500/20 px-2 py-0.5 font-medium hover:bg-amber-500/30"
          >
            Replace
          </button>
          <button
            onClick={() => setConfirmRe(false)}
            className="shrink-0 rounded px-2 py-0.5 text-zinc-400 hover:bg-zinc-800"
          >
            Cancel
          </button>
        </div>
      )}
      {refineError && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-[12px] leading-5 text-red-300"
        >
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{refineError}</span>
        </div>
      )}
      {scriptCheckError && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-[12px] leading-5 text-red-300"
        >
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            Script check failed: {scriptCheckError}
          </span>
          <button
            onClick={() => useStudio.setState({ scriptCheckError: null })}
            title="Hide"
            className="rounded p-0.5 text-red-300/70 hover:bg-red-500/20 hover:text-red-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {allFixes && liveFixes && (liveFixes.length > 0 || allFixes.length === 0) && (
        <div
          role="status"
          className="flex items-start gap-2 border-b border-emerald-500/25 bg-emerald-500/10 px-4 py-2 text-[12px] leading-5 text-emerald-200"
        >
          <ScrollText className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0 flex-1">
            {liveFixes.length === 0 ? (
              "Checked against your script: no mis-heard words found."
            ) : (
              <>
                <p>
                  Fixed {liveFixes.length} mis-heard{" "}
                  {liveFixes.length === 1 ? "word" : "words"} from{" "}
                  {liveFixes.every((f) => f.from === "master")
                    ? "the master clip"
                    : liveFixes.some((f) => f.from === "master")
                      ? "your script and the master clip"
                      : "your script"}
                  . They&apos;re underlined below.
                </p>
                <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto pr-1 text-[11px]">
                  {liveFixes.map((f) => (
                    <li key={f.ids[0]}>
                      <button
                        onClick={() => {
                          const word = cues
                            .flatMap((c) => c.words)
                            .find((w) => w.id === f.ids[0]);
                          if (word) useStudio.getState().seek(word.start);
                        }}
                        title="Jump to it"
                        className="rounded px-1 text-left hover:bg-emerald-500/15"
                      >
                        <span className="text-zinc-400 line-through decoration-zinc-500">
                          {f.before}
                        </span>{" "}
                        → <span className="text-emerald-100">{f.after}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <button
            onClick={() => useStudio.getState().dismissScriptFixes()}
            title="Hide"
            className="rounded p-0.5 text-emerald-300/70 hover:bg-emerald-500/20 hover:text-emerald-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div ref={wrapRef} className="relative min-h-0 flex-1">
        <div
          ref={editorRef}
          contentEditable={!empty && !editorBusy}
          suppressContentEditableWarning
          spellCheck={false}
          className={`h-full overflow-y-auto px-4 py-4 text-[15px] text-zinc-200 caret-violet-400 outline-none ${
            isText ? "leading-7" : "transcript-words"
          } ${editorBusy ? "select-none opacity-40" : ""}`}
          onMouseDown={() => (arrowDirRef.current = 0)}
          onInput={() => {
            domDirtyRef.current = true;
            schedule();
          }}
          onBlur={() => commit(true)}
          onCompositionStart={() => (composingRef.current = true)}
          onCompositionEnd={() => {
            composingRef.current = false;
            schedule();
          }}
          onKeyDown={isText ? onTextKeyDown : onWordsKeyDown}
          onDoubleClick={(e) => {
            if (isText) return;
            e.preventDefault();
            openCorrect();
          }}
          onPaste={(e) => {
            e.preventDefault();
            const text = e.clipboardData
              .getData("text/plain")
              .replace(/\s*\n+\s*/g, " ");
            document.execCommand("insertText", false, text);
          }}
        />

        {/* re-spell input (C or double-click) */}
        {!isText && correcting && chip && (
          <div
            className="absolute z-10"
            style={{ top: chip.top, left: chip.left }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <input
              autoFocus
              defaultValue={
                correcting.prefill ??
                cues[correcting.li]?.words[correcting.wi]?.text ??
                ""
              }
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") applyCorrection(e.currentTarget.value);
                else if (e.key === "Escape") {
                  setCorrecting(null);
                  editorRef.current?.focus();
                }
              }}
              onBlur={() => setCorrecting(null)}
              className="w-36 rounded-md border border-violet-500 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 shadow-xl outline-none"
            />
          </div>
        )}

        {/* while it works the player's status card says so, in one place */}
        {empty && !transcribing && !serverCaptioning && (
          <p className="pointer-events-none absolute inset-x-0 top-8 px-6 text-center text-xs leading-5 text-zinc-600">
            {status.phase === "error" ? (
              <span className="text-red-400/80">
                Transcription failed — {status.message.replace(/\.+$/, "")}
              </span>
            ) : (
              "Transcribe the video to get an editable transcript — every line is one caption."
            )}
          </p>
        )}
      </div>
      {scriptOpen && <ScriptDialog onClose={() => setScriptOpen(false)} />}
    </div>
  );
}
