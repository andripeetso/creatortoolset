import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPortal, DialogTitle } from "@/components/ui/dialog";

/**
 * A dialog over Settings. Not modal: a modal one locks the page's scroll and hides the rest of the window from screen
 * readers each time it opens, and the browser restyles the whole window for both (Settings and the page behind it): 90 to
 * 180 ms a click in WebKit, against 13 to 25 ms this way (owner, 2026-11-15: buttons "don't respond right away"). The
 * backdrop dims the page as before and takes a click outside: it closes the dialog and presses nothing under it.
 */
export function SettingsDialog({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      {open && (
        <DialogPortal>
          <div aria-hidden data-slot="dialog-overlay" className="fixed inset-0 z-50 bg-black/50" />
        </DialogPortal>
      )}
      {children}
    </Dialog>
  );
}

/**
 * The content of a SettingsDialog. The focus moving out never closes it: a row menu gives the focus back to its `…`
 * button as it closes, after the dialog its item opened is up, and a dialog that is not modal would close on that. A
 * click outside still closes it.
 */
export function SettingsDialogContent(props: ComponentProps<typeof DialogContent>) {
  return <DialogContent onFocusOutside={(e) => e.preventDefault()} {...props} />;
}

/**
 * A small form dialog for a key, a task or a computer: a title, the fields (`children`), an error line and one primary
 * button that says what it does ("Add key", "Create task"). Use it only for several fields; a single setting saves in place.
 * Submitting with Enter runs `onSubmit`. While `busy`, the button reads "Saving…" and cannot be pressed again.
 */
export function FormDialog({ open, onOpenChange, title, description, submitLabel, onSubmit, busy, submitDisabled, error, cancelLabel = "Cancel", wide, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  submitLabel: string;
  onSubmit: () => void | Promise<void>;
  busy?: boolean;
  /**
   * The form is not on screen yet (it is loading, or there is nothing to choose from) or is busy with something other
   * than the save: the primary button waits. Never for a missing value: the button stays on and the field says what is
   * missing (`required`).
   */
  submitDisabled?: boolean;
  error?: string | null;
  cancelLabel?: string;
  /** A long form (a scheduled task): twice the width, and it scrolls inside a short window. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <SettingsDialog open={open} onOpenChange={onOpenChange}>
      {/* no description: say so to Radix, or it logs a warning on every open */}
      <SettingsDialogContent {...(description ? {} : { "aria-describedby": undefined })} className={wide ? "max-h-[90vh] overflow-y-auto pb-0 sm:max-w-2xl" : "sm:max-w-md"}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && !submitDisabled) void onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="space-y-3">{children}</div>
          {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          {/* a long form scrolls under its buttons: they stay at the bottom of the dialog, never half under its edge */}
          <DialogFooter className={wide ? "sticky bottom-0 z-10 bg-background pt-2 pb-6" : undefined}>
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {cancelLabel}
            </Button>
            <Button type="submit" size="sm" disabled={busy || submitDisabled}>
              {busy ? "Saving…" : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </SettingsDialogContent>
    </SettingsDialog>
  );
}
