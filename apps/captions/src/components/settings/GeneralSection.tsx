import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { CLIP_SPEEDS, loadClipSpeed, saveClipSpeed, isClipSpeed, type ClipSpeed } from "@/lib/clip-playback";
import { persistAutoCadence, storedAutoCadence } from "@/lib/cadence-preference";
import { persistConfirmDeletes, persistStatusBars, storedConfirmDeletes, storedStatusBars } from "@/lib/settings";
import { Card, Group, Row } from "./ui";
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
      <Group title="Notifications" hint="Review comments, replies and Workshop notes.">
        <Card>
          <Row label="In the app" hint="The bell at the top right. It works on every device you sign in on." />
          <Row label="Mac notifications" hint="Come from the Creator Toolset Mac app once it runs on your Mac. Nothing to switch here." />
        </Card>
      </Group>

      <Group title="Working" hint="Kept on this device.">
        <Card>
          <Row label="Confirm before deleting" hint="Asks before a comment or a video goes to the trash. Deleting for good always asks.">
            <Switch
              checked={confirm}
              aria-label="Confirm before deleting"
              onCheckedChange={(on) => {
                setConfirm(on);
                persistConfirmDeletes(on);
              }}
            />
          </Row>
          <Row label="Match cadence after transcription" hint="New Caption Studio projects start with it on or off. Off = place captions first.">
            <Switch
              checked={cadence}
              aria-label="Match cadence after transcription"
              onCheckedChange={(on) => {
                setCadence(on);
                persistAutoCadence(on);
              }}
            />
          </Row>
          <Row label="Status colours in the Workshop sidebar" hint="A coloured bar beside each session for its status.">
            <Switch
              checked={bars}
              aria-label="Status colours in the Workshop sidebar"
              onCheckedChange={(on) => {
                setBars(on);
                persistStatusBars(on);
              }}
            />
          </Row>
          <Row label="Video Notes playback speed" hint="Where a Video Notes or guide video starts.">
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
      <Group title="Setup" hint="The first-run walk-through: a project, your AI, your Instagram, your other keys.">
        <Card>
          <Row label="Run setup again">
            <Button asChild size="sm" variant="outline">
              <Link to="/?setup=project">Open</Link>
            </Button>
          </Row>
        </Card>
      </Group>
    </>
  );
}
