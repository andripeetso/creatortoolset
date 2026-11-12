import type { ReactNode } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useClipView } from "./clip";

/**
 * What a clip opens in, as Settings → Appearance says: a window in the middle of the page (the player large on the
 * left, the clip's column on the right; the whole screen on a phone, player on top), or a panel at the right side.
 */
export function ClipView({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const view = useClipView();
  const change = (o: boolean) => !o && onClose();
  if (view === "side")
    return (
      <Sheet open={open} onOpenChange={change}>
        <SheetContent side="right" aria-describedby={undefined} className="w-full overflow-y-scroll p-0 sm:max-w-xl">
          {children}
        </SheetContent>
      </Sheet>
    );
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent
        aria-describedby={undefined}
        className={
          "flex h-dvh w-full max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none " +
          "md:h-[min(900px,calc(100dvh-4rem))] md:w-[min(1280px,calc(100vw-4rem))] md:rounded-xl md:border " +
          // the close button sits over the player on a phone: it gets the player's own dark round backing there
          "[&>[data-slot=dialog-close]]:z-20 max-md:[&>[data-slot=dialog-close]]:rounded-full max-md:[&>[data-slot=dialog-close]]:bg-black/60 " +
          "max-md:[&>[data-slot=dialog-close]]:p-1.5 max-md:[&>[data-slot=dialog-close]]:text-white max-md:[&>[data-slot=dialog-close]]:opacity-100"
        }
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
