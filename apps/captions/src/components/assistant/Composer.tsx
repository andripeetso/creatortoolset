import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Camera, FileText, Film, Folder, Loader2, Paperclip, Quote, X } from "lucide-react";
import { ICON_BTN, MicButton, SendButton, VoiceDone, VoiceError, VoiceStatus, boxClass, useChatVoice } from "@/components/chat/MessageBox";
import { attachScreen } from "@/lib/assistant";
import { canSnapshot } from "@/lib/page-context";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MAX_PICTURES, draftEmpty, filesPending, folderName, lineCount, type Draft } from "./draft";
import { cn } from "@/lib/utils";

const MAX_ROWS_PX = 160;

/**
 * The assistant's message box: one rounded bar with the paperclip, mic and send inside, and above it what goes
 * with the message (the highlighted text it asks about, pictures, long pastes as file chips). Enter sends,
 * Shift+Enter is a new line; while a reply runs, Enter queues it (the dock) and an empty box offers Stop. The mic
 * records, shows your voice as moving bars, and puts the words in the box for you to check. The draft is the
 * dock's (Edit on a queued message puts it back here; a picture dropped on the chat lands here too).
 */
export function Composer({
  draft,
  setDraft,
  onSend,
  onStop,
  onFiles,
  onRemoveFile,
  onPaste,
  quote,
  onDropQuote,
  waiting,
  autoFocus,
  aiPicker,
}: {
  draft: Draft;
  setDraft: (d: Draft | ((cur: Draft) => Draft)) => void;
  onSend: (draft: Draft) => void;
  onStop: () => void;
  /** Picked files (the paperclip): the dock shrinks and adds them. */
  onFiles: (files: File[]) => void;
  /** A video chip's X: the dock stops its upload and deletes what reached the server. */
  onRemoveFile?: (file: Draft["files"][number]) => void;
  /** A paste the dock takes as pictures or a file chip; true = taken, so it doesn't go in the box. */
  onPaste: (data: DataTransfer) => boolean;
  quote: string | null;
  onDropQuote: () => void;
  waiting: boolean;
  autoFocus?: boolean;
  /** The AI button (AiPicker), before send. */
  aiPicker?: ReactNode;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  const [openPaste, setOpenPaste] = useState<number | null>(null);
  const [bigPicture, setBigPicture] = useState<string | null>(null);
  const [shooting, setShooting] = useState(false);
  const [shotFailed, setShotFailed] = useState(false);
  const { text } = draft;
  const setText = (t: string) => setDraft((d) => ({ ...d, text: t }));
  const v = useChatVoice((said) => {
    setDraft((d) => ({ ...d, text: d.text.trim() ? `${d.text.trimEnd()} ${said}` : said }));
    requestAnimationFrame(() => box.current?.focus());
  });
  const { voice, recording, writing } = v;

  // the box grows with what you write, up to a few lines
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  }, [text, voice.phase]);

  // and a new quote (Cite, Ask assistant) puts you in the box to write about it
  useEffect(() => {
    if (autoFocus || quote) box.current?.focus();
  }, [autoFocus, quote]);

  const empty = draftEmpty(draft);
  const uploading = filesPending(draft);
  const send = () => {
    if (empty || uploading) return;
    onSend({ ...draft, text: text.trim() });
    setOpenPaste(null);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const iconBtn = ICON_BTN;
  const chipX =
    "absolute -top-1.5 -right-1.5 rounded-full border bg-background p-0.5 text-muted-foreground opacity-0 shadow-sm hover:text-foreground focus-visible:opacity-100 group-hover/chip:opacity-100 [@media(hover:none)]:opacity-100";

  return (
    <div className="space-y-1.5">
      {shotFailed && (
        <p role="alert" className="flex items-center gap-2 px-1 text-xs text-destructive motion-safe:animate-in motion-safe:fade-in">
          <span className="min-w-0 flex-1 truncate">Could not take a screenshot</span>
          <button type="button" onClick={() => setShotFailed(false)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
            <X className="size-3.5" />
          </button>
        </p>
      )}
      <VoiceError v={v} />

      {quote && (
        <div className="flex items-start gap-2 rounded-xl border bg-muted/60 px-3 py-1.5 text-xs motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1">
          <Quote className="mt-0.5 size-3 shrink-0 text-[var(--tint)]" aria-hidden />
          <span className="min-w-0 flex-1 line-clamp-2 text-muted-foreground" title={quote}>
            About: «{quote}»
          </span>
          <button type="button" onClick={onDropQuote} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground" aria-label="Remove quote" title="Remove quote">
            <X className="size-3" />
          </button>
        </div>
      )}

      {(draft.images.length > 0 || draft.pasted.length > 0 || draft.files.length > 0 || draft.folders.length > 0) && (
        <div className="flex flex-wrap gap-2 px-1 pt-1.5">
          {/* a folder dropped in the Mac app: its path goes with the message */}
          {draft.folders.map((p) => (
            <div key={p} className="group/chip relative motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95" title={p}>
              <div className="flex h-14 max-w-52 items-center gap-1.5 rounded-lg border bg-muted px-2.5 text-[11px]">
                <Folder className="size-4 shrink-0 text-[var(--tint)]" aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{folderName(p)}</span>
                  <span className="block text-muted-foreground">Folder</span>
                </span>
              </div>
              <button type="button" onClick={() => setDraft((d) => ({ ...d, folders: d.folders.filter((x) => x !== p) }))} className={chipX} aria-label={`Remove ${folderName(p)}`}>
                <X className="size-3" />
              </button>
            </div>
          ))}
          {draft.files.map((f) => (
            <div key={f.key} className="group/chip relative motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95" title={f.error ?? f.name}>
              <div className={cn("flex h-14 max-w-52 items-center gap-1.5 rounded-lg border bg-muted px-2.5 text-[11px]", f.error && "border-destructive/60")}>
                {f.id || f.path || f.error ? <Film className="size-4 shrink-0 text-[var(--tint)]" aria-hidden /> : <Loader2 className="size-4 shrink-0 animate-spin text-[var(--tint)]" aria-hidden />}
                <span className="min-w-0">
                  <span className="block truncate font-medium">{f.name}</span>
                  <span className={cn("block tabular-nums", f.error ? "text-destructive" : "text-muted-foreground")}>
                    {f.error ? "Could not upload: remove it and add it again" : f.path ? "On this Mac" : f.done ? "Uploaded" : `Uploading · ${f.pct}%`}
                  </span>
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  onRemoveFile?.(f);
                  setDraft((d) => ({ ...d, files: d.files.filter((x) => x.key !== f.key) }));
                }}
                className={chipX}
                aria-label={`Remove ${f.name}`}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          {draft.images.map((im, i) => (
            <div key={i} className="group/chip relative motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95" title={im.name}>
              <button type="button" onClick={() => setBigPicture(`data:${im.type};base64,${im.data}`)} aria-label={`Show ${im.name}`}>
                <img src={`data:${im.type};base64,${im.data}`} alt={im.name} className="size-14 rounded-lg border object-cover" />
              </button>
              <button type="button" onClick={() => setDraft((d) => ({ ...d, images: d.images.filter((_, j) => j !== i) }))} className={chipX} aria-label={`Remove ${im.name}`}>
                <X className="size-3" />
              </button>
            </div>
          ))}
          {draft.pasted.map((p, i) => (
            <div key={`p${i}`} className="group/chip relative motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95">
              <button
                type="button"
                onClick={() => setOpenPaste((o) => (o === i ? null : i))}
                className={cn(
                  "flex h-14 items-center gap-1.5 rounded-lg border bg-muted px-2.5 text-left text-[11px] hover:border-foreground/30",
                  openPaste === i && "border-[color-mix(in_srgb,var(--tint)_60%,transparent)]",
                )}
                title="Show text"
              >
                <FileText className="size-4 shrink-0 text-[var(--tint)]" aria-hidden />
                <span>
                  <span className="block font-medium">{p.name}</span>
                  <span className="block text-muted-foreground tabular-nums">{lineCount(p.text).toLocaleString("en-US")} lines</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft((d) => ({ ...d, pasted: d.pasted.filter((_, j) => j !== i) }));
                  setOpenPaste(null);
                }}
                className={chipX}
                aria-label={`Remove ${p.name}`}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {openPaste !== null && draft.pasted[openPaste] && (
        <pre className="max-h-40 overflow-auto rounded-lg border bg-muted/60 p-2 font-sans text-[11px] whitespace-pre-wrap text-muted-foreground">{draft.pasted[openPaste].text}</pre>
      )}

      <div
        className={boxClass(recording)}
        onKeyDown={(e) => recording && e.key === "Escape" && voice.cancel()}
      >
        {recording || writing ? (
          <VoiceStatus v={v} />
        ) : (
          <textarea
            ref={box}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            onPaste={(e) => onPaste(e.clipboardData) && e.preventDefault()}
            placeholder="Message"
            aria-label="Message the assistant"
            className="max-h-40 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-sm leading-5 outline-none placeholder:text-muted-foreground/70"
          />
        )}

        {recording ? (
          <VoiceDone v={v} />
        ) : (
          <>
            <input
              ref={pick}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,video/*,audio/*"
              multiple
              hidden
              onChange={(e) => {
                onFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            {/* one attach button; in the Mac app it also offers a picture of this screen (the open chat is in it too) */}
            {canSnapshot() ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={writing || shooting || draft.images.length >= MAX_PICTURES}
                    className={cn(iconBtn, "text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40")}
                    aria-label="Attach"
                    title="Attach"
                  >
                    {shooting ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="end">
                  <DropdownMenuItem onSelect={() => pick.current?.click()}>
                    <Paperclip /> Files
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      setShooting(true);
                      void attachScreen()
                        .then((ok) => !ok && setShotFailed(true))
                        .finally(() => setShooting(false));
                    }}
                  >
                    <Camera /> This screen
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <button
                type="button"
                onClick={() => pick.current?.click()}
                disabled={writing || draft.images.length >= MAX_PICTURES}
                className={cn(iconBtn, "text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40")}
                aria-label="Attach"
                title="Attach"
              >
                <Paperclip className="size-4" />
              </button>
            )}
            <MicButton v={v} />
            {aiPicker}
            <SendButton empty={empty} waiting={waiting} blocked={uploading ? "Uploading the video" : undefined} disabled={writing} onSend={send} onStop={onStop} />
          </>
        )}
      </div>
      {bigPicture && <PictureOverlay src={bigPicture} onClose={() => setBigPicture(null)} />}
    </div>
  );
}

/** A picture at full size over everything; a click or Esc closes it. Portalled: the chat card clips and moves. */
export function PictureOverlay({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div
      role="dialog"
      aria-label="Picture"
      onClick={onClose}
      className="fixed inset-0 z-[60] flex cursor-zoom-out items-center justify-center bg-black/80 p-6 motion-safe:animate-in motion-safe:fade-in"
    >
      <img src={src} alt="" className="max-h-full max-w-full rounded-lg shadow-2xl" />
      <button type="button" onClick={onClose} className="absolute top-4 right-4 rounded-full bg-black/60 p-2 text-white hover:bg-black/80" aria-label="Close">
        <X className="size-5" />
      </button>
    </div>,
    document.body,
  );
}
