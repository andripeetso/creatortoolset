import { SettingsDialog, SettingsDialogContent } from "./kit-dialog";
import { useEffect, useState } from "react";
import { EDIT_SLOT_NAME, EDIT_SLOTS, type EditorDefaults, type EditSlot } from "@contracts/editor";
import { Button } from "@/components/ui/button";
import { DialogTitle } from "@/components/ui/dialog";
import { getEditorDefaults, setEditorDefault } from "@/lib/editor";
import { useCachedLoad } from "@/lib/local-cache";
import { Card, Row, RowMenu, Section, SettingsSelect, WorkspacePick, saveFailed, useSettingsWorkspace } from "./ui";

const TITLE = "New edit defaults";

/**
 * The slots with more than one item: only these get a select (a slot with one item has nothing to choose). A page whose
 * editor reads only some slots passes them as `slots`; with none passed it is every slot.
 */
export function choosableSlots(data: Pick<EditorDefaults, "items">, slots: readonly EditSlot[] = EDIT_SLOTS): EditSlot[] {
  return slots.filter((s) => data.items[s].length > 1);
}

/**
 * One row per slot that has a choice: the item new edits get. A slot the person chose themselves has Reset in its menu:
 * back to the pack's default, else the built-in item.
 */
export function DefaultRows({ data, slots, busy, change }: { data: EditorDefaults; slots: readonly EditSlot[]; busy?: boolean; change: (slot: EditSlot, id: string | null) => void }) {
  return (
    <Card>
      {slots.map((slot) => (
        <Row
          key={slot}
          title={EDIT_SLOT_NAME[slot]}
          control={
            <>
              <SettingsSelect
                label={EDIT_SLOT_NAME[slot]}
                value={data.bundle[slot]}
                disabled={busy}
                onValueChange={(id) => change(slot, id)}
                options={data.items[slot].map((i) => ({ value: i.id, label: i.from ? `${i.title} (${i.from})` : i.title }))}
              />
              {data.chosen[slot] !== undefined && <RowMenu label={`${EDIT_SLOT_NAME[slot]}: more`} items={[{ label: "Reset", onSelect: () => change(slot, null) }]} />}
            </>
          }
        />
      ))}
    </Card>
  );
}

/** One change at a time, for `workspace` (none: the one the window is in); a failed save is a toast and the rows stay. */
function useChange(workspace: string | null | undefined, done: (d: EditorDefaults) => void) {
  const [busy, setBusy] = useState(false);
  const change = (slot: EditSlot, id: string | null) => {
    setBusy(true);
    setEditorDefault(slot, id, workspace)
      .then(done)
      .catch(() => saveFailed("Default not saved. Try again."))
      .finally(() => setBusy(false));
  };
  return { busy, change };
}

/**
 * The AI Editor's "Defaults" button: the set every new edit in the window's workspace starts with (design, grade, voice
 * mix, sound effects). It is drawn only when some slot has more than one choice, and the dialog lists only those slots.
 * An edit keeps the set it was made with, so a change here never changes an edit that exists.
 */
export function EditorDefaultsButton({ slots }: { slots?: readonly EditSlot[] }) {
  const [data, setData] = useState<EditorDefaults | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    getEditorDefaults().then(setData, () => setData(null));
  }, []);
  const { busy, change } = useChange(undefined, setData);
  const choosable = data ? choosableSlots(data, slots) : [];
  if (!data || choosable.length === 0) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Defaults
      </Button>
      <SettingsDialog open={open} onOpenChange={setOpen}>
        <SettingsDialogContent aria-describedby={undefined} className="sm:max-w-lg">
          <DialogTitle>{TITLE}</DialogTitle>
          <DefaultRows data={data} slots={choosable} busy={busy} change={change} />
        </SettingsDialogContent>
      </SettingsDialog>
    </>
  );
}

/**
 * Settings → AI Editor: the same defaults, for the workspace picked in the page header (each workspace has its own).
 * Nothing is drawn, the selector included, while no slot has a choice.
 */
export function EditorDefaultsSection({ slots }: { slots?: readonly EditSlot[] }) {
  const w = useSettingsWorkspace("one");
  const d = useCachedLoad<EditorDefaults>("/api/editor/defaults", () => getEditorDefaults(w.id), { own: true, workspace: w.cacheKey });
  const { busy, change } = useChange(w.id, d.set);
  const choosable = d.data ? choosableSlots(d.data, slots) : [];
  if (!d.data || choosable.length === 0) return null;
  return (
    <Section title={TITLE}>
      <WorkspacePick mode="one" />
      <DefaultRows data={d.data} slots={choosable} busy={busy} change={change} />
    </Section>
  );
}
