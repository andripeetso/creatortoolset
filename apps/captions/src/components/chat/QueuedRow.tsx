import { CornerDownLeft, Pencil, X } from "lucide-react";

/**
 * A message waiting over the message box, the same in both chats: what it says (or what it carries), then Steer (Send
 * when nothing is being written), Edit back into the box, and Remove. `held`: it was stopped, so it waits for a press.
 */
export function QueuedRow({ text, extra, held, thinking, onSteer, onEdit, onRemove }: { text: string; extra?: string; held: boolean; thinking: boolean; onSteer: () => void; onEdit: () => void; onRemove: () => void }) {
  return (
    <li className="flex items-center gap-2 rounded-xl border bg-muted/60 px-3 py-1.5 text-[13px] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1">
      <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground uppercase">{held ? "Not sent" : "Queued"}</span>
      <span className="min-w-0 flex-1 truncate" title={text}>
        {text.trim() || extra}
        {text.trim() && extra ? <span className="ml-1.5 text-[11px] text-muted-foreground">+ {extra}</span> : null}
      </span>
      <button
        type="button"
        onClick={onSteer}
        className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--tint)] hover:bg-[color-mix(in_srgb,var(--tint)_15%,transparent)]"
        title={thinking ? "Steer: stop the reply and send this now" : "Send this now"}
      >
        <CornerDownLeft className="size-3" /> {thinking ? "Steer" : "Send"}
      </button>
      <button type="button" onClick={onEdit} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground" title="Edit: back into the message box" aria-label="Edit queued message">
        <Pencil className="size-3" />
      </button>
      <button type="button" onClick={onRemove} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground" title="Remove from the queue" aria-label="Remove queued message">
        <X className="size-3" />
      </button>
    </li>
  );
}
