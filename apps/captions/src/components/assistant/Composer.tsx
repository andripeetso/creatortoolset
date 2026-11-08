import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { ArrowUp, Check, Loader2, Mic, Square, X } from "lucide-react";
import { BARS, useVoiceInput } from "@/lib/voice-input";
import { cn } from "@/lib/utils";

const MAX_ROWS_PX = 160;

/**
 * The assistant's message box: one rounded bar with the mic and send inside. Enter sends, Shift+Enter is a new
 * line; while a reply runs, Enter queues it (the dock) and an empty box offers Stop. The mic records, shows your
 * voice as moving bars, and puts the words in the box for you to check. The words are the dock's (Edit on a
 * queued message puts them back here).
 */
export function Composer({
  text,
  setText,
  onSend,
  onStop,
  waiting,
  autoFocus,
}: {
  text: string;
  setText: (t: string | ((cur: string) => string)) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  waiting: boolean;
  autoFocus?: boolean;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const voice = useVoiceInput((said) => {
    setText((t) => (t.trim() ? `${t.trimEnd()} ${said}` : said));
    requestAnimationFrame(() => box.current?.focus());
  });

  // the box grows with what you write, up to a few lines
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  }, [text, voice.phase]);

  useEffect(() => {
    if (autoFocus) box.current?.focus();
  }, [autoFocus]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const recording = voice.phase === "recording";
  const writing = voice.phase === "writing";
  const iconBtn = "flex size-8 shrink-0 items-center justify-center rounded-full transition-all duration-200 disabled:pointer-events-none";

  return (
    <div className="space-y-1.5">
      {voice.error && (
        <p role="alert" className="flex items-center gap-2 px-1 text-xs text-destructive motion-safe:animate-in motion-safe:fade-in">
          <span className="min-w-0 flex-1 truncate" title={voice.error}>{voice.error}</span>
          <button type="button" onClick={voice.clearError} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
            <X className="size-3.5" />
          </button>
        </p>
      )}
      <div
        className={cn(
          "flex items-end gap-1.5 rounded-[22px] border bg-background p-1.5 pl-3.5 shadow-sm transition-[border-color,box-shadow] duration-200",
          "focus-within:border-[color-mix(in_srgb,var(--tint)_60%,transparent)] focus-within:shadow-[0_0_0_3px] focus-within:shadow-[color:color-mix(in_srgb,var(--tint)_15%,transparent)]",
          recording && "border-[color-mix(in_srgb,var(--tint)_60%,transparent)] shadow-[0_0_0_3px] shadow-[color:color-mix(in_srgb,var(--tint)_15%,transparent)]",
        )}
        onKeyDown={(e) => recording && e.key === "Escape" && voice.cancel()}
      >
        {recording ? (
          <div className="flex h-8 min-w-0 flex-1 items-center gap-2 motion-safe:animate-in motion-safe:fade-in" aria-live="polite">
            <span className="size-2 shrink-0 rounded-full bg-red-500 motion-safe:animate-pulse" aria-hidden />
            <span className="w-9 shrink-0 text-xs tabular-nums text-muted-foreground">
              {Math.floor(voice.seconds / 60)}:{String(voice.seconds % 60).padStart(2, "0")}
            </span>
            <span className="flex h-6 flex-1 items-center justify-end gap-[2px] overflow-hidden" aria-label="Listening">
              {voice.bars.map((b, i) => (
                <span
                  key={i}
                  className="w-[3px] shrink-0 rounded-full bg-[var(--tint)] transition-[height] duration-75"
                  style={{ height: `${Math.max(3, Math.min(24, b * 24))}px`, opacity: 0.35 + (i / BARS) * 0.65 }}
                />
              ))}
            </span>
          </div>
        ) : writing ? (
          <p className="flex h-8 flex-1 items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {voice.progress !== null && voice.progress < 1
              ? `Getting the speech model ready · ${Math.round(voice.progress * 100)}%`
              : "Writing it down…"}
          </p>
        ) : (
          <textarea
            ref={box}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder="Message"
            aria-label="Message the assistant"
            className="max-h-40 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-sm leading-5 outline-none placeholder:text-muted-foreground/70"
          />
        )}

        {recording ? (
          <>
            <button type="button" onClick={voice.cancel} className={cn(iconBtn, "text-muted-foreground hover:bg-muted hover:text-foreground")} aria-label="Cancel" title="Cancel (Esc)">
              <X className="size-4" />
            </button>
            <button type="button" onClick={voice.toggle} className={cn(iconBtn, "bg-[var(--tint)] text-white hover:brightness-110")} aria-label="Done talking" title="Done: write it down">
              <Check className="size-4" />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={voice.toggle}
              disabled={writing}
              className={cn(iconBtn, "text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40")}
              aria-label="Talk instead of typing"
              title="Talk instead of typing"
            >
              <Mic className="size-4" />
            </button>
            {waiting && !text.trim() ? (
              <button type="button" onClick={onStop} className={cn(iconBtn, "bg-foreground text-background hover:opacity-80")} aria-label="Stop the reply" title="Stop">
                <Square className="size-3 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!text.trim() || writing}
                className={cn(iconBtn, text.trim() ? "scale-100 bg-[var(--tint)] text-white hover:brightness-110" : "scale-90 bg-muted text-muted-foreground")}
                aria-label={waiting ? "Queue" : "Send"}
                title={waiting ? "Queue: sends when the reply is done (Enter)" : "Send (Enter)"}
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
