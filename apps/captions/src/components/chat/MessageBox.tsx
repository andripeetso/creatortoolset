import { ArrowUp, Check, Loader2, Mic, Square, X } from "lucide-react";
import { BARS, useVoiceInput } from "@/lib/voice-input";
import { tell, useMicMode } from "@/components/settings/ThisMacSection";
import { cn } from "@/lib/utils";

/** The parts of the message box both chats share: its outline, the mic and what it shows, and Send/Queue/Stop. */

export const ICON_BTN = "flex size-8 shrink-0 items-center justify-center rounded-full transition-all duration-200 disabled:pointer-events-none";
const quietBtn = cn(ICON_BTN, "text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40");

/** The rounded bar the field and its buttons sit in; lit while you type or talk. */
export const boxClass = (lit: boolean) =>
  cn(
    "flex items-end gap-1.5 rounded-[22px] border bg-background p-1.5 pl-3.5 shadow-sm transition-[border-color,box-shadow] duration-200",
    "focus-within:border-[color-mix(in_srgb,var(--tint)_60%,transparent)] focus-within:shadow-[0_0_0_3px] focus-within:shadow-[color:color-mix(in_srgb,var(--tint)_15%,transparent)]",
    lit && "border-[color-mix(in_srgb,var(--tint)_60%,transparent)] shadow-[0_0_0_3px] shadow-[color:color-mix(in_srgb,var(--tint)_15%,transparent)]",
  );

/**
 * Talking instead of typing: `said` gets the words once they are written down. In the Mac app the mic is the way into
 * its own dictation, and gone once that is set up (the talk key types into the box).
 */
export function useChatVoice(said: (words: string) => void) {
  const voice = useVoiceInput(said);
  const { mic, watch } = useMicMode();
  return { voice, mic, watch, recording: voice.phase === "recording", writing: voice.phase === "writing" };
}
type ChatVoice = ReturnType<typeof useChatVoice>;

/** In place of the text field while recording (your voice as moving bars) or writing it down. */
export function VoiceStatus({ v }: { v: ChatVoice }) {
  if (v.recording)
    return (
      <div className="flex h-8 min-w-0 flex-1 items-center gap-2 motion-safe:animate-in motion-safe:fade-in" aria-live="polite">
        <span className="size-2 shrink-0 rounded-full bg-red-500 motion-safe:animate-pulse" aria-hidden />
        <span className="w-9 shrink-0 text-xs tabular-nums text-muted-foreground">
          {Math.floor(v.voice.seconds / 60)}:{String(v.voice.seconds % 60).padStart(2, "0")}
        </span>
        <span className="flex h-6 flex-1 items-center justify-end gap-[2px] overflow-hidden" aria-label="Listening">
          {v.voice.bars.map((b, i) => (
            <span
              key={i}
              className="w-[3px] shrink-0 rounded-full bg-[var(--tint)] transition-[height] duration-75"
              style={{ height: `${Math.max(3, Math.min(24, b * 24))}px`, opacity: 0.35 + (i / BARS) * 0.65 }}
            />
          ))}
        </span>
      </div>
    );
  return (
    <p className="flex h-8 flex-1 items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
      <Loader2 className="size-3.5 animate-spin" aria-hidden />
      {v.voice.progress !== null && v.voice.progress < 1 ? `Loading speech model · ${Math.round(v.voice.progress * 100)}%` : "Transcribing…"}
    </p>
  );
}

/** While recording: Cancel and Done, where the other buttons were. */
export function VoiceDone({ v }: { v: ChatVoice }) {
  return (
    <>
      <button type="button" onClick={v.voice.cancel} className={quietBtn} aria-label="Cancel" title="Cancel (Esc)">
        <X className="size-4" />
      </button>
      <button type="button" onClick={v.voice.toggle} className={cn(ICON_BTN, "bg-[var(--tint)] text-white hover:brightness-110")} aria-label="Transcribe" title="Transcribe">
        <Check className="size-4" />
      </button>
    </>
  );
}

export function MicButton({ v }: { v: ChatVoice }) {
  if (v.mic === "none") return null;
  const label = v.mic === "setup" ? "Set up dictation" : "Dictate";
  return (
    <button
      type="button"
      onClick={
        v.mic === "setup"
          ? () => {
              tell("dictation:guide");
              v.watch();
            }
          : v.voice.toggle
      }
      disabled={v.writing}
      className={quietBtn}
      aria-label={label}
      title={label}
    >
      <Mic className="size-4" />
    </button>
  );
}

/** A voice error over the box, until dismissed. */
export function VoiceError({ v }: { v: ChatVoice }) {
  if (!v.voice.error) return null;
  return (
    <p role="alert" className="flex items-center gap-2 px-1 text-xs text-destructive motion-safe:animate-in motion-safe:fade-in">
      <span className="min-w-0 flex-1 truncate" title={v.voice.error}>
        {v.voice.error}
      </span>
      <button type="button" onClick={v.voice.clearError} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
        <X className="size-3.5" />
      </button>
    </p>
  );
}

/**
 * Send; Queue while a reply is being written (it goes when that is done); Stop when a reply is being written and
 * there is nothing to send. `blocked` says why Send can't go yet (an upload still running), as its hover text.
 */
export function SendButton({ empty, waiting, blocked, disabled, onSend, onStop }: { empty: boolean; waiting: boolean; blocked?: string; disabled?: boolean; onSend: () => void; onStop: () => void }) {
  if (waiting && empty)
    return (
      <button type="button" onClick={onStop} className={cn(ICON_BTN, "bg-foreground text-background hover:opacity-80")} aria-label="Stop the reply" title="Stop">
        <Square className="size-3 fill-current" />
      </button>
    );
  const off = empty || !!blocked || !!disabled;
  return (
    <button
      type="button"
      onClick={onSend}
      disabled={off}
      className={cn(ICON_BTN, !off ? "scale-100 bg-[var(--tint)] text-white hover:brightness-110" : "scale-90 bg-muted text-muted-foreground")}
      aria-label={waiting ? "Queue" : "Send"}
      title={blocked ?? (waiting ? "Queue: sends when the reply is done (Enter)" : "Send (Enter)")}
    >
      <ArrowUp className="size-4" />
    </button>
  );
}
