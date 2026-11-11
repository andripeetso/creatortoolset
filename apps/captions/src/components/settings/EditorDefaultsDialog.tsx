import { useCallback, useEffect, useState } from "react";
import { EDIT_SLOT_NAME, EDIT_SLOTS, type EditorDefaults, type EditSlot } from "@contracts/editor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getEditorDefaults, setEditorDefault } from "@/lib/editor";
import { Card, Row, SettingsSelect, saveFailed } from "./ui";

/**
 * The slots with more than one item: only these get a select (a slot with one item has nothing to choose). A page whose
 * editor reads only some slots passes them as `slots`; with none passed it is every slot.
 */
export function choosableSlots(data: Pick<EditorDefaults, "items">, slots: readonly EditSlot[] = EDIT_SLOTS): EditSlot[] {
  return slots.filter((s) => data.items[s].length > 1);
}

/**
 * The AI Editor's "Defaults" button: the set every new edit starts with (design, grade, voice mix, sound effects). It is
 * drawn only when some slot has more than one choice, and the dialog lists only those slots. An edit keeps the set it
 * was made with, so a change here never changes an edit that exists.
 */
export function EditorDefaultsButton({ slots }: { slots?: readonly EditSlot[] }) {
  const [data, setData] = useState<EditorDefaults | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    getEditorDefaults().then(setData, () => setData(null));
  }, []);
  const choosable = data ? choosableSlots(data, slots) : [];
  if (!data || choosable.length === 0) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Defaults
      </Button>
      <EditorDefaultsDialog open={open} onOpenChange={setOpen} initial={data} slots={slots} />
    </>
  );
}

function EditorDefaultsDialog({ open, onOpenChange, initial, slots }: { open: boolean; onOpenChange: (o: boolean) => void; initial: EditorDefaults; slots?: readonly EditSlot[] }) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const change = useCallback((slot: EditSlot, id: string | null) => {
    setBusy(true);
    setEditorDefault(slot, id)
      .then(setData)
      .catch(() => saveFailed("That default did not save. Try again."))
      .finally(() => setBusy(false));
  }, []);
  const choosable = choosableSlots(data, slots);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-lg">
        <DialogTitle>Defaults for new edits</DialogTitle>
        <Card>
          {choosable.map((slot) => {
            const picked = data.chosen[slot] !== undefined;
            return (
              <Row
                key={slot}
                title={EDIT_SLOT_NAME[slot]}
                status={data.items[slot].find((i) => i.id === data.bundle[slot])?.title}
                control={
                  <div className="flex items-center gap-2">
                    {picked && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => change(slot, null)}>
                        Use built-in
                      </Button>
                    )}
                    <SettingsSelect
                      label={`${EDIT_SLOT_NAME[slot]} for new edits`}
                      value={data.bundle[slot]}
                      disabled={busy}
                      onValueChange={(id) => change(slot, id)}
                      options={data.items[slot].map((i) => ({ value: i.id, label: i.from ? `${i.title} (${i.from})` : i.title }))}
                    />
                  </div>
                }
              />
            );
          })}
        </Card>
      </DialogContent>
    </Dialog>
  );
}
