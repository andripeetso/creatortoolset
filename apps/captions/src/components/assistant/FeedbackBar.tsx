import { MessageSquareText } from "lucide-react";
import { useFeedback } from "@/lib/review-feedback";

const setSlot = (el: HTMLElement | null) => useFeedback.setState({ slot: el });
const toggle = () => useFeedback.setState((s) => ({ on: !s.on }));

/**
 * Over the message box while a Review video stands beside the chats: switches the box to the video's comment box
 * (feedback mode) and back. In feedback mode it says how many comments the video has; the chat reads them.
 */
export function FeedbackBar() {
  const { count, on } = useFeedback();
  if (count === null) return null;
  return (
    <div className="mx-4 -mb-4 rounded-t-2xl border border-b-0 border-violet-400/50 bg-violet-50 px-3 pt-1.5 pb-5 text-xs motion-safe:animate-in motion-safe:fade-in dark:border-violet-400/25 dark:bg-violet-400/10">
      <div className="flex min-h-6 items-center gap-2">
        <MessageSquareText className="size-3.5 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden />
        <span className="shrink-0 font-medium">{on ? "Feedback list" : "Feedback mode"}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {on ? `${count} comment${count === 1 ? "" : "s"} on this video · the chat reads them` : "Timecoded comments on this video"}
        </span>
        <button type="button" onClick={toggle} className="shrink-0 rounded px-1 py-0.5 text-xs font-medium text-foreground hover:bg-foreground/5">
          {on ? "Back to chat" : "Switch to feedback mode"}
        </button>
      </div>
    </div>
  );
}

/** Where the Review page draws its comment box in feedback mode (it portals it here). */
export function FeedbackSlot() {
  return <div ref={setSlot} className="relative rounded-2xl border bg-background p-3" />;
}
