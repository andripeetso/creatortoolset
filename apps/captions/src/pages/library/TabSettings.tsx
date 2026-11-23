import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";

/** The Media Library's tabs, each with its switch: on, the tab is in the row. A change applies at once. */
export function TabSettingsDialog({
  open,
  tabs,
  hidden,
  onShow,
  onClose,
}: {
  open: boolean;
  tabs: { id: string; label: string }[];
  hidden: string[];
  onShow: (id: string, on: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="flex flex-col gap-3 sm:max-w-sm">
        <DialogTitle className="text-base">Tab settings</DialogTitle>
        <div className="flex flex-col">
          {tabs.map((t) => (
            <label key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="truncate">{t.label}</span>
              <Switch checked={!hidden.includes(t.id)} onCheckedChange={(on) => onShow(t.id, on)} aria-label={t.label} />
            </label>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
