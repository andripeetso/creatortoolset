import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * A small form dialog for a key, a task or a computer: a title, the fields (`children`), an error line and one primary
 * button that says what it does ("Add key", "Create task"). Use it only for several fields; a single setting saves in place.
 * Submitting with Enter runs `onSubmit`. While `busy`, the button reads "Saving…" and cannot be pressed again.
 */
export function FormDialog({ open, onOpenChange, title, description, submitLabel, onSubmit, busy, error, cancelLabel = "Cancel", children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  submitLabel: string;
  onSubmit: () => void | Promise<void>;
  busy?: boolean;
  error?: string | null;
  cancelLabel?: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* no description: say so to Radix, or it logs a warning on every open */}
      <DialogContent {...(description ? {} : { "aria-describedby": undefined })} className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="space-y-3">{children}</div>
          {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {cancelLabel}
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Saving…" : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
