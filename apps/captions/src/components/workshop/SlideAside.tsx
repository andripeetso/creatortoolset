import { useEffect, useRef, useState } from "react";
import { Loader2, MessageCircleQuestion, Send, X } from "lucide-react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { askUsageText } from "@/lib/workshop";

/**
 * Under a slide:
 * - AskPanel: a side chat about this slide or the selected words ("is this a
 *   good written hook?"). It sees only that part and your most saved posts,
 *   answers, and never edits anything or touches the main chat.
 */

export interface AsideMessage {
  role: "user" | "assistant";
  text: string;
  usage?: { tokens: number; costUsd: number };
}

export function AskPanel({
  label,
  quote,
  history,
  busy,
  error,
  onAsk,
  onClose,
}: {
  label: string;
  /** The selected words this side chat is about, if any (else the whole slide). */
  quote?: string;
  history: AsideMessage[];
  busy: boolean;
  error?: string;
  onAsk: (question: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const send = () => {
    const q = text.trim();
    if (!q || busy) return;
    setText("");
    onAsk(q);
  };
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 p-2">
      <p className="flex items-start gap-1.5 text-[11px] text-sky-200/90" title="A side chat: it sees only this part and your most saved posts, answers, and never changes the piece or the main chat.">
        <MessageCircleQuestion className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          Asking about {label}
          {quote ? <span className="line-clamp-1 text-sky-100/80">“{quote}”</span> : null}
        </span>
        <button type="button" onClick={onClose} className="rounded p-0.5 hover:bg-muted hover:text-foreground" aria-label="Close the side chat">
          <X className="h-3 w-3" />
        </button>
      </p>
      {history.map((m, i) =>
        m.role === "user" ? (
          <p key={i} className="ml-6 rounded-lg bg-muted px-2 py-1 text-[13px] text-foreground">
            {m.text}
          </p>
        ) : (
          <div key={i} className="text-[13px] text-foreground">
            <MarkdownBody source={m.text} media={false} />
            {m.usage ? <p className="text-[10px] text-muted-foreground">{askUsageText(m.usage)}</p> : null}
          </div>
        ),
      )}
      {busy ? (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Thinking…
        </p>
      ) : null}
      {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
      <div className="flex items-end gap-1.5">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            } else if (e.key === "Escape") onClose();
          }}
          rows={1}
          placeholder={history.length ? "Ask more" : "e.g. Is this a good written hook?"}
          className="min-w-0 flex-1 resize-none rounded bg-background/60 px-2 py-1 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        />
        <button type="button" onClick={send} disabled={busy || !text.trim()} className="rounded-md bg-sky-600 p-1.5 text-white hover:bg-sky-500 disabled:opacity-50" aria-label="Ask">
          <Send className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
