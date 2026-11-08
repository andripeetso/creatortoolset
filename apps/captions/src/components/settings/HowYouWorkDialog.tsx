import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { HowPicker } from "@/components/setup/HowPicker";
import { useWorkTalk } from "@/lib/setup";

type Talk = "app" | "chat" | "both";

/** What each answer does, in one line (10.1): the same effects the walk's step 1 promises. */
const EFFECT: Record<Talk, string> = {
  app: "The assistant sits beside the page.",
  chat: "The assistant in this app is hidden. Your own AI can use Creator Toolset: see Settings → Your AI.",
  both: "The assistant stays beside the page, and your own AI can use Creator Toolset too.",
};

/**
 * Settings → Setup → How you work. Not the walk: the three answers and what each one changes, then Save. The answer
 * is kept (work-prefs `talk`) and read by the assistant, the tool welcome, Settings → Your AI and the setup steps.
 */
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
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[min(760px,calc(100dvh-2rem))] w-[min(720px,calc(100vw-2rem))] max-w-none overflow-y-auto sm:max-w-none">
        <DialogTitle>How you work</DialogTitle>
        <DialogDescription>Change it any time. Your tools, projects and connections stay.</DialogDescription>
        <HowPicker value={value} onChange={setValue} />
        <p className="mt-3 text-sm text-muted-foreground">{EFFECT[value]}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={busy}>
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
