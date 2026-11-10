import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth";
import { cachedUsage, clearAccountCache } from "@/lib/local-cache";
import { canSpeak, useReadAloud } from "@/lib/read-aloud";
import { persistConfirmDeletes, persistStatusBars, storedConfirmDeletes, storedStatusBars } from "@/lib/settings";
import { canRecordScreen } from "@/lib/mac-record";
import { Card, Row, Section, saveFailed } from "./ui";
import { tell, useThisMac, type ThisMacState } from "./ThisMacSection";

const size = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;

/** Settings → General: setup, the switches that have a reader, add-ons, and this computer's saved lists. */
export function GeneralSection() {
  const mac = useThisMac(canRecordScreen());
  return (
    <>
      <Section title="Setup">
        <Card>
          <Row id="run-setup" title="Setup" control={<Button asChild size="sm" variant="outline"><Link to="/?setup=agents">Run again</Link></Button>} />
        </Card>
      </Section>

      <Working />
      <AddOns />
      <ScreenRecording mac={canRecordScreen() ? mac : null} />
      <ThisComputer />
    </>
  );
}

/** Switches that already have a reader where they are used (lib/settings.ts). Read at mount; they save at once. */
function Working() {
  const [confirm, setConfirm] = useState(storedConfirmDeletes);
  const [bars, setBars] = useState(storedStatusBars);
  return (
    <Section title="Working">
      <Card>
        <Row
          id="confirm-deletes"
          title="Ask before moving to trash or deleting a comment"
          description="Deleting for good always asks."
          control={
            <Switch
              checked={confirm}
              aria-label="Ask before moving to trash or deleting a comment"
              onCheckedChange={(on) => {
                setConfirm(on);
                persistConfirmDeletes(on);
              }}
            />
          }
        />
        <Row
          id="status-colours"
          title="Colour bar beside each session in the Workshop"
          control={
            <Switch
              checked={bars}
              aria-label="Colour bar beside each session in the Workshop"
              onCheckedChange={(on) => {
                setBars(on);
                persistStatusBars(on);
              }}
            />
          }
        />
      </Card>
    </Section>
  );
}

/** The assistant's read-aloud add-on (lib/read-aloud.ts): off until switched on here; the voice downloads then. */
function AddOns() {
  const { on, loading, toggle } = useReadAloud();
  if (!canSpeak()) return null;
  return (
    <Section title="Add-ons">
      <Card>
        <Row
          id="read-aloud"
          title="Read the assistant's replies aloud"
          description={loading !== null ? `Downloading the voice · ${Math.round(loading * 100)}%` : "Downloads once, about 90 MB."}
          control={<Switch checked={on} aria-label="Read the assistant's replies aloud" onCheckedChange={toggle} />}
        />
      </Card>
    </Section>
  );
}

/** The Mac app's recording shortcut (apps/mac RecordShortcut.swift): shown only where the app reports it. */
export function ScreenRecording({ mac }: { mac: ThisMacState | null }) {
  if (typeof mac?.shortcut !== "string") return null;
  return (
    <Section title="Screen recording">
      <Card>
        <Row
          id="recording-shortcut"
          title="Recording shortcut"
          status={mac.shortcut || "Off"}
          control={<Button size="sm" variant="outline" onClick={() => tell("shortcut")}>Change</Button>}
        />
      </Card>
    </Section>
  );
}

/**
 * The saved lists (lib/local-cache.ts): one row with their count and size, read when the page opens and after each
 * change. Clear empties them; a failure is a toast.
 */
function ThisComputer() {
  const me = useAuth((s) => s.me);
  const [usage, setUsage] = useState(() => cachedUsage(me?.username));
  const measure = useCallback(() => setUsage(cachedUsage(useAuth.getState().me?.username)), []);
  useEffect(() => measure(), [measure, me]);

  // no Refresh: the app fills these lists itself after sign-in (App.tsx warmScreens), so a person never needs to
  const clear = () => {
    try {
      clearAccountCache(me?.username);
    } catch {
      saveFailed("The saved lists did not clear. Try again.");
    }
    measure();
  };

  return (
    <Section title="This computer">
      <Card>
        <Row
          id="saved-lists"
          title="Cache"
          description="Lists kept on this computer so screens open at once. Clearing it loses no work."
          status={`${usage.items} ${usage.items === 1 ? "list" : "lists"} · ${size(usage.bytes)}`}
          control={
            <Button size="sm" variant="outline" onClick={clear} disabled={usage.items === 0}>
              Clear
            </Button>
          }
        />
      </Card>
    </Section>
  );
}
