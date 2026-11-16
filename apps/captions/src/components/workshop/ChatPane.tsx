import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink, Eye, FileText, Globe, Loader2, Mic, Paperclip, Plus, Quote, RotateCcw, ShieldCheck, Telescope, X } from "lucide-react";
import { ReplyText } from "@/components/ReplyText";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { InstagramPost } from "@/lib/instagram";
import { CONTEXT_FIELD_LABELS, PART_LABELS, PASTE_AS_FILE, PDF_MAX_BYTES, STAGE_LABELS, TEXT_ATTACH_MAX, TURN_STOPPED, attachKind, fileBase64, imageUrl, inSlideOrder, shrinkImage, type PendingFile, type PendingImage, countUnits, docTabLabel, durationLabel, editSummary, pastedUrl, turnDocChange, type ChangeScope, type ChatMessage, type ContextSnippet, type LoadedSource, type PieceQuote, type WorkshopDocument } from "@/lib/workshop";
import { AuditOpenRow } from "./AuditCard";
import { CopyButton } from "./CopyButton";
import { SourceResultCard } from "./SourceResultCard";
import { CiteButton, SelectionPill, citeAt } from "./SelectionPill";
import { WhatChanged } from "./WhatChanged";
import { AiPicker } from "@/components/assistant/AiPicker";
import { ChatPicture } from "@/components/chat/ChatPicture";
import { useFollowEnd } from "@/components/chat/useFollowEnd";
import { QueuedRow } from "@/components/chat/QueuedRow";
import { ICON_BTN, MicButton, SendButton, VoiceDone, VoiceError, VoiceStatus, boxClass, useChatVoice } from "@/components/chat/MessageBox";
import { cn } from "@/lib/utils";
import { Steps, type Step } from "@/components/chat/Steps";
import { Notice } from "./Notice";
import { ChipComposer, numbered, readable, type ComposerHandle } from "./ChipComposer";
import type { Selection } from "@contracts/providers";
import { confirmHeavy } from "@/lib/setup";
import { cornerTaken } from "@/lib/dock-place";

/**
 * The conversation: the AI thinks here and edits the document below.
 * Each turn says what it edited (Undo is a quiet text action) and what it learned
 * from your edits; library searches come back as posts you can add. An accuracy
 * audit is an Open row — the claims live in a modal.
 * The composer carries pinned context and what goes in from the sources.
 */
/** How long the wait is, measured (Claude on the Mac, 2026-10-01: a draft ~35 s, quick research ~1 min, deep ~4 min). */
/** A turn's steps for the shared list: each with how long it took (the one still running, so far). */
const stepRows = (steps: NonNullable<ChatMessage["steps"]>, now: number): Step[] => steps.map((s, i) => ({ label: s.label, ms: (s.end ?? (i === steps.length - 1 ? now : s.at)) - s.at }));
/** From the first step to the end of the last. */
const tookOf = (steps: NonNullable<ChatMessage["steps"]>): number => steps.reduce((t, s) => Math.max(t, s.end ?? s.at), steps[0].at) - steps[0].at;

function thinkingHint(m: ChatMessage): string {
  // a Mac answer is named for its CLI ("Claude (Mac)", "Codex (Mac)"); the follower's read is Fable for Claude
  const mac = !!m.provider?.endsWith("(Mac)");
  if (m.review) return "· about a minute";
  const deep = m.audit?.depth === "deep" || m.research?.depth === "deep";
  if (m.audit || m.stage === "researching") {
    if (deep) return mac ? "· a few minutes" : "· 5–15 min";
    return "· about a minute";
  }
  return mac ? "· writing starts after about 30 s" : "· 20–60 s for a full draft";
}

export function ChatPane({
  readOnly,
  messages,
  docs,
  activeDoc,
  thinking,
  aiAvailable,
  pinned,
  onUnpin,
  quotes = [],
  onQuote,
  onUnquote,
  onEditQuote,
  sources,
  loaded,
  onResetLoaded,
  deep,
  onDeep,
  mineOnly = false,
  onMineOnly,
  scope,
  onScope,
  researchAvailable,
  selectedIds,
  full,
  onAddHit,
  onReadHit,
  onSend,
  onStop,
  macOff = false,
  sessionId,
  onRevert,
  onRetry,
  onOpenDoc,
  onOpenAudit,
  onProposal,
  audit,
  draftKey,
  ai,
  onAiChange,
}: {
  /** Reads the chat only: no message box. */
  readOnly?: boolean;
  messages: ChatMessage[];
  docs: WorkshopDocument[];
  activeDoc: WorkshopDocument | null;
  thinking: boolean;
  aiAvailable: boolean;
  pinned: ContextSnippet[];
  onUnpin: (index: number) => void;
  /** Words you cited (of the piece, or of an AI reply); they go with your next message. */
  quotes?: PieceQuote[];
  onQuote?: (quote: PieceQuote, at?: { x: number; y: number }) => void;
  /** By the quote's id: the chip left the message box. */
  onUnquote?: (id: string) => void;
  /** The pencil on a citation chip: change its comment (the same box as Cite's). */
  onEditQuote?: (id: string, at: { x: number; y: number }) => void;
  /** The session's sources (for the context menu) and what has been pulled so far. */
  sources: Array<{ id: string; handle: string }>;
  loaded: LoadedSource[];
  onResetLoaded: () => void;
  /** Deep research runs before the next message is answered. */
  deep: boolean;
  onDeep: (v: boolean) => void;
  /** "My words only": the AI builds the piece from what you said; the page marks every other word. */
  mineOnly?: boolean;
  onMineOnly?: (v: boolean) => void;
  /** How much the next message may change the piece: Slight / Normal / Rewrite (stays where the author leaves it). */
  scope?: ChangeScope;
  onScope?: (v: ChangeScope | undefined) => void;
  researchAvailable: boolean;
  selectedIds: string[];
  full: boolean;
  onAddHit: (post: InstagramPost) => void;
  onReadHit: (post: InstagramPost) => void;
  /** Resolves true once the server has accepted the message; false leaves the words in the box. */
  /** `quotes`: the citations in the order they stand in the words (⟦1⟧, ⟦2⟧… mark where). */
  onSend: (text: string, pasted?: Array<{ name: string; text: string }>, images?: Array<{ name: string; type: PendingImage["type"]; data: string }>, quotes?: PieceQuote[], files?: Array<{ name: string; type: PendingFile["type"]; data: string }>) => Promise<boolean>;
  /** Stops the reply that is thinking (the send button becomes Stop while the box is empty). */
  onStop: () => void;
  /** Admins: the Mac is off, so the AI providers can't answer until it is back. */
  macOff?: boolean;
  /** For opening a sent message's pasted attachment. */
  sessionId?: string;
  onRevert: (message: ChatMessage) => void;
  onRetry: (message: ChatMessage) => void;
  onOpenDoc: (docId: string) => void;
  onOpenAudit: (message: ChatMessage) => void;
  onProposal: (message: ChatMessage, action: "accept" | "decline", depth?: "quick" | "deep", question?: string) => void;
  audit?: ReactNode;
  /** localStorage key for the unsent draft, so a layout switch, reload or crash never loses it. */
  draftKey: string;
  /** This session's AI pick; the chip shows only when onAiChange is given (admins). */
  ai?: Selection;
  onAiChange?: (ai: Selection | null) => void;
}) {
  const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? "");
  const [contextOpen, setContextOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<ComposerHandle>(null);
  const sending = useRef(false);
  // Cite on the AI's replies: select words, a pill where you let go
  const [cite, setCite] = useState<{ text: string; at: { x: number; y: number } } | null>(null);
  const pickCite = (e: React.MouseEvent) => setCite(citeAt(e));
  // a new citation (from here or a slide) lands as a chip where the caret was, and you're in the box to write about it
  const placed = useRef(new Set<string>());
  useEffect(() => {
    const fresh = quotes.filter((q) => q.id && !placed.current.has(q.id));
    fresh.forEach((q) => placed.current.add(q.id!));
    // quotes from before chips (or restored with the draft) that the words don't hold yet go at the end
    for (const q of fresh) if (!text.includes(`⟦${q.id}⟧`)) inputRef.current?.insertQuote(q.id!);
    if (fresh.length) inputRef.current?.focus();
  }, [quotes]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = messages.find((m) => m.status === "thinking");
  const liveText = live?.text ?? "";
  const liveBlocks = live?.edits?.blockIds?.length ?? 0;
  const liveSteps = live?.steps?.length ?? 0;

  // follow the reply only while the reader is at the bottom; a scroll up to re-read stays put
  const follow = useFollowEnd(() => listRef.current, draftKey, [messages.length, thinking, liveText, liveBlocks, liveSteps]);

  useEffect(() => {
    if (text) localStorage.setItem(draftKey, text);
    else localStorage.removeItem(draftKey);
  }, [draftKey, text]);

  // Big pastes become attachments: a chip above the box, sent whole, never cut.
  const [pasted, setPasted] = useState<Array<{ id: string; name: string; text: string }>>(() => {
    try {
      return JSON.parse(localStorage.getItem(`${draftKey}:pasted`) ?? "[]") as Array<{ id: string; name: string; text: string }>;
    } catch {
      return [];
    }
  });
  const [openPaste, setOpenPaste] = useState<string | null>(null);
  useEffect(() => {
    try {
      if (pasted.length) localStorage.setItem(`${draftKey}:pasted`, JSON.stringify(pasted));
      else localStorage.removeItem(`${draftKey}:pasted`);
    } catch {
      // too big for this browser's storage: the chips stay until reload
    }
  }, [draftKey, pasted]);
  const attachPaste = (t: string) => setPasted((ps) => [...ps, { id: `${Date.now()}-${ps.length}`, name: `Pasted text ${ps.length + 1}`, text: t }]);

  // Pictures: dropped, pasted or picked, in slide order
  const [images, setImages] = useState<PendingImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const pickRef = useRef<HTMLInputElement>(null);
  const attachImages = async (files: File[]) => {
    const pics = inSlideOrder(files.filter((f) => f.type.startsWith("image/")));
    if (!pics.length) return;
    setImageError(null);
    try {
      const shrunk = await Promise.all(pics.map((f) => shrinkImage(f)));
      setImages((im) => [...im, ...shrunk].slice(0, 20));
      inputRef.current?.focus();
    } catch (e) {
      setImageError(e instanceof Error ? e.message : String(e));
    }
  };
  const clipboardImages = (data: DataTransfer | null) => Array.from(data?.files ?? []).filter((f) => f.type.startsWith("image/"));

  // Any file: a picture as above, a text file read here and sent
  // like a big paste, a PDF sent whole for the AI to read, anything else refused in the box.
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const attachFiles = async (files: File[]) => {
    const problems: string[] = [];
    const pics = files.filter((f) => attachKind(f) === "picture");
    if (pics.length) void attachImages(pics);
    for (const f of files) {
      const kind = attachKind(f);
      if (kind === "refused") problems.push(`${f.name} cannot be read: send a picture, a text file or a PDF`);
      else if (kind === "text") {
        const t = await f.text();
        if (t.length > TEXT_ATTACH_MAX) problems.push(`${f.name} is too long to attach`);
        else setPasted((ps) => [...ps, { id: `${Date.now()}-${ps.length}-${Math.random().toString(36).slice(2, 6)}`, name: f.name, text: t }]);
      } else if (kind === "pdf") {
        if (f.size > PDF_MAX_BYTES) problems.push(`${f.name} is over 10 MB`);
        else {
          const data = await fileBase64(f);
          setPendingFiles((fs) => [...fs, { id: `${Date.now()}-${fs.length}-${Math.random().toString(36).slice(2, 6)}`, name: f.name, type: "application/pdf", bytes: f.size, data }]);
        }
      }
    }
    if (problems.length) setImageError(problems.join(". "));
  };

  // A paste with no field focused (a click that missed the box, focus left on a
  // button) lands in the composer instead of nowhere.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = inputRef.current;
      const a = document.activeElement;
      if (!el || (a instanceof HTMLElement && a.closest("input, textarea, select, [contenteditable]"))) return;
      const pics = clipboardImages(e.clipboardData);
      if (pics.length) {
        e.preventDefault();
        void attachImages(pics);
        return;
      }
      const t = e.clipboardData?.getData("text/plain");
      if (!t) return;
      e.preventDefault();
      if (t.length >= PASTE_AS_FILE) {
        attachPaste(t);
        return;
      }
      el.appendText(t);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  // A clock for the "12 s" on the thinking bubble.
  useEffect(() => {
    if (!thinking) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [thinking]);

  const deliver = (o: Queued) => {
    const n = numbered(o.text, o.quotes ?? []);
    return onSend(
      n.text.trim(),
      o.pasted.length ? o.pasted.map(({ name, text: body }) => ({ name, text: body })) : undefined,
      o.images.length ? o.images.map(({ name, type, data }) => ({ name, type, data })) : undefined,
      n.quotes.map(({ id: _id, ...q }) => q),
      o.files?.length ? o.files.map(({ name, type, data }) => ({ name, type, data })) : undefined,
    );
  };
  /** The citations the words hold now. */
  const quotesIn = (value: string) => quotes.filter((q) => q.id && value.includes(`⟦${q.id}⟧`));
  /** Citations no longer in the box leave the page's list (sent, queued, or deleted from the words). */
  const dropQuotesNotIn = (value: string) => quotes.forEach((q) => q.id && !value.includes(`⟦${q.id}⟧`) && onUnquote?.(q.id));

  // The queue: Enter while a reply runs adds the message here; the first one
  // sends when the reply is done. Steer stops the reply and sends that one now; Edit puts it back in the box.
  const [queue, setQueue] = useState<Queued[]>(() => {
    try {
      const q = JSON.parse(localStorage.getItem(`${draftKey}:queue`) ?? "[]") as Queued[];
      return q.map((it) => ({ ...it, images: it.images.map((im) => ({ ...im, url: `data:${im.type};base64,${im.data}` })) }));
    } catch {
      return [];
    }
  });
  // a queued message the server refused stays first and waits for a click (no retry loop)
  const [held, setHeld] = useState(false);
  useEffect(() => {
    try {
      if (queue.length) localStorage.setItem(`${draftKey}:queue`, JSON.stringify(queue.map((it) => ({ ...it, images: it.images.map((im) => ({ ...im, url: "" })) }))));
      else localStorage.removeItem(`${draftKey}:queue`);
    } catch {
      // too big for this browser's storage: the queue stays until reload
    }
  }, [draftKey, queue]);
  useEffect(() => {
    const next = queue[0];
    if (!next || thinking || held || !activeDoc || !aiAvailable || sending.current) return;
    sending.current = true;
    follow();
    void deliver(next)
      .catch(() => false)
      .then((ok) => {
        sending.current = false;
        if (!ok) return setHeld(true);
        next.images.forEach((im) => URL.revokeObjectURL(im.url));
        setQueue((q) => q.filter((x) => x.id !== next.id));
      });
  }, [queue, thinking, held, activeDoc, aiAvailable]);
  const enqueue = () => {
    setQueue((q) => [...q, { id: `${Date.now()}-${q.length}`, text, pasted, images, files: pendingFiles, quotes: quotesIn(text) }]);
    setText("");
    dropQuotesNotIn("");
    setPasted([]);
    setImages([]);
    setPendingFiles([]);
    setOpenPaste(null);
  };
  const steer = (id: string) => {
    setQueue((q) => [...q.filter((x) => x.id === id), ...q.filter((x) => x.id !== id)]);
    setHeld(false);
    if (thinking) onStop();
  };
  const editQueued = (it: Queued) => {
    setQueue((q) => q.filter((x) => x.id !== it.id));
    if (queue[0]?.id === it.id) setHeld(false);
    // its citations come back to the page's list as they were (same ids), already in the words
    (it.quotes ?? []).forEach((q) => {
      placed.current.add(q.id!);
      onQuote?.(q);
    });
    setText((cur) => (cur.trim() ? `${cur}\n\n${it.text}` : it.text));
    setPasted((ps) => [...ps, ...it.pasted]);
    setImages((ims) => [...ims, ...it.images]);
    setPendingFiles((fs) => [...fs, ...(it.files ?? [])]);
    inputRef.current?.focus();
  };
  const unqueue = (it: Queued) => {
    it.images.forEach((im) => URL.revokeObjectURL(im.url));
    setQueue((q) => q.filter((x) => x.id !== it.id));
    if (queue[0]?.id === it.id) setHeld(false);
  };

  // The words leave the box only once the server has them; a refused or failed send keeps them.
  // While a reply runs (or others wait) they join the queue instead.
  const send = async () => {
    const t = text.trim();
    if ((!t && !pasted.length && !images.length && !pendingFiles.length) || !activeDoc || !aiAvailable) return;
    if (thinking || queue.length) return enqueue();
    if (sending.current) return;
    const sentText = text;
    const sentPasted = pasted;
    const sentImages = images;
    const sentFiles = pendingFiles;
    sending.current = true;
    follow();
    try {
      const ok = await deliver({ id: "", text: sentText, pasted: sentPasted, images: sentImages, files: sentFiles, quotes: quotesIn(sentText) });
      if (!ok) return;
      // a word typed while the send was in flight stays in the box
      setText((cur) => (cur === sentText ? "" : cur));
      dropQuotesNotIn(text === sentText ? "" : text);
      const ids = new Set(sentPasted.map((p) => p.id));
      setPasted((ps) => ps.filter((p) => !ids.has(p.id)));
      setOpenPaste((o) => (o && ids.has(o) ? null : o));
      const imageIds = new Set(sentImages.map((im) => im.id));
      sentImages.forEach((im) => URL.revokeObjectURL(im.url));
      setImages((ims) => ims.filter((im) => !imageIds.has(im.id)));
      const fileIds = new Set(sentFiles.map((f) => f.id));
      setPendingFiles((fs) => fs.filter((f) => !fileIds.has(f.id)));
    } finally {
      sending.current = false;
    }
  };
  // Undo puts the question back in the box when the box is empty, so the wording can be changed and sent again.
  const aiChip = onAiChange ? <AiPicker ai={ai} onChange={onAiChange} /> : null;
  const composerBusy = text.trim() !== "" || pasted.length > 0 || images.length > 0 || pendingFiles.length > 0;
  // talking instead of typing: the words go at the end of the box, for you to check before sending
  const v = useChatVoice((said) => {
    setText((t) => (t.trim() ? `${t.trimEnd()} ${said}` : said));
    requestAnimationFrame(() => inputRef.current?.focus());
  });
  const undo = (m: ChatMessage) => {
    onRevert(m);
    const at = messages.indexOf(m);
    const ask = at > 0 && messages[at - 1]!.role === "user" ? messages[at - 1]! : null;
    if (!ask?.text || composerBusy) return;
    // its ⟦1⟧, ⟦2⟧… become chips again
    const ids = (ask.quotes ?? []).map((q, i) => {
      const id = `q${Date.now()}-${i}`;
      placed.current.add(id);
      onQuote?.({ ...q, id });
      return id;
    });
    setText(ask.text.replace(/⟦(\d+)⟧/g, (whole, n: string) => (ids[Number(n) - 1] ? `⟦${ids[Number(n) - 1]}⟧` : whole)));
  };
  // A quote on a block that is gone from every document (deleted, or its slide removed) shows as "gone".
  const pulledCount = loaded.reduce((n, l) => n + l.parts.filter((p) => p !== "slides").length, 0);
  const chip = "flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]";
  const chipIdle = `${chip} border-border bg-background/80 text-muted-foreground hover:bg-muted hover:text-foreground`;
  const chipOn = `${chip} border-foreground/20 bg-muted text-foreground`;
  const fileSize = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent">
      <div
        ref={listRef}
        onMouseUp={onQuote ? pickCite : undefined}
        className="clears-bubble min-h-0 flex-1 overflow-y-scroll px-3 py-2 bars:pr-1"
      >
        {cite && onQuote ? (
          <SelectionPill at={cite.at} onDismiss={() => setCite(null)}>
            <CiteButton onClick={() => {
                onQuote({ from: "reply", text: cite.text }, cite.at);
                window.getSelection()?.removeAllRanges();
                setCite(null);
              }} />
          </SelectionPill>
        ) : null}
        {messages.length === 0 && (
          <p className="py-6 text-center text-[11px] leading-relaxed text-muted-foreground">
            No messages
          </p>
        )}
        <div className="flex flex-col gap-2">
          {/* a reply you stopped (Stop, or Steer) leaves no trace: your message stays, the empty reply goes */}
          {messages.filter((m) => !(m.role === "assistant" && m.status === "error" && m.error === TURN_STOPPED)).map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="ml-2 rounded-2xl bg-muted px-3.5 py-2.5 text-[15px] leading-relaxed text-foreground">
                <p className="whitespace-pre-wrap">{withChips(m.text, m.quotes, activeDoc?.kind)}</p>
                {m.context?.length ? (
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {m.context.map((s, i) => (
                      <li key={i} className="rounded-md bg-background/70 px-2 py-1 text-[11px] text-muted-foreground">
                        <span className="text-muted-foreground">
                          @{s.handle}{s.slide !== undefined ? ` · slide ${s.slide + 1}` : ""} · {CONTEXT_FIELD_LABELS[s.field]}:{" "}
                        </span>
                        <span className="line-clamp-2">{s.text}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {m.images?.length && sessionId ? (
                  <p className="mt-1.5 flex flex-wrap gap-1.5">
                    {m.images.map((im, i) => (
                      <ChatPicture key={im.id} src={imageUrl(sessionId, im.id)} name={im.name} badge={i + 1} className="h-20 w-16" />
                    ))}
                  </p>
                ) : null}
                {m.files?.length ? (
                  <p className="mt-1.5 flex flex-wrap gap-1">
                    {m.files.map((f) => (
                      <span key={f.id} className="flex items-center gap-1 rounded-md border border-border bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground" title={f.name}>
                        <FileText className="h-3 w-3 text-violet-300" /> <span className="max-w-48 truncate text-foreground">{f.name}</span> <span className="tabular-nums">{fileSize(f.bytes)}</span>
                      </span>
                    ))}
                  </p>
                ) : null}
                {m.pasted?.length ? (
                  <p className="mt-1.5 flex flex-wrap gap-1">
                    {m.pasted.map((p) =>
                      sessionId ? (
                        <a key={p.id} href={pastedUrl(sessionId, p.id)} target="_blank" rel="noreferrer" className="flex w-28 flex-col gap-0.5 rounded-lg border border-border bg-background/70 p-2 text-[10px] text-muted-foreground hover:border-foreground/30 hover:text-foreground" title="Open the pasted text">
                          <FileText className="h-4 w-4 text-violet-300" />
                          <span className="truncate font-medium text-foreground">{p.name}</span>
                          <span className="tabular-nums">{p.chars.toLocaleString("en-US")} characters</span>
                        </a>
                      ) : (
                        <span key={p.id} className="flex items-center gap-1 rounded-md bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                          <FileText className="h-3 w-3" /> {p.name}
                        </span>
                      ),
                    )}
                  </p>
                ) : null}
                {m.quotes?.length && !/⟦\d+⟧/.test(m.text) ? (
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {m.quotes.map((q, i) => (
                      <li key={i} className="flex gap-1.5 rounded-md border-l-2 border-violet-400/60 bg-background/50 px-2 py-1 text-[12px]">
                        <Quote className="mt-0.5 h-3 w-3 shrink-0 text-violet-300" />
                        <span className="min-w-0">
                          <span className="line-clamp-2 text-muted-foreground">
                            {quoteWhere(q, activeDoc?.kind)}“{q.text}”
                          </span>
                          {q.comment ? <span className="mt-0.5 block text-foreground">{q.comment}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {m.deep || m.comments || m.mine || m.scope ? (
                  <p className="mt-1 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                    {m.deep && <span>deep research first</span>}
                    {m.comments && <span>with comments</span>}
                    {m.mine && <span>my words only</span>}
                    {m.scope && <span>{m.scope === "slight" ? "slight changes" : "rewrite"}</span>}
                  </p>
                ) : null}
              </div>
            ) : (
              <div key={m.id} className="mr-8 rounded-2xl px-3 py-2 text-sm leading-relaxed text-foreground">
                {m.status === "thinking" ? (
                  <div className="flex flex-col gap-1.5">
                    {m.text ? (
                      <div>
                        <LiveReply text={m.text} />
                        <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-violet-400 align-middle" />
                      </div>
                    ) : null}
                    {m.steps?.length ? <Steps steps={stepRows(m.steps, now)} working /> : null}
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400" />
                      <span>{m.stage ? STAGE_LABELS[m.stage] : m.audit ? "Starting the audit" : "Starting"}</span>
                      {m.provider ? <span>· {m.provider}</span> : null}
                      {m.edits?.blockIds?.length ? <span>· {countUnits(docs.find((d) => d.id === m.edits?.docId)?.kind ?? activeDoc?.kind ?? "reel", m.edits.blockIds.length)} written</span> : null}
                      <span className="tabular-nums">· {m.steps?.length ? "total " : ""}{durationLabel(now - m.at)}</span>
                      <span className="text-muted-foreground/70">{thinkingHint(m)}</span>
                    </p>
                  </div>
                ) : m.status === "error" ? (
                  <Notice
                    action={
                      !readOnly && <button type="button" onClick={() => onRetry(m)} disabled={thinking} className="-my-0.5 flex shrink-0 items-center gap-1 rounded-md border border-red-400/30 px-2 py-0.5 text-[11px] text-red-100 hover:bg-red-500/15 disabled:opacity-50">
                        <RotateCcw className="h-3 w-3" /> Retry
                      </button>
                    }
                  >
                    {m.error || "Could not write the reply"}
                  </Notice>
                ) : m.audit?.result ? (
                  <AuditOpenRow audit={{ ...m.audit, result: m.audit.result }} onOpen={() => onOpenAudit(m)} />
                ) : (
                  <>
                    {m.review ? (
                      <p className="mb-1 flex items-center gap-1.5 text-[11px] text-violet-300" title="Read from the piece, the audience and the most saved posts only, without this chat">
                        <Eye className="h-3.5 w-3.5" /> A follower's read · {m.provider ?? "Claude Fable (Mac)"} · the piece only
                      </p>
                    ) : null}
                    <div data-cite>
                      <ReplyText text={m.text} />
                    </div>
                    {m.notes?.length ? (
                      <ul className="mt-1 flex flex-col gap-0.5 text-[12px] leading-snug text-muted-foreground">
                        {m.notes.map((n, i) => (
                          <li key={i}>{n}</li>
                        ))}
                      </ul>
                    ) : null}
                    {m.steps?.length ? <Steps steps={stepRows(m.steps, now)} took={tookOf(m.steps)} /> : null}
                    {m.fetched?.length ? (
                      <p className="mt-1.5 text-[11px] text-violet-200/80">
                        Loaded: {m.fetched.map((f) => (f.parts.length ? `@${f.handle} ${f.parts.map((p) => PART_LABELS[p]).join(" + ")}` : f.handle)).join(" · ")}
                      </p>
                    ) : null}
                    {m.hits?.length ? (
                      <div className="mt-2 flex flex-col gap-1.5">
                        {m.hits.map((h) => (
                          <SourceResultCard key={h.post.id} hit={h} selected={selectedIds.includes(h.post.id)} full={full} onToggle={() => onAddHit(h.post)} onRead={() => onReadHit(h.post)} />
                        ))}
                      </div>
                    ) : null}
                    {m.research?.answer ? <ResearchCard research={m.research} /> : null}
                    {m.proposal && !readOnly ? <ProposalRow proposal={m.proposal} busy={thinking} onRespond={(action, depth, question) => onProposal(m, action, depth, question)} /> : null}
                    {m.flags?.length ? (
                      <p className="mt-1.5 text-[11px] text-amber-300/90" title="Rules the edited piece may break; nothing was blocked.">
                        May break: {m.flags.map((f) => `${f.name} (${Math.round(f.p * 100)}%)`).join(" · ")}
                      </p>
                    ) : null}
                    <TurnMeta m={m} thinking={thinking} docs={docs} onOpenDoc={onOpenDoc} readOnly={readOnly} onRevert={undo} composerBusy={composerBusy} sessionId={sessionId} />
                  </>
                )}
              </div>
            ),
          )}
        </div>
      </div>
      <div
        // where this stands in the window's bottom right corner, the assistant's bubble sits above it (dock-place.ts)
        ref={cornerTaken}
        className={`shrink-0 px-3 pb-3 pt-1 ${dropping ? "rounded-xl outline-dashed outline-2 outline-violet-500/70" : ""}`}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer.types).includes("Files")) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDropping(false);
          void attachFiles(Array.from(e.dataTransfer.files));
        }}
      >
        {images.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-2">
            {images.map((im, i) => (
              <div key={im.id} className="group relative" title={im.name}>
                <img src={im.url} alt={im.name} className="h-24 w-20 rounded-lg border border-border object-cover" />
                <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] tabular-nums text-white">{i + 1}</span>
                <button
                  type="button"
                  onClick={() => {
                    URL.revokeObjectURL(im.url);
                    setImages((all) => all.filter((x) => x.id !== im.id));
                  }}
                  className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                  aria-label={`Remove ${im.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {queue.length > 0 && (
          <ul className="mb-1.5 flex flex-col gap-1">
            {queue.map((it, i) => {
              const words = readable(it.text, it.quotes ?? []);
              const extra = [it.images.length ? `${it.images.length} picture${it.images.length === 1 ? "" : "s"}` : "", ...it.pasted.map((p) => p.name), ...(it.files ?? []).map((f) => f.name)].filter(Boolean).join(", ");
              return <QueuedRow key={it.id} text={words} extra={extra} held={i === 0 && held} thinking={thinking} onSteer={() => steer(it.id)} onEdit={() => editQueued(it)} onRemove={() => unqueue(it)} />;
            })}
          </ul>
        )}
        {!aiAvailable ? <Notice tone="warn" className="mb-2">Needs an AI provider</Notice> : null}
        {macOff && aiAvailable ? <Notice tone="warn" className="mb-2">Computer offline: replies are written when it is online</Notice> : null}
        {imageError ? <Notice className="mb-2" onDismiss={() => setImageError(null)}>{imageError}</Notice> : null}
        {pasted.length > 0 && (
          // a paste is a file, so it looks like one
          <div className="mb-1.5">
            <div className="flex flex-wrap gap-2">
              {pasted.map((p) => (
                <div key={p.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => setOpenPaste((o) => (o === p.id ? null : p.id))}
                    className={`flex h-24 w-28 flex-col gap-1 overflow-hidden rounded-lg border bg-muted p-2 text-left hover:border-foreground/30 ${openPaste === p.id ? "border-violet-500/60" : "border-border"}`}
                    title="Open the pasted text"
                  >
                    <span className="flex items-center gap-1 text-[10px] font-medium text-foreground">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-violet-300" />
                      <span className="truncate">{p.name}</span>
                    </span>
                    <span className="line-clamp-3 whitespace-pre-line text-[9px] leading-snug text-muted-foreground">{p.text.trim().slice(0, 200)}</span>
                    <span className="mt-auto text-[9px] tabular-nums text-muted-foreground/80">{p.text.length.toLocaleString("en-US")} characters</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPasted((ps) => ps.filter((x) => x.id !== p.id));
                      if (openPaste === p.id) setOpenPaste(null);
                    }}
                    className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 text-muted-foreground opacity-0 shadow hover:text-foreground group-hover:opacity-100"
                    title="Remove pasted text"
                    aria-label={`Remove ${p.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
            {openPaste ? (
              <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background/70 p-2 font-sans text-[11px] text-muted-foreground">{pasted.find((p) => p.id === openPaste)?.text}</pre>
            ) : null}
          </div>
        )}
        {pendingFiles.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-2">
            {pendingFiles.map((f) => (
              <div key={f.id} className="group relative flex items-center gap-1.5 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-[11px] text-foreground" title={f.name}>
                <FileText className="h-3.5 w-3.5 shrink-0 text-violet-300" />
                <span className="max-w-48 truncate">{f.name}</span>
                <span className="tabular-nums text-muted-foreground">{fileSize(f.bytes)}</span>
                <button
                  type="button"
                  onClick={() => setPendingFiles((fs) => fs.filter((x) => x.id !== f.id))}
                  className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 text-muted-foreground opacity-0 shadow hover:text-foreground group-hover:opacity-100"
                  aria-label={`Remove ${f.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {pinned.length > 0 && (
          <ul className="mb-1.5 flex flex-col gap-1">
            {pinned.map((s, i) => (
              <li key={i} className="flex items-start gap-2 rounded-md bg-muted px-2 py-1 text-[11px] text-foreground">
                <span className="min-w-0 flex-1">
                  <span className="text-muted-foreground">
                    @{s.handle}{s.slide !== undefined ? ` · slide ${s.slide + 1}` : ""} · {CONTEXT_FIELD_LABELS[s.field]}:{" "}
                  </span>
                  <span className="line-clamp-2">{s.text}</span>
                </span>
                <button type="button" onClick={() => onUnpin(i)} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground" title="Remove from context">
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <VoiceError v={v} />
        {!readOnly && <div
          className={cn(boxClass(v.recording), "cursor-text pl-1.5")}
          onKeyDown={(e) => v.recording && e.key === "Escape" && v.voice.cancel()}
          onMouseDown={(e) => {
            // The box is bigger than the text field: a click on its padding puts you in it too.
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          {v.recording || v.writing ? <VoiceStatus v={v} /> : <ChipComposer
            ref={inputRef}
            value={text}
            onChange={setText}
            quotes={quotes}
            disabled={!aiAvailable}
            placeholder={activeDoc ? "Message" : "Pick a piece first"}
            onEnter={() => void send()}
            onPasteFirst={(e) => {
              const pics = clipboardImages(e.clipboardData);
              if (pics.length) {
                e.preventDefault();
                void attachImages(pics);
                return true;
              }
              const t = e.clipboardData.getData("text/plain");
              if (t.length >= PASTE_AS_FILE) {
                e.preventDefault();
                attachPaste(t);
                return true;
              }
              return false;
            }}
            onEditQuote={(id, at) => onEditQuote?.(id, at)}
            onRemoveQuote={(id) => onUnquote?.(id)}
            onAddQuote={(q) => onQuote?.(q)}
          />}
          {v.recording ? <VoiceDone v={v} /> : <>
          <button type="button" onClick={() => pickRef.current?.click()} className={cn(ICON_BTN, "text-muted-foreground hover:bg-muted hover:text-foreground")} title="Attach pictures, text files or PDFs" aria-label="Attach files">
            <Paperclip className="h-4 w-4" />
          </button>
          <MicButton v={v} />
          {aiChip}
          {/* While a reply thinks: Stop when the box is empty; Queue when there are words to send after it */}
          <SendButton empty={!composerBusy} waiting={thinking} disabled={!activeDoc || !aiAvailable || v.writing} onSend={() => void send()} onStop={onStop} />
          </>}
        </div>}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <input
            ref={pickRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void attachFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <span className="relative">
            <button type="button" onClick={() => setContextOpen((o) => !o)} className={contextOpen ? chipOn : chipIdle} title="Context" aria-expanded={contextOpen}>
              <Plus className="h-3.5 w-3.5" /> Context{sources.length ? ` · ${sources.length} source${sources.length === 1 ? "" : "s"}` : ""}{pulledCount ? ` · ${pulledCount} loaded` : ""}
            </button>
            {contextOpen && (
              <span className="absolute bottom-full left-0 z-30 mb-1 flex w-80 flex-col gap-1.5 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl">
                <span className="text-[10px] text-muted-foreground">In context</span>
                {sources.length === 0 ? <span className="text-[11px] text-muted-foreground">No sources</span> : null}
                {sources.map((src) => {
                  const parts = loaded.find((l) => l.postId === src.id)?.parts ?? [];
                  return (
                    <span key={src.id} className="text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">@{src.handle}</span> — on-screen text{parts.filter((p) => p !== "slides").length ? `, ${parts.filter((p) => p !== "slides").map((p) => PART_LABELS[p]).join(", ")}` : ""}
                    </span>
                  );
                })}
                <span className="text-[10px] leading-relaxed text-muted-foreground">
                  On-screen text is always included; transcripts and comments are loaded when a message asks for them.
                </span>
                {pulledCount ? (
                  <button type="button" onClick={() => { onResetLoaded(); setContextOpen(false); }} className="self-start rounded-md border border-border px-2 py-0.5 text-[11px] text-foreground hover:bg-muted">
                    Clear loaded text
                  </button>
                ) : null}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => (deep ? onDeep(false) : void confirmHeavy("research").then((go) => go && onDeep(true)))}
            disabled={!researchAvailable}
            className={`${chip} ${deep ? "border-violet-500/60 bg-violet-500/20 text-violet-950 dark:text-violet-100" : chipIdle} disabled:opacity-50`}
            title={researchAvailable ? "5–15 minutes of web research before the reply, for the next message only." : "Needs an AI provider that can search the web or a Perplexity key"}
            aria-pressed={deep}
          >
            <Telescope className="h-3.5 w-3.5" /> Deep research{deep ? " on" : ""}
          </button>
          {onMineOnly ? (
            <button
              type="button"
              onClick={() => onMineOnly(!mineOnly)}
              className={`${chip} ${mineOnly ? "border-amber-500/60 bg-amber-500/20 text-amber-950 dark:text-amber-100" : chipIdle}`}
              title="The piece is cut from your own sentences only; every word that is not yours is marked."
              aria-pressed={mineOnly}
            >
              <Mic className="h-3.5 w-3.5" /> My words only{mineOnly ? " on" : ""}
            </button>
          ) : null}
          {onScope ? (
            <span
              role="radiogroup"
              aria-label="Amount of change"
              title="The part of the piece the next message may change."
              className="flex items-center rounded-md border border-border bg-background/80 p-0.5 text-[11px]"
            >
              {([["slight", "Slight"], [undefined, "Normal"], ["rewrite", "Rewrite"]] as const).map(([v, label]) => (
                <button
                  key={label}
                  type="button"
                  role="radio"
                  aria-checked={scope === v}
                  onClick={() => onScope(v)}
                  className={`rounded px-2 py-0.5 ${scope === v ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {label}
                </button>
              ))}
            </span>
          ) : null}
          {audit}
          {messages.some((m) => m.text.trim()) ? (
            <CopyButton text={() => chatText(messages)} title="Copy chat" className={`${chipIdle} ml-auto py-1.5`} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The reply as it is written, typed out smoothly: the text arrives in pieces, and the
 * page shows it a few characters a frame, faster the further behind it is, so a piece never lands as a block.
 */
function LiveReply({ text }: { text: string }) {
  const [shown, setShown] = useState(0);
  const target = useRef(text);
  target.current = text;
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setShown((n) => {
        const want = target.current.length;
        if (n > want) return want; // the text was replaced (a retry), not extended
        return n === want ? n : Math.min(want, n + Math.max(2, Math.ceil((want - n) / 12)));
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <ReplyText text={text.slice(0, shown)} />;
}

/** A sent message's words with its ⟦1⟧, ⟦2⟧… as the citation chips they were (the comment on hover). */
function withChips(text: string, quotes: PieceQuote[] | undefined, kind?: WorkshopDocument["kind"]): ReactNode {
  if (!quotes?.length || !/⟦\d+⟧/.test(text)) return text;
  return text.split(/(⟦\d+⟧)/).map((part, i) => {
    const q = /^⟦(\d+)⟧$/.test(part) ? quotes[Number(part.slice(1, -1)) - 1] : undefined;
    if (!q) return part;
    return (
      <span
        key={i}
        title={`${quoteWhere(q, kind)}“${q.text}”${q.comment ? `\n\nYour comment: ${q.comment}` : ""}`}
        className="mx-0.5 inline-flex max-w-[16rem] items-center gap-1 rounded-md border border-violet-400/40 bg-violet-500/10 px-1.5 py-px align-[-2px] text-[12px] leading-5"
      >
        <Quote className="h-3 w-3 shrink-0 text-violet-300" />
        <span className="truncate">{q.text}</span>
        {q.comment ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-300" /> : null}
      </span>
    );
  });
}

/** Where a citation is from, for its chip's tooltip. */
function quoteWhere(q: PieceQuote, kind?: WorkshopDocument["kind"]): string {
  if (q.from === "reply") return "From the AI's reply: ";
  if (q.field === "caption") return "Post description: ";
  if (q.field === "pinned") return "Pinned comment: ";
  if (q.field === "hook") return "Hook: ";
  if (q.field === "script") return "Script: ";
  return q.slide !== undefined ? `${kind === "carousel" ? "Slide" : "Part"} ${q.slide + 1}: ` : "";
}

/** A message waiting in the queue: the box's words, pastes and pictures as they were. */
type Queued = { id: string; text: string; pasted: Array<{ id: string; name: string; text: string }>; images: PendingImage[]; files?: PendingFile[]; quotes?: PieceQuote[] };

/** The conversation as plain text, to paste into another AI. */
function chatText(messages: ChatMessage[]): string {
  return messages
    .flatMap((m) => {
      const t = [m.text.trim(), m.research?.answer?.trim()].filter(Boolean).join("\n\n");
      return t && m.status !== "thinking" ? [`${m.role === "user" ? "Me" : "AI"}:\n${t}`] : [];
    })
    .join("\n\n");
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** Provider tag plus what this turn did to the document, if it did anything. */
function TurnMeta({
  m,
  thinking,
  docs,
  onOpenDoc,
  onRevert,
  readOnly,
  composerBusy,
  sessionId,
}: {
  readOnly?: boolean;
  m: ChatMessage;
  thinking: boolean;
  docs: WorkshopDocument[];
  onOpenDoc: (docId: string) => void;
  onRevert: (message: ChatMessage) => void;
  composerBusy: boolean;
  sessionId?: string;
}) {
  const [showChanged, setShowChanged] = useState(false);
  const change = turnDocChange(m);
  if (!(m.provider && !m.audit) && !change) return null;
  const doc = change && "docId" in change ? docs.find((d) => d.id === change.docId) : undefined;
  const title = doc ? docTabLabel(doc) : "a piece";
  const kind = doc?.kind ?? "reel";
  // "What changed" needs the text from before the turn, so it opens only when that version was kept
  const compare = change?.kind === "edited" && change.versionBefore && sessionId && doc && m.edits?.blockIds?.length ? m.edits : null;
  return (
    <>
      <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        {m.provider && !m.audit ? (
          <span
            className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground"
            title={m.usage ? `This reply: ${(m.usage.tokens / 1000).toFixed(1)}k tokens · $${m.usage.costUsd.toFixed(2)} API-equivalent` : undefined}
          >
            {m.provider}
          </span>
        ) : null}
        {change?.kind === "reverted" ? (
          <span>Restored {change.version}</span>
        ) : change?.kind === "created" ? (
          <button type="button" onClick={() => onOpenDoc(change.docId)} className="text-violet-600 hover:underline dark:text-violet-300">
            Created “{title}” ({countUnits(kind, change.blocks)}) · Open
          </button>
        ) : change?.kind === "edited" && compare ? (
          <button
            type="button"
            onClick={() => setShowChanged((o) => !o)}
            aria-expanded={showChanged}
            className="text-left underline decoration-dotted underline-offset-2 hover:text-foreground"
            title="Show what changed"
          >
            {showChanged ? "▾" : "▸"} Edited {editSummary(kind, m.edits?.blockIds ?? [])} in “{title}”
          </button>
        ) : change?.kind === "edited" ? (
          <span>
            Edited {editSummary(kind, m.edits?.blockIds ?? [])} in “{title}”
          </span>
        ) : null}
        {change?.kind === "edited" && change.versionBefore && !readOnly ? (
          <button
            type="button"
            onClick={() => onRevert(m)}
            disabled={thinking}
            className="text-muted-foreground/50 hover:text-foreground disabled:opacity-40"
            title={
              composerBusy
                ? `Restores the text from before this reply (${change.versionBefore})`
                : `Restores the text from before this reply (${change.versionBefore}) and puts the message back in the box`
            }
          >
            Undo
          </button>
        ) : null}
      </p>
      {showChanged && compare && doc && sessionId ? <WhatChanged sessionId={sessionId} doc={doc} edits={compare} /> : null}
    </>
  );
}

/** What a turn did, step by step with its own time: live while it works, one line (open for the list) when done. */

/** What the AI checked on the web, with the pages it read. */
function ResearchCard({ research }: { research: NonNullable<ChatMessage["research"]> }) {
  return (
    <div className="mt-2 rounded-lg border border-violet-500/25 bg-violet-500/10 px-2.5 py-2">
      <p className="flex items-center gap-1.5 text-[11px] text-violet-200">
        <Globe className="h-3.5 w-3.5" /> {research.depth === "deep" ? "Deep research" : "Web search"} · {research.question}
      </p>
      <div className="mt-1 text-[12px] text-zinc-200">
        <MarkdownBody source={research.answer ?? ""} media={false} />
      </div>
      {research.citations?.length ? (
        <p className="mt-1.5 flex flex-wrap gap-1">
          {research.citations.slice(0, 10).map((u, i) => (
            <a key={u} href={u} target="_blank" rel="noreferrer" className="flex items-center gap-0.5 rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] text-violet-200 hover:bg-zinc-700" title={u}>
              <ExternalLink className="h-2.5 w-2.5" /> [{i + 1}] {host(u)}
            </a>
          ))}
        </p>
      ) : null}
    </div>
  );
}

/** The AI wants to run something slow; the author says yes or no. */
/**
 * Something slow the AI wants to run, asked first. A web search never starts on its own: the question can be edited, run quick or deep, or skipped.
 */
function ProposalRow({
  proposal,
  busy,
  onRespond,
}: {
  proposal: NonNullable<ChatMessage["proposal"]>;
  busy: boolean;
  onRespond: (action: "accept" | "decline", depth?: "quick" | "deep", question?: string) => void;
}) {
  const [question, setQuestion] = useState(proposal.question ?? "");
  if (proposal.status !== "open") {
    return (
      <p className="mt-2 text-[11px] text-zinc-500">
        {proposal.kind === "audit" ? "Accuracy audit" : proposal.depth === "deep" ? "Deep research" : "Web search"}
        {proposal.kind === "research" && proposal.question ? ` · “${proposal.question}”` : ""} — {proposal.status === "accepted" ? "accepted" : "skipped"}
      </p>
    );
  }
  const btn = "rounded-md px-2 py-1 text-[11px] font-medium disabled:opacity-50";
  const q = question.trim();
  return (
    <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2">
      {proposal.kind === "audit" ? (
        <p className="flex items-center gap-1.5 text-[12px] text-amber-100">
          <ShieldCheck className="h-3.5 w-3.5" /> Accuracy audit of the whole piece, claim by claim
        </p>
      ) : (
        <>
          <p className="flex items-center gap-1.5 text-[12px] text-amber-100">
            <Globe className="h-3.5 w-3.5" /> Web search for
          </p>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={2}
            className="mt-1 w-full resize-none rounded bg-background/70 px-2 py-1 text-[12px] text-foreground outline-none"
            aria-label="Search question"
          />
        </>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <button type="button" disabled={busy || (proposal.kind === "research" && !q)} onClick={() => onRespond("accept", "quick", proposal.kind === "research" ? q : undefined)} className={`${btn} bg-amber-500 text-black hover:bg-amber-400`}>
          {proposal.kind === "audit" ? "Quick check" : "Search"} · ~1 min
        </button>
        <button type="button" disabled={busy || (proposal.kind === "research" && !q)} onClick={() => onRespond("accept", "deep", proposal.kind === "research" ? q : undefined)} className={`${btn} border border-amber-500/50 text-amber-100 hover:bg-amber-500/20`}>
          Deep research · 5–15 min
        </button>
        <button type="button" disabled={busy} onClick={() => onRespond("decline")} className={`${btn} text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200`}>
          Skip
        </button>
      </div>
    </div>
  );
}

