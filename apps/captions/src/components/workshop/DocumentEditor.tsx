import { useCallback, useEffect, useRef, useState } from "react";
import { GripVertical, Loader2, Lock, LockOpen, MessageCircleQuestion, Plus, Quote, Shuffle, X } from "lucide-react";
import { ConfirmButton } from "@/components/instagram/ConfirmButton";
import { MarkdownBody } from "@/components/MarkdownBody";
import { CarouselVisualizeModal, type LayoutPass } from "./CarouselVisualizeModal";
import { CopyButton } from "./CopyButton";
import { InlinePicture } from "./PiecePictures";
import type { CarouselTypeId } from "@/lib/carousel-visualize";
import { askUsageText, documentMarkdown, docUnit, uploadPicture, type AskUsage, type WorkshopDocument } from "@/lib/workshop";
import { joinParts, pictureToken, pictureUrl, rangesIn, splitPictures, withPictureUrls } from "@/lib/workshop-markdown";
import { foreignSpans } from "@/lib/mine";
import { markdownToPlain, toggleMark } from "@/lib/inline-markdown";
import { AskPanel, type AsideMessage } from "./SlideAside";
import { PILL_BUTTON, SelectionPill } from "./SelectionPill";
import { addedSpans } from "./word-diff";
import type { PieceQuote } from "@/lib/workshop";

export interface EditorBlock {
  key: string;
  id?: string;
  text: string;
  author: "ai" | "user";
}

const TEXT_CLASS = "w-full resize-none bg-transparent text-[15px] leading-[1.7] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60";

/** Height = all the text at the current width. A field measured while hidden reads 0 and is refitted once it shows (see AutoTextarea). */
function fitHeight(el: HTMLTextAreaElement) {
  el.style.height = "0px";
  el.style.height = `${el.scrollHeight}px`;
}

/** The "[Label: ]" placeholder the caret is in, if any: a picture put there replaces it and takes the label as its alt text. */
function placeholderAt(text: string, caret: number): { from: number; to: number; label: string } | null {
  for (const m of text.matchAll(/\[([^[\]\n]*?):\s*\]/g)) {
    const from = m.index ?? 0;
    const to = from + m[0].length;
    if (caret >= from && caret <= to) return { from, to, label: (m[1] ?? "").trim() };
  }
  return null;
}

/** One text part of a field: a textarea that fits its text, with its own highlight layers. Offsets are this part's own. */
function TextArea({
  value,
  disabled,
  onChange,
  onKeyDown,
  className,
  placeholder,
  marks,
  onSelectRange,
  changes,
  changesOn = false,
  onFile,
}: {
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  className?: string;
  placeholder?: string;
  /** Character ranges to mark behind the text ("Not mine": words the author never said). */
  marks?: Array<[number, number]>;
  /** The selection changed (start, end); `at` = where it ended on screen, once the mouse or key is let go. */
  onSelectRange?: (start: number, end: number, at?: { x: number; y: number }) => void;
  /** What the last AI turn wrote here, shaded while `changesOn` (it fades in and out). */
  changes?: Array<[number, number]>;
  changesOn?: boolean;
  /** A picture pasted or dropped here, with the selection it lands on. */
  onFile?: (file: File, start: number, end: number) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // the textarea node is replaced whenever the wrapper below appears or goes (`changes`/`marks` come and go),
  // so the observer and the first fit belong to whichever node is mounted now, not to the first one
  const observer = useRef<ResizeObserver | null>(null);
  const attach = useCallback((node: HTMLTextAreaElement | null) => {
    ref.current = node;
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    fitHeight(node);
    // a narrower or wider field wraps the lines differently: fit again, or the text scrolls inside and the shading drifts off it.
    // A hidden field reads width 0, so showing it again is a width change too.
    let width = node.clientWidth;
    observer.current = new ResizeObserver(() => {
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      fitHeight(node);
    });
    observer.current.observe(node);
  }, []);
  useEffect(() => {
    if (ref.current) fitHeight(ref.current);
  }, [value]);
  useEffect(() => {
    // a font arriving after the first fit re-wraps the lines at the same width
    const refit = () => {
      if (ref.current) fitHeight(ref.current);
    };
    void document.fonts?.ready.then(refit);
    document.fonts?.addEventListener("loadingdone", refit);
    return () => document.fonts?.removeEventListener("loadingdone", refit);
  }, []);
  const area = (
    <textarea
      ref={attach}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        // ⌘B / ⌘I: **bold** and *italic* for emphasis; the share view renders them
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "b" || e.key === "i")) {
          e.preventDefault();
          const el = e.currentTarget;
          const r = toggleMark(el.value, el.selectionStart, el.selectionEnd, e.key === "b" ? "**" : "*");
          onChange(r.text);
          requestAnimationFrame(() => el.setSelectionRange(r.start, r.end));
          return;
        }
        onKeyDown?.(e);
      }}
      onSelect={onSelectRange ? (e) => onSelectRange(e.currentTarget.selectionStart, e.currentTarget.selectionEnd) : undefined}
      // a drag-select gets the pill, a double- or triple-click doesn't
      onMouseUp={onSelectRange ? (e) => onSelectRange(e.currentTarget.selectionStart, e.currentTarget.selectionEnd, e.detail > 1 ? undefined : { x: e.clientX + 6, y: e.clientY + 10 }) : undefined}
      onKeyUp={
        onSelectRange
          ? (e) => {
              const r = e.currentTarget.getBoundingClientRect();
              if (e.shiftKey) onSelectRange(e.currentTarget.selectionStart, e.currentTarget.selectionEnd, { x: r.left + 8, y: r.bottom + 4 });
            }
          : undefined
      }
      onBlur={onSelectRange ? () => onSelectRange(0, 0) : undefined}
      onPaste={
        onFile
          ? (e) => {
              const f = [...e.clipboardData.files].find((x) => x.type.startsWith("image/"));
              if (!f) return;
              e.preventDefault();
              onFile(f, e.currentTarget.selectionStart, e.currentTarget.selectionEnd);
            }
          : undefined
      }
      onDragOver={onFile ? (e) => (e.dataTransfer.types.includes("Files") ? e.preventDefault() : undefined) : undefined}
      onDrop={
        onFile
          ? (e) => {
              if (!e.dataTransfer.files.length) return;
              e.preventDefault();
              e.stopPropagation();
              const f = [...e.dataTransfer.files].find((x) => x.type.startsWith("image/"));
              if (f) onFile(f, e.currentTarget.selectionStart, e.currentTarget.selectionEnd);
            }
          : undefined
      }
      rows={1}
      spellCheck
      className={`${marks?.length || changes ? "relative " : ""}${className ?? TEXT_CLASS}`}
      placeholder={placeholder ?? "…"}
    />
  );
  // `changes` given (even empty) keeps the same wrapper, so the field never remounts and loses focus mid-typing
  if (!marks?.length && !changes) return area;
  // the same text laid out behind the field, transparent, with the marked stretches shaded
  const layer = (ranges: Array<[number, number]>, mark: string, extra = "") => {
    const parts: React.ReactNode[] = [];
    let at = 0;
    ranges.forEach(([a, b], i) => {
      if (a > at) parts.push(value.slice(at, a));
      parts.push(
        <mark key={i} className={`rounded-sm text-transparent ${mark}`}>
          {value.slice(a, b)}
        </mark>,
      );
      at = b;
    });
    parts.push(`${value.slice(at)}\n`);
    return (
      <div aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words !text-transparent ${className ?? TEXT_CLASS} ${extra}`}>
        {parts}
      </div>
    );
  };
  return (
    <div className="relative">
      {marks?.length ? layer(marks, "bg-amber-400/30") : null}
      {changes ? layer(changes, "bg-emerald-400/30", `transition-opacity ${changesOn ? "opacity-100 duration-200" : "opacity-0 duration-[1500ms]"}`) : null}
      {area}
    </div>
  );
}

/**
 * A field's text. Its picture tokens show as pictures where they sit, between
 * text parts that are each a TextArea; editing a part rebuilds the whole value.
 * Highlights and the selection are mapped to each part's own offsets.
 */
function AutoTextarea({
  value,
  disabled,
  onChange,
  onKeyDown,
  className,
  placeholder,
  marks,
  onSelectRange,
  changes,
  changesOn = false,
  sessionId,
}: {
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  className?: string;
  placeholder?: string;
  /** Character ranges to mark behind the text ("Not mine": words the author never said). */
  marks?: Array<[number, number]>;
  /** The selection changed (start, end) in the whole text; `at` = where it ended on screen. */
  onSelectRange?: (start: number, end: number, at?: { x: number; y: number }) => void;
  /** What the last AI turn wrote here, shaded while `changesOn` (it fades in and out). */
  changes?: Array<[number, number]>;
  changesOn?: boolean;
  /** The piece's session: a field with one takes pictures (drop, paste). */
  sessionId?: string;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [pic, setPic] = useState<{ busy: boolean; error?: string }>({ busy: false });
  // the latest text and handler: a picture finishes uploading after the author may have typed more
  const latest = useRef({ value, onChange });
  // where the caret goes after a picture lands: the text right after its token
  const focusAt = useRef<number | null>(null);
  useEffect(() => {
    latest.current = { value, onChange };
    if (focusAt.current === null) return;
    const parts = splitPictures(value);
    const j = parts.findIndex((p) => p.kind === "text" && p.start === focusAt.current);
    if (j < 0) return;
    focusAt.current = null;
    const el = box.current?.querySelectorAll("textarea")[j / 2];
    el?.focus();
    el?.setSelectionRange(0, 0);
  });
  // start and end are offsets in the whole text
  const addPicture = async (file: File, start: number, end: number) => {
    if (!sessionId) return;
    setPic({ busy: true });
    try {
      const made = await uploadPicture(sessionId, file);
      const now = latest.current.value;
      const span = placeholderAt(now, start);
      const alt = span?.label || file.name.replace(/\.[a-z0-9]+$/i, "") || "Picture";
      const from = span?.from ?? Math.min(start, now.length);
      const to = span?.to ?? Math.min(end, now.length);
      const token = pictureToken(alt, made.id);
      latest.current.onChange(now.slice(0, from) + token + now.slice(to));
      setPic({ busy: false });
      focusAt.current = from + token.length;
    } catch (e) {
      setPic({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const parts = sessionId ? splitPictures(value) : [{ kind: "text" as const, text: value, start: 0 }];
  let textIndex = 0;
  return (
    <div ref={box}>
      {parts.map((p, k) => {
        if (p.kind === "picture") {
          return (
            <InlinePicture
              key={k}
              alt={p.alt}
              url={pictureUrl(sessionId ?? "", p.id)}
              disabled={disabled}
              onRemove={() => onChange(joinParts(parts, k, ""))}
            />
          );
        }
        const base = p.start;
        const len = p.text.length;
        const first = textIndex++ === 0;
        // only the last text part keeps the field's minimum height; the ones before a picture hug their text
        const last = k === parts.length - 1;
        return (
          <TextArea
            key={k}
            value={p.text}
            disabled={disabled}
            onChange={(t) => onChange(joinParts(parts, k, t))}
            onKeyDown={onKeyDown}
            className={last || !className ? className : className.replace(/\bmin-h-\[[^\]]+\]/g, "")}
            placeholder={first ? placeholder : undefined}
            marks={marks ? rangesIn(marks, base, len) : undefined}
            changes={changes ? rangesIn(changes, base, len) : undefined}
            changesOn={changesOn}
            onSelectRange={onSelectRange ? (s, e, at) => onSelectRange(base + s, base + e, at) : undefined}
            onFile={sessionId ? (file, s, e) => void addPicture(file, base + s, base + e) : undefined}
          />
        );
      })}
      {pic.busy ? (
        <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Adding picture…
        </p>
      ) : null}
      {pic.error ? <p className="mt-1 text-[11px] text-red-400">{pic.error}</p> : null}
    </div>
  );
}

/**
 * Carousel/ad: one field per slide or variant. Reel: hook cards plus one
 * freeform script. Notes is a single page.
 */
export function DocumentEditor({
  doc,
  locked,
  quiet = false,
  saving,
  aiAvailable = true,
  onChange,
  onGenerateCaption,
  onCarouselType,
  onLayouts,
  preview = false,
  visualize = false,
  onCloseVisualize,
  finalsVersions,
  onVersionCaption,
  mine,
  onLock,
  onLines,
  onQuote,
  onAsk,
  changes,
}: {
  doc: WorkshopDocument;
  /** What the last AI turn changed: each block it wrote (by id, also caption / pinned / hooks) as it was before; `on` shades the new words. */
  changes?: AiChanges;
  /** True while the AI is editing this document — typing is paused. */
  locked: boolean;
  /** Locked without the "AI is editing…" label (refreshing a session shown from memory). */
  quiet?: boolean;
  /** "Not mine" is on: the author's words this session, to mark everything else on the AI's slides. */
  mine?: Set<string> | null;
  /** Lock or unlock slides (block ids): the AI's edits to locked ones are refused. */
  onLock?: (ids: string[]) => void;
  /** "Other ways to say this": three versions of the selected words. */
  onLines?: (input: { blockId?: string; text: string; start: number; end: number }) => Promise<{ options: string[]; usage?: AskUsage }>;
  /** Select → Cite: the words go into the message box. */
  onQuote?: (quote: PieceQuote, at?: { x: number; y: number }) => void;
  /** "Ask about this": a side chat about one slide or a selection; it only answers. */
  onAsk?: (input: { blockId?: string; text: string; start?: number; end?: number; question: string; history: AsideMessage[] }) => Promise<{ answer: string; usage?: AskUsage }>;
  saving: boolean;
  aiAvailable?: boolean;
  onChange: (
    blocks: Array<{ id?: string; text: string }>,
    companions: { caption: string; pinned: string; hooks?: Array<{ id?: string; text: string }> },
  ) => void;
  /** Caption-only turn: Generate when empty, Another when a caption is already saved. */
  onGenerateCaption?: (another: boolean, version?: string) => void;
  /** Persist the visual carousel recipe (explainer, conversation, …). */
  onCarouselType?: (id: CarouselTypeId) => void;
  onLayouts?: (opts: LayoutPass) => Promise<void>;
  preview?: boolean;
  visualize?: boolean;
  onCloseVisualize?: () => void;
  finalsVersions?: Array<{ key: string; label: string }>;
  onVersionCaption?: (key: string, text: string) => void;
}) {
  if (doc.kind === "notes") {
    return <NotesEditor doc={doc} locked={locked} quiet={quiet} saving={saving} preview={preview} onChange={onChange} />;
  }
  return (
    <PieceEditor
      doc={doc}
      locked={locked}
      quiet={quiet}
      saving={saving}
      aiAvailable={aiAvailable}
      onChange={onChange}
      onGenerateCaption={onGenerateCaption}
      onCarouselType={onCarouselType}
      onLayouts={onLayouts}
      preview={preview}
      visualize={visualize}
      onCloseVisualize={onCloseVisualize}
      finalsVersions={finalsVersions}
      onVersionCaption={onVersionCaption}
      mine={mine}
      onLock={onLock}
      onLines={onLines}
      onQuote={onQuote}
      onAsk={onAsk}
      changes={changes}
    />
  );
}

type AiChanges = { before: Map<string, string>; on: boolean };

function notesBody(doc: WorkshopDocument) {
  return doc.blocks.map((b) => b.text).filter(Boolean).join("\n\n");
}

/** Legacy reels stored one spoken line per block; join them for the one script field. */
function reelBody(blocks: Array<{ text: string }>) {
  return blocks.map((b) => b.text).filter(Boolean).join("\n\n");
}

/**
 * One version's own post description: typed here it is the author's, saved on its own; "Write" asks the writer for this
 * version's (the chat turn writes into this tab). Empty = the main one is used for it.
 */
function VersionCaption({
  doc,
  version,
  disabled,
  canWrite,
  onSave,
  onWrite,
}: {
  doc: WorkshopDocument;
  version: { key: string; label: string };
  disabled: boolean;
  canWrite: boolean;
  onSave: (text: string) => void;
  onWrite: (another: boolean) => void;
}) {
  const saved = doc.captions?.[version.key];
  const [text, setText] = useState(saved?.text ?? "");
  const [seen, setSeen] = useState(saved?.text ?? "");
  if (seen !== (saved?.text ?? "")) {
    setSeen(saved?.text ?? "");
    setText(saved?.text ?? "");
  }
  // typing saves after a pause; anything not yet saved goes when the tab closes
  const pending = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const save = useRef(onSave);
  save.current = onSave;
  const flush = () => {
    window.clearTimeout(timer.current);
    if (pending.current !== null) save.current(pending.current);
    pending.current = null;
  };
  useEffect(() => flush, []);
  const change = (t: string) => {
    setText(t);
    pending.current = t;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 700);
  };
  const author = text && text === saved?.text ? saved.author : text ? "user" : null;
  const shown = text || doc.caption?.text || "";
  return (
    <>
      <div className="mb-1.5 flex items-center gap-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${author === "user" ? "bg-amber-400/70" : author === "ai" ? "bg-violet-400/50" : "bg-transparent"}`} />
        <p className="min-w-0 truncate text-[11px] text-muted-foreground">Post description · {version.label}</p>
        {shown.trim() ? (
          <CopyButton
            text={() => markdownToPlain(shown)}
            label="Copy"
            title="Copy this version's post description as Instagram takes it"
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          />
        ) : null}
        <button
          type="button"
          disabled={disabled || !canWrite}
          onClick={() => {
            flush();
            onWrite(!!text.trim());
          }}
          className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
          title={text.trim() ? "Another take of this version's description" : "Write this version's description"}
        >
          {text.trim() ? "Another" : "Write"}
        </button>
      </div>
      <AutoTextarea
        value={text}
        disabled={disabled}
        onChange={change}
        sessionId={doc.sessionId}
        placeholder={doc.caption?.text ? "Uses the main description until this version has its own" : "This version's post description"}
      />
    </>
  );
}

/** Scratch page: one field, no beats, no caption. */
function NotesEditor({
  doc,
  locked,
  quiet = false,
  saving,
  preview,
  onChange,
}: {
  doc: WorkshopDocument;
  locked: boolean;
  /** Locked without the "AI is editing…" label (refreshing a session shown from memory). */
  quiet?: boolean;
  saving: boolean;
  preview: boolean;
  onChange: (
    blocks: Array<{ id?: string; text: string }>,
    companions: { caption: string; pinned: string; hooks?: Array<{ id?: string; text: string }> },
  ) => void;
}) {
  const [text, setText] = useState(() => notesBody(doc));
  const [seen, setSeen] = useState(doc);
  if (seen !== doc) {
    setSeen(doc);
    const next = notesBody(doc);
    if (next !== text) setText(next);
  }
  const emit = (next: string) => {
    setText(next);
    const id = doc.blocks[0]?.id;
    onChange(next ? [{ ...(id ? { id } : {}), text: next }] : [], { caption: "", pinned: "" });
  };
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-transparent">
      {(locked && !quiet) || saving ? (
        <span className="absolute right-4 top-2 z-10 rounded-full border border-border bg-background/90 px-2 py-0.5 text-[10px] text-muted-foreground">{locked && !quiet ? "AI is editing…" : "saving…"}</span>
      ) : null}
      {/* the text box and the preview keep their bar's 8px at all times, out of this right padding (index.css) */}
      <div className="min-h-0 flex-1 overflow-hidden px-5 pb-8 pt-8 bars:pr-3">
        {preview ? (
          <div className="h-full overflow-y-scroll px-1 py-2">
            <MarkdownBody source={withPictureUrls(text, doc.sessionId)} media={false} />
          </div>
        ) : (
          <textarea
            value={text}
            disabled={locked}
            onChange={(e) => emit(e.target.value)}
            spellCheck
            aria-label="Notes"
            placeholder="Write anything — scraps, quotes, a list. This isn't the piece."
            className="h-full w-full resize-none overflow-y-scroll bg-transparent text-[15px] leading-[1.7] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />
        )}
      </div>
    </div>
  );
}

/** Slight lift so a carousel slide (or reel hook) reads as its own card on the editor. */
const SLIDE_SURFACE = "rounded-lg bg-muted px-3 py-3.5 ring-1 ring-inset ring-foreground/[0.08]";

function PieceEditor({
  doc,
  locked,
  quiet = false,
  saving,
  aiAvailable = true,
  onChange,
  onGenerateCaption,
  onCarouselType,
  onLayouts,
  preview,
  visualize,
  onCloseVisualize,
  finalsVersions,
  onVersionCaption,
  mine,
  onLock,
  onLines,
  onQuote,
  onAsk,
  changes,
}: {
  doc: WorkshopDocument;
  locked: boolean;
  /** Locked without the "AI is editing…" label (refreshing a session shown from memory). */
  quiet?: boolean;
  saving: boolean;
  aiAvailable?: boolean;
  changes?: AiChanges;
  mine?: Set<string> | null;
  onLock?: (ids: string[]) => void;
  onLines?: (input: { blockId?: string; text: string; start: number; end: number }) => Promise<{ options: string[]; usage?: AskUsage }>;
  onQuote?: (quote: PieceQuote, at?: { x: number; y: number }) => void;
  onAsk?: (input: { blockId?: string; text: string; start?: number; end?: number; question: string; history: AsideMessage[] }) => Promise<{ answer: string; usage?: AskUsage }>;
  onChange: (
    blocks: Array<{ id?: string; text: string }>,
    companions: { caption: string; pinned: string; hooks?: Array<{ id?: string; text: string }> },
  ) => void;
  onGenerateCaption?: (another: boolean, version?: string) => void;
  onCarouselType?: (id: CarouselTypeId) => void;
  onLayouts?: (opts: LayoutPass) => Promise<void>;
  preview: boolean;
  visualize: boolean;
  onCloseVisualize?: () => void;
  /** Its versions (Finals): a post description tab each. */
  finalsVersions?: Array<{ key: string; label: string }>;
  onVersionCaption?: (key: string, text: string) => void;
}) {
  const [blocks, setBlocks] = useState<EditorBlock[]>(() => fromBlocks(doc.blocks));
  const [hooks, setHooks] = useState<EditorBlock[]>(() => fromBlocks(doc.hooks ?? []));
  const [caption, setCaption] = useState(doc.caption?.text ?? "");
  const [pinned, setPinned] = useState(doc.pinned?.text ?? "");
  // which post description shows: the main one, or a Finals version's own
  const [captionTab, setCaptionTab] = useState("main");
  const tabVersion = finalsVersions?.find((v) => v.key === captionTab);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const unit = docUnit(doc.kind);
  const isReel = doc.kind === "reel";
  // The server's copy changed (our save landed, an AI edit, a revert): mirror it,
  // keeping the keys of blocks that are still being typed so focus survives.
  const [seen, setSeen] = useState(doc);
  if (seen !== doc) {
    setSeen(doc);
    setBlocks(mergeBlocks(blocks, doc.blocks));
    setHooks(mergeBlocks(hooks, doc.hooks ?? []));
    setCaption(doc.caption?.text ?? "");
    setPinned(doc.pinned?.text ?? "");
  }
  const hookPayload = (list: EditorBlock[]) => list.map((h) => ({ id: h.id, text: h.text }));
  const emit = (
    next: EditorBlock[],
    companions: { caption: string; pinned: string; hookList?: EditorBlock[] } = { caption, pinned },
  ) => {
    const hookList = companions.hookList ?? hooks;
    setBlocks(next);
    onChange(next.filter((b) => b.text.trim() || b.id).map((b) => ({ id: b.id, text: b.text })), {
      caption: companions.caption,
      pinned: companions.pinned,
      ...(doc.kind === "reel" ? { hooks: hookPayload(hookList) } : {}),
    });
  };
  const emitHooks = (next: EditorBlock[]) => {
    setHooks(next);
    emit(blocks, { caption, pinned, hookList: next });
  };
  const setCompanion = (key: "caption" | "pinned", text: string) => {
    if (key === "caption") setCaption(text);
    else setPinned(text);
    emit(blocks, { caption: key === "caption" ? text : caption, pinned: key === "pinned" ? text : pinned });
  };
  const companionAuthor = (key: "caption" | "pinned", text: string): "ai" | "user" | null =>
    text === (doc[key]?.text ?? "") ? (doc[key]?.author ?? null) : "user";
  const tick = (author: "ai" | "user" | null) =>
    author === "user" ? "bg-amber-400/70" : author === "ai" ? "bg-violet-400/50" : "bg-transparent";
  const hasPiece = blocks.some((b) => b.text.trim());
  const lockedIds = doc.locked ?? [];
  const toggleLock = (id: string) => onLock?.(lockedIds.includes(id) ? lockedIds.filter((x) => x !== id) : [...lockedIds, id]);
  // "Other ways to say this": the selection on a slide, then three versions of it to pick from
  const [sel, setSel] = useState<{ key: string; start: number; end: number; at?: { x: number; y: number } } | null>(null);
  const select = (key: string, start: number, end: number, at?: { x: number; y: number }) =>
    setSel((s) => (end > start ? { key, start, end, at: at ?? (s?.key === key ? s.at : undefined) } : null));
  const [lines, setLines] = useState<{ key: string; start: number; end: number; was: string; list: string[] | null; usage?: AskUsage; error?: string } | null>(null);
  const askLines = async (b: EditorBlock) => {
    if (!onLines || !sel || sel.key !== b.key || sel.end <= sel.start) return;
    const at = { ...sel, was: b.text.slice(sel.start, sel.end) };
    setSel(null);
    setLines({ ...at, list: null });
    try {
      const r = await onLines({ blockId: b.id, text: b.text, start: at.start, end: at.end });
      setLines({ ...at, list: r.options, usage: r.usage });
    } catch (e) {
      setLines({ ...at, list: [], error: e instanceof Error ? e.message : String(e) });
    }
  };
  const pickLine = (b: EditorBlock, option: string) => {
    if (!lines || b.text.slice(lines.start, lines.end) !== lines.was) {
      setLines(lines ? { ...lines, list: [], error: "The text changed since you asked. Select it again." } : null);
      return;
    }
    setText(b.key, b.text.slice(0, lines.start) + option + b.text.slice(lines.end));
    setLines(null);
    setSel(null);
  };
  // Select → Cite (into the message box), and "Ask about this" (the whole slide, or the selected words)
  const [asking, setAsking] = useState<{ key: string; start?: number; end?: number; was?: string; history: AsideMessage[]; busy: boolean; error?: string } | null>(null);
  const hasSel = (b: EditorBlock) => sel?.key === b.key && sel.end > sel.start && !!b.text.slice(sel.start, sel.end).trim();
  const cite = (b: EditorBlock, i: number) => {
    if (!sel || !hasSel(b)) return;
    onQuote?.({ blockId: b.id, slide: i, text: b.text.slice(sel.start, sel.end).trim() }, sel.at);
    setSel(null);
  };
  // the last AI turn's new words in one field (a field it didn't write gets none)
  const newWords = (id: string | undefined, now: string) => (changes && id && changes.before.has(id) ? addedSpans(changes.before.get(id)!, now) : undefined);
  const scriptChanges =
    changes && blocks.some((b) => b.id && changes.before.has(b.id))
      ? addedSpans(reelBody(blocks.map((b) => ({ text: b.id && changes.before.has(b.id) ? changes.before.get(b.id)! : b.text }))), reelBody(blocks))
      : undefined;
  const changesOn = !!changes?.on;
  // Cite on a reel's script, its hooks, the post description and the pinned comment: the words and which field they're in
  const citePill = (key: string, text: string, where: Omit<PieceQuote, "text">) => {
    const words = sel?.key === key ? text.slice(sel.start, sel.end).trim() : "";
    return onQuote && sel?.at && words ? (
      <SelectionPill at={sel.at} onDismiss={() => setSel(null)}>
        <button
          type="button"
          onClick={() => {
            onQuote({ ...where, text: words }, sel.at);
            setSel(null);
          }}
          className={PILL_BUTTON}
          title="Cite in the message box: write about it there"
        >
          <Quote className="h-3.5 w-3.5" /> Cite
        </button>
      </SelectionPill>
    ) : null;
  };
  const startAsk = (b: EditorBlock) => {
    setLines(null);
    const picked = sel && hasSel(b) ? { start: sel.start, end: sel.end, was: b.text.slice(sel.start, sel.end).trim() } : {};
    setSel(null);
    setAsking({ key: b.key, ...picked, history: [], busy: false });
  };
  const ask = async (b: EditorBlock, question: string) => {
    if (!onAsk || !asking) return;
    const history = [...asking.history, { role: "user" as const, text: question }];
    setAsking({ ...asking, history, busy: true, error: undefined });
    try {
      const r = await onAsk({ blockId: b.id, text: b.text, start: asking.start, end: asking.end, question, history: asking.history });
      setAsking((a) => (a && a.key === b.key ? { ...a, history: [...history, { role: "assistant", text: r.answer, usage: r.usage }], busy: false } : a));
    } catch (e) {
      setAsking((a) => (a && a.key === b.key ? { ...a, busy: false, error: e instanceof Error ? e.message : String(e) } : a));
    }
  };
  /** The AI's words you never said, when "Not mine" is on; your own blocks are yours. */
  const marksFor = (b: EditorBlock) => (mine && b.author === "ai" ? foreignSpans(b.text, mine) : undefined);
  const captionAuthor = caption ? companionAuthor("caption", caption) : null;
  const showCaptionGenerate = !!onGenerateCaption && (!caption.trim() || caption === (doc.caption?.text ?? ""));
  const captionAnother = !!caption.trim();
  const captionGenerateWhy = !aiAvailable ? "AI is not available" : !hasPiece ? `Write the ${unit.many} first` : captionAnother ? "One different extra finding, still one caption" : "One caption: extra finding plus search terms, not a recap";
  const setText = (key: string, text: string) => emit(blocks.map((b) => (b.key === key ? { ...b, text, author: "user" } : b)));
  const insertAfter = (key: string | null) => {
    const at = key ? blocks.findIndex((b) => b.key === key) + 1 : blocks.length;
    const seq = 1 + Math.max(0, ...blocks.map((b) => Number(/^n(\d+)$/.exec(b.key)?.[1] ?? 0)));
    const fresh: EditorBlock = { key: `n${seq}`, text: "", author: "user" };
    emit([...blocks.slice(0, at), fresh, ...blocks.slice(at)]);
  };
  const remove = (key: string) => emit(blocks.filter((b) => b.key !== key));
  const move = (fromKey: string, toKey: string, extras: string[] = []) => {
    if (!extras.length) {
      if (fromKey === toKey) return;
      const from = blocks.findIndex((b) => b.key === fromKey);
      const to = blocks.findIndex((b) => b.key === toKey);
      if (from < 0 || to < 0) return;
      const next = [...blocks];
      const [item] = next.splice(from, 1);
      if (!item) return;
      next.splice(to, 0, item);
      emit(next);
      return;
    }
    const group = [fromKey, ...extras.filter((k) => k !== fromKey)].filter((k, i, a) => a.indexOf(k) === i);
    if (group.includes(toKey)) return;
    const items = group.map((k) => blocks.find((b) => b.key === k)).filter((x): x is EditorBlock => !!x);
    if (!items.length) return;
    const rest = blocks.filter((b) => !group.includes(b.key));
    const to = rest.findIndex((b) => b.key === toKey);
    if (to < 0) return;
    const next = [...rest];
    next.splice(to, 0, ...items);
    emit(next);
  };
  const emitScript = (text: string) => {
    const first = blocks[0];
    emit(text ? [{ key: first?.key ?? "n1", id: first?.id, text, author: "user" }] : []);
  };
  const addHook = () => {
    if (hooks.length >= 8) return;
    const seq = 1 + Math.max(0, ...hooks.map((h) => Number(/^n(\d+)$/.exec(h.key)?.[1] ?? 0)));
    emitHooks([...hooks, { key: `n${seq}`, text: "", author: "user" }]);
  };
  const setHookText = (key: string, text: string) => emitHooks(hooks.map((h) => (h.key === key ? { ...h, text, author: "user" } : h)));
  const removeHook = (key: string) => emitHooks(hooks.filter((h) => h.key !== key));

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-transparent">
      {(locked && !quiet) || saving ? (
        <span className="absolute right-4 top-2 z-10 rounded-full border border-border bg-background/90 px-2 py-0.5 text-[10px] text-muted-foreground">{locked && !quiet ? "AI is editing…" : "saving…"}</span>
      ) : null}
      {/* the bar's 8px at all times, out of the right padding (index.css): the text does not move when the piece outgrows its card */}
      <div className="min-h-0 flex-1 overflow-y-scroll px-5 pb-10 pt-8 bars:pr-3">
        {preview ? (
          <div className="px-1 py-2">
            <MarkdownBody source={withPictureUrls(documentMarkdown(doc, { frontmatter: false }), doc.sessionId)} media={false} />
          </div>
        ) : (
          <div>
            {isReel && hooks.length > 0 && (
              <div className="mb-5 space-y-2">
                {hooks.map((h, i) => (
                  <div key={h.key} className={`group ${SLIDE_SURFACE}`}>
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tick(h.author)}`} title={h.author === "user" ? "Yours" : h.author === "ai" ? "Written by the AI" : undefined} />
                      <p className="text-[11px] text-muted-foreground">Hook {i + 1}</p>
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => removeHook(h.key)}
                        className="ml-auto rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-red-500 group-hover:opacity-100 group-focus-within:opacity-100"
                        title={`Remove Hook ${i + 1}`}
                        aria-label={`Remove Hook ${i + 1}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                    <AutoTextarea
                      value={h.text}
                      disabled={locked}
                      onChange={(v) => setHookText(h.key, v)}
                      sessionId={doc.sessionId}
                      changes={newWords(h.id, h.text)}
                      changesOn={changesOn}
                      onSelectRange={onQuote ? (start, end, at) => select(h.key, start, end, at) : undefined}
                      placeholder="Opening line"
                    />
                    {citePill(h.key, h.text, { field: "hook", ...(h.id ? { blockId: h.id } : {}) })}
                  </div>
                ))}
                {hooks.length < 8 && (
                  <button
                    type="button"
                    disabled={locked}
                    onClick={addHook}
                    className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border/80 py-3 text-[12px] text-muted-foreground hover:border-foreground/25 hover:text-foreground disabled:opacity-40"
                  >
                    <Plus className="h-3 w-3" /> Add hook variation
                  </button>
                )}
              </div>
            )}
            {isReel && hooks.length === 0 && (
              <button
                type="button"
                disabled={locked}
                onClick={addHook}
                className="mb-3 flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                <Plus className="h-3 w-3" /> Add hook variation
              </button>
            )}
            {isReel ? (
              <div className="px-3">
                <AutoTextarea
                  value={reelBody(blocks)}
                  disabled={locked}
                  marks={mine && blocks.length === 1 && blocks[0]!.author === "ai" ? foreignSpans(blocks[0]!.text, mine) : undefined}
                  onChange={emitScript}
                  sessionId={doc.sessionId}
                  changes={scriptChanges}
                  changesOn={changesOn}
                  onSelectRange={onQuote ? (start, end, at) => select("script", start, end, at) : undefined}
                  placeholder="Write the script"
                  className="min-h-[16rem] w-full resize-none bg-transparent text-[15px] leading-[1.7] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
                />
                {citePill("script", reelBody(blocks), { field: "script" })}
              </div>
            ) : (
              <>
            <div className={doc.kind === "carousel" ? "space-y-2" : undefined}>
            {blocks.map((b, i) => (
              <div
                key={b.key}
                onDragOver={(e) => {
                  if (!dragKey || dragKey === b.key) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setOverKey(b.key);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragKey) move(dragKey, b.key);
                  setDragKey(null);
                  setOverKey(null);
                }}
                className={`group flex gap-2 ${doc.kind === "carousel" ? SLIDE_SURFACE : `py-4 ${i < blocks.length - 1 ? "border-b border-border/70" : ""}`} ${b.id && lockedIds.includes(b.id) ? "!ring-amber-400/40" : ""} ${overKey === b.key && dragKey && dragKey !== b.key ? "bg-muted/40" : ""} ${dragKey === b.key ? "opacity-50" : ""}`}
              >
                <button
                  type="button"
                  draggable={!locked && blocks.length > 1}
                  onDragStart={(e) => {
                    setDragKey(b.key);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => {
                    setDragKey(null);
                    setOverKey(null);
                  }}
                  disabled={locked || blocks.length < 2}
                  title={blocks.length > 1 ? `Drag to reorder ${unit.many}` : undefined}
                  aria-label={`Reorder ${unit.one} ${i + 1}`}
                  className="mt-1 flex shrink-0 cursor-grab items-start text-muted-foreground/0 group-hover:text-muted-foreground active:cursor-grabbing disabled:cursor-default"
                >
                  <GripVertical className="h-4 w-4" />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tick(b.author)}`} title={b.author === "user" ? "Yours" : b.author === "ai" ? "Written by the AI" : undefined} />
                    <p className="text-[11px] text-muted-foreground">
                      {unit.one[0]!.toUpperCase() + unit.one.slice(1)} {i + 1}
                    </p>
                    {onLock && b.id ? (
                      <button
                        type="button"
                        onClick={() => toggleLock(b.id!)}
                        className={`rounded p-0.5 hover:bg-muted ${lockedIds.includes(b.id) ? "text-amber-300" : "text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}
                        title={lockedIds.includes(b.id) ? `Locked: the AI can't change ${unit.one} ${i + 1}. Click to unlock.` : `Lock ${unit.one} ${i + 1} so the AI can't change it`}
                        aria-pressed={lockedIds.includes(b.id)}
                        aria-label={lockedIds.includes(b.id) ? `Unlock ${unit.one} ${i + 1}` : `Lock ${unit.one} ${i + 1}`}
                      >
                        {lockedIds.includes(b.id) ? <Lock className="h-3 w-3" /> : <LockOpen className="h-3 w-3" />}
                      </button>
                    ) : null}
                    <div className="ml-auto flex gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                      {onAsk ? (
                        <button type="button" disabled={!aiAvailable || !b.text.trim()} onClick={() => startAsk(b)} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-violet-300 disabled:opacity-40" title={`Ask about ${unit.one} ${i + 1} in a side chat (it only answers, nothing changes)`}>
                          <MessageCircleQuestion className="h-3 w-3" />
                        </button>
                      ) : null}
                      <CopyButton text={() => b.text.trim()} title={`Copy ${unit.one} ${i + 1}`} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" />
                      <button type="button" disabled={locked} onClick={() => insertAfter(b.key)} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" title={`Add a ${unit.one} after (⌘/Ctrl+Enter)`}>
                        <Plus className="h-3 w-3" />
                      </button>
                      <button type="button" disabled={locked} onClick={() => remove(b.key)} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-red-500" title={`Remove ${unit.one}`}>
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                  <AutoTextarea
                    value={b.text}
                    disabled={locked}
                    marks={marksFor(b)}
                    changes={newWords(b.id, b.text)}
                    changesOn={changesOn}
                    onSelectRange={onLines || onQuote || onAsk ? (start, end, at) => select(b.key, start, end, at) : undefined}
                    onChange={(v) => setText(b.key, v)}
                    sessionId={doc.sessionId}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        insertAfter(b.key);
                      }
                    }}
                  />
                  {hasSel(b) && sel?.at ? (
                    <SelectionPill at={sel.at} onDismiss={() => setSel(null)}>
                      {onQuote ? (
                        <button type="button" onClick={() => cite(b, i)} className={PILL_BUTTON} title="Cite in the message box: write about it there">
                          <Quote className="h-3.5 w-3.5" /> Cite
                        </button>
                      ) : null}
                      {onAsk ? (
                        <button type="button" disabled={!aiAvailable} onClick={() => startAsk(b)} className={`${PILL_BUTTON} text-violet-300`} title="Ask about the selected words in a side chat. It only answers: nothing on the piece changes.">
                          <MessageCircleQuestion className="h-3.5 w-3.5" /> Ask
                        </button>
                      ) : null}
                      {onLines ? (
                        <button type="button" disabled={locked || !aiAvailable} onClick={() => void askLines(b)} className={`${PILL_BUTTON} text-violet-300`} title="Three other ways to say the selected words. Nothing else on the piece changes.">
                          <Shuffle className="h-3.5 w-3.5" /> Other ways
                        </button>
                      ) : null}
                    </SelectionPill>
                  ) : null}
                  {asking?.key === b.key ? (
                    <AskPanel
                      label={`${unit.one} ${i + 1}`}
                      quote={asking.was}
                      history={asking.history}
                      busy={asking.busy}
                      error={asking.error}
                      onAsk={(q) => void ask(b, q)}
                      onClose={() => setAsking(null)}
                    />
                  ) : null}
                  {lines?.key === b.key ? (
                    <div className="mt-2 flex flex-col gap-1 border-t border-border/60 pt-2">
                      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        {lines.list === null ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        {lines.list === null ? `Other ways to say “${lines.was}”…` : lines.error ? lines.error : `Instead of “${lines.was}”, click one:`}
                        <button type="button" onClick={() => setLines(null)} className="ml-auto rounded p-0.5 hover:bg-muted hover:text-foreground" aria-label="Close the options">
                          <X className="h-3 w-3" />
                        </button>
                      </p>
                      {(lines.list ?? []).map((o) => (
                        <button key={o} type="button" disabled={locked} onClick={() => pickLine(b, o)} className="rounded-md border border-border/70 px-2 py-1 text-left text-[13px] text-foreground hover:bg-muted disabled:opacity-50">
                          {o}
                        </button>
                      ))}
                      {lines.usage ? <p className="text-[10px] text-muted-foreground">{askUsageText(lines.usage)}</p> : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
            </div>
            <div className="mt-2 flex items-center gap-3">
              <button type="button" disabled={locked} onClick={() => insertAfter(null)} className="text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50">
                + {blocks.length ? `Add a ${unit.one}` : "Start writing, or ask the AI to draft it"}
              </button>
              {hasPiece ? (
                <CopyButton
                  text={() => blocks.flatMap((b, i) => (b.text.trim() ? [`${unit.one[0]!.toUpperCase() + unit.one.slice(1)} ${i + 1}\n${b.text.trim()}`] : [])).join("\n\n")}
                  label={`Copy all ${unit.many}`}
                  title={`Copy every ${unit.one}, numbered, as plain text`}
                  className="ml-auto flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
                />
              ) : null}
            </div>
              </>
            )}
            {!["notes", "newsletter", "thread", "article"].includes(doc.kind) && (
              <div className={`mt-8 grid gap-6 border-t border-border pt-6 sm:grid-cols-2 ${isReel ? "px-3" : ""}`}>
                <div className="group">
                  {finalsVersions?.length ? (
                    <div className="mb-2 flex flex-wrap gap-1" role="tablist" aria-label="Post description per version">
                      {[{ key: "main", label: "Main" }, ...finalsVersions].map((v) => (
                        <button
                          key={v.key}
                          type="button"
                          role="tab"
                          aria-selected={captionTab === v.key}
                          onClick={() => setCaptionTab(v.key)}
                          title={v.key === "main" ? "The piece's post description: a version without its own uses this" : `Version ${v.label}`}
                          className={`max-w-[10rem] truncate rounded-md px-2 py-0.5 text-[11px] ${captionTab === v.key ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                        >
                          {v.label}
                          {v.key !== "main" && !doc.captions?.[v.key]?.text ? <span className="text-muted-foreground/60"> · main</span> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {tabVersion ? (
                    <VersionCaption
                      doc={doc}
                      version={tabVersion}
                      disabled={locked}
                      canWrite={!!onGenerateCaption && aiAvailable && hasPiece}
                      onSave={(text) => onVersionCaption?.(tabVersion.key, text)}
                      onWrite={(another) => onGenerateCaption?.(another, tabVersion.key)}
                    />
                  ) : (
                  <>
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tick(captionAuthor)}`} title={captionAuthor === "user" ? "Yours" : captionAuthor === "ai" ? "Written by the AI" : undefined} />
                    <p className="text-[11px] text-muted-foreground" title="Shown under the Instagram post — an extra finding or context the slides don't carry, plus search terms. Not a recap.">
                      Post description
                    </p>
                    {caption.trim() ? (
                      <CopyButton
                        text={() => markdownToPlain(caption)}
                        label="Copy"
                        title="Copy the post description as Instagram takes it: plain text, every line break kept"
                        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                      />
                    ) : null}
                    {showCaptionGenerate &&
                      (captionAnother ? (
                        <ConfirmButton
                          label="Another"
                          confirmLabel="Replace?"
                          disabled={locked || !aiAvailable || !hasPiece}
                          onConfirm={() => onGenerateCaption?.(true)}
                          title={captionGenerateWhy}
                          className="invisible text-[11px] text-muted-foreground hover:text-foreground group-hover:visible group-focus-within:visible disabled:opacity-40"
                          armedClassName="!visible text-foreground"
                        />
                      ) : (
                        <button
                          type="button"
                          disabled={locked || !aiAvailable || !hasPiece}
                          onClick={() => onGenerateCaption?.(false)}
                          title={captionGenerateWhy}
                          aria-label="Generate post description"
                          className="invisible text-[11px] text-muted-foreground hover:text-foreground group-hover:visible group-focus-within:visible disabled:opacity-40"
                        >
                          Generate
                        </button>
                      ))}
                  </div>
                  <AutoTextarea
                    value={caption}
                    disabled={locked}
                    onChange={(v) => setCompanion("caption", v)}
                    sessionId={doc.sessionId}
                    changes={newWords("caption", caption)}
                    changesOn={changesOn}
                    onSelectRange={onQuote ? (start, end, at) => select("caption", start, end, at) : undefined}
                    placeholder="Shown under the post"
                  />
                  {citePill("caption", caption, { field: "caption" })}
                  {caption.length > 1800 ? (
                    <p className={`mt-1 text-right text-[10px] tabular-nums ${caption.length > 2200 ? "text-red-400" : "text-muted-foreground"}`} title="Instagram cuts a caption at 2,200 characters">
                      {caption.length.toLocaleString("en-US")} / 2,200{caption.length > 2200 ? " · too long for Instagram" : ""}
                    </p>
                  ) : null}
                  </>
                  )}
                </div>
                <div>
                  <p className="mb-1.5 text-[11px] text-muted-foreground" title="Usually empty. Use only to sell something or to occupy a comment you know is coming. Never a question hoping people will reply.">
                    Pinned comment <span className="text-muted-foreground/70">(optional)</span>
                  </p>
                  <AutoTextarea
                    value={pinned}
                    disabled={locked}
                    onChange={(v) => setCompanion("pinned", v)}
                    sessionId={doc.sessionId}
                    changes={newWords("pinned", pinned)}
                    changesOn={changesOn}
                    onSelectRange={onQuote ? (start, end, at) => select("pinned", start, end, at) : undefined}
                    className="w-full resize-none bg-transparent text-sm leading-relaxed text-muted-foreground outline-none placeholder:text-muted-foreground/50 disabled:opacity-60"
                    placeholder="Usually empty"
                  />
                  {citePill("pinned", pinned, { field: "pinned" })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {visualize && doc.kind === "carousel" && (
        <CarouselVisualizeModal
          blocks={blocks}
          caption={caption}
          typeId={doc.carouselType}
          locked={locked}
          onClose={() => onCloseVisualize?.()}
          onType={(id) => onCarouselType?.(id)}
          onReorder={move}
          storedLayouts={doc.carouselLayouts}
          aiAvailable={aiAvailable}
          onLayouts={onLayouts}
        />
      )}
    </div>
  );
}

function fromBlocks(list: Array<{ id: string; text: string; author: "ai" | "user" }>): EditorBlock[] {
  return list.map((b) => ({ key: b.id, id: b.id, text: b.text, author: b.author }));
}

/**
 * Adopt the server's blocks into the local list. Local blocks match the
 * server's in order (by id, or by text for ones just created); empty new
 * blocks stay where they are. Anything else (an AI edit, a revert) replaces
 * the list wholesale.
 */
function mergeBlocks(local: EditorBlock[], server: Array<{ id: string; text: string; author: "ai" | "user" }>): EditorBlock[] {
  const out: EditorBlock[] = [];
  let si = 0;
  for (const b of local) {
    const s = server[si];
    if (!b.id && !b.text.trim()) {
      if (s && !s.text.trim()) {
        out.push({ key: b.key, id: s.id, text: s.text, author: s.author });
        si++;
      } else {
        out.push(b);
      }
      continue;
    }
    if (!s || (b.id ? s.id !== b.id : s.text.trim() !== b.text.trim())) return fromBlocks(server);
    out.push({ key: b.key, id: s.id, text: s.text, author: s.author });
    si++;
  }
  return si === server.length ? out : fromBlocks(server);
}
