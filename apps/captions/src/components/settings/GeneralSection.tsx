import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { CLIP_SPEEDS, loadClipSpeed, saveClipSpeed, isClipSpeed, type ClipSpeed } from "@/lib/clip-playback";
import { persistAutoCadence, storedAutoCadence } from "@/lib/cadence-preference";
import { persistConfirmDeletes, persistStatusBars, storedConfirmDeletes, storedStatusBars } from "@/lib/settings";
import { canSpeak, useReadAloud } from "@/lib/read-aloud";
import { Card, Group, Row } from "./ui";
import { WorkPrefsGroup } from "./WorkPrefsGroup";
import { selectCls } from "./helpers";

/**
 * Settings → General. Only the choices that already live on this device as a scattered preference
 * (read where they are used) plus confirm-before-delete. Notifications: the bell always works; Mac
 * notifications come from the Mac app, so there is nothing to switch here.
 */
export function GeneralSection() {
  const [confirm, setConfirm] = useState(storedConfirmDeletes);
  const [cadence, setCadence] = useState(storedAutoCadence);
  const [speed, setSpeed] = useState<ClipSpeed>(loadClipSpeed);
  const [bars, setBars] = useState(storedStatusBars);

  return (
    <>
      <WorkPrefsGroup />
      <Group title="Notifications" hint="Review comments, replies and Workshop notes.">
        <Card>
          <Row label="In the app" hint="The bell at the top right, on every device you sign in on." />
          <Row label="Mac notifications" hint="Sent by the Creator Toolset Mac app." />
        </Card>
      </Group>

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
          <Row label="Match cadence after transcription" hint="The default for new Caption Studio projects.">
            <Switch
              checked={cadence}
              aria-label="Match cadence after transcription"
              onCheckedChange={(on) => {
                setCadence(on);
                persistAutoCadence(on);
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
          <Row label="Video Notes playback speed">
            <select
              value={speed}
              aria-label="Video Notes playback speed"
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!isClipSpeed(n)) return;
                setSpeed(n);
                saveClipSpeed(n);
              }}
              className={selectCls}
            >
              {CLIP_SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
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
