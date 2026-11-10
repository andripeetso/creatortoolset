import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { HowPicker } from "@/components/setup/HowPicker";
import { useWorkTalk } from "@/lib/setup";
import { saveFailed } from "./ui";

type Talk = "app" | "chat" | "both";

export const HOW_NAMES: Record<Talk, string> = { app: "In the app", chat: "In my own AI", both: "Both" };

/** What the selected answer changes, one line (the same effects the first-run walk promises). */
const EFFECT: Record<Talk, string> = {
  app: "The assistant sits beside the page.",
  chat: "The assistant in this app is hidden. Your own AI can use Creator Toolset: see Settings → Your own AI.",
  both: "The assistant stays beside the page, and your own AI can use Creator Toolset too.",
};

/** Settings → General → How you use the app. The answer is read by the assistant, the tool welcome and the setup steps. */
export function HowYouWorkDialog({ onClose }: { onClose: () => void }) {
  const { talk, setTalk } = useWorkTalk();
  const [value, setValue] = useState<Talk>(talk ?? "app");
  const [busy, setBusy] = useState(false);
  // the saved answer, once it has loaded, when the dialog was opened before it arrived
  useEffect(() => {
    if (talk) setValue(talk);
  }, [talk]);

  const save = async () => {
    setBusy(true);
    try {
      await setTalk(value);
      onClose();
    } catch {
      saveFailed("That did not save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-h-[min(760px,calc(100dvh-2rem))] w-[min(720px,calc(100vw-2rem))] max-w-none overflow-y-auto sm:max-w-none">
        <DialogTitle>How you use the app</DialogTitle>
        <HowPicker value={value} onChange={setValue} />
        <p className="text-sm text-muted-foreground">{EFFECT[value]}</p>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
