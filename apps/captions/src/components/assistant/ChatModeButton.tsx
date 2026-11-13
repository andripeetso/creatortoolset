import { useRef } from "react";
import { toggleChatMode, useChatMode } from "@/lib/chat-mode";
import { cn } from "@/lib/utils";

/** A speech bubble: an outline while chat mode is off, filled in the project's colour while it's on. */
export function ChatModeIcon({ on, className }: { on: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-[18px] fill-none stroke-current", className)} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path
        d="M6 18H5a2.5 2.5 0 0 1-2.5-2.5v-9A2.5 2.5 0 0 1 5 4h14a2.5 2.5 0 0 1 2.5 2.5v9A2.5 2.5 0 0 1 19 18h-9l-4 3.5z"
        className={cn("transition-[fill,stroke] duration-200", on && "fill-[rgb(var(--violet-600))] stroke-[rgb(var(--violet-600))]")}
      />
    </svg>
  );
}

/** Chat mode on or off: first in the top bar, where the window's own buttons end. */
export function ChatModeButton({ className, ...rest }: { className?: string } & React.HTMLAttributes<HTMLButtonElement>) {
  const on = useChatMode((s) => s.on);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      {...rest}
      ref={ref}
      // ⌘J presses whichever of these is on screen (lib/chat-mode.ts)
      data-chat-toggle
      type="button"
      onClick={() => toggleChatMode(ref.current)}
      aria-pressed={on}
      aria-label={on ? "Leave chat mode" : "Chat mode"}
      title={on ? "Leave chat mode (⌘J)" : "Chat mode: your chats beside the page (⌘J)"}
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md text-zinc-500 outline-none transition-[color,background-color,transform] hover:bg-zinc-500/15 hover:text-current focus-visible:ring-2 focus-visible:ring-[rgb(var(--violet-600))] active:scale-90",
        on && "text-current",
        className,
      )}
    >
      <ChatModeIcon on={on} />
    </button>
  );
}
