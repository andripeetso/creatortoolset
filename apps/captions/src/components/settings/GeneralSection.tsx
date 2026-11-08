import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { persistConfirmDeletes, persistStatusBars, storedConfirmDeletes, storedStatusBars } from "@/lib/settings";
import { canSpeak, useReadAloud } from "@/lib/read-aloud";
import { Card, Group, Row } from "./ui";

/**
 * Settings → General. Only the choices that already live on this device as a scattered preference
 * (read where they are used) plus confirm-before-delete. A choice that has its own control where it is used
 * (Video Notes speed, Match cadence in a project) stays there only.
 */
export function GeneralSection() {
  const [confirm, setConfirm] = useState(storedConfirmDeletes);
  const [bars, setBars] = useState(storedStatusBars);

  return (
    <>
      <Group title="Working" hint="Kept on this device.">
        <Card>
          <Row label="Confirm before deleting" hint="Asks before a comment or video goes to the trash. Deleting for good always asks.">
            <Switch
              checked={confirm}
              aria-label="Confirm before deleting"
              onCheckedChange={(on) => {
                setConfirm(on);
                persistConfirmDeletes(on);
              }}
            />
          </Row>
          <Row label="Status colours in the Workshop sidebar" hint="A coloured bar beside each session.">
            <Switch
              checked={bars}
              aria-label="Status colours in the Workshop sidebar"
              onCheckedChange={(on) => {
                setBars(on);
                persistStatusBars(on);
              }}
            />
          </Row>
        </Card>
      </Group>
      <ReadAloud />
    </>
  );
}


/** The assistant's read-aloud add-on (lib/read-aloud.ts): off until switched on here; the voice downloads then. */
function ReadAloud() {
  const { on, loading, toggle } = useReadAloud();
  if (!canSpeak()) return null;
  return (
    <Group title="Add-ons" hint="Off unless you turn them on. Kept on this device.">
      <Card>
        <Row
          label="Read the assistant's replies aloud"
          hint={loading !== null ? `Downloading the voice · ${Math.round(loading * 100)}%` : "A natural voice that runs on this computer. Downloads once, about 90 MB."}
        >
          <Switch checked={on} aria-label="Read the assistant's replies aloud" onCheckedChange={toggle} />
        </Row>
      </Card>
    </Group>
  );
}
