import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth";
import { cachedUsage, clearAccountCache } from "@/lib/local-cache";
import { canSpeak, useReadAloud } from "@/lib/read-aloud";
import { persistConfirmDeletes, persistStatusBars, storedConfirmDeletes, storedStatusBars } from "@/lib/settings";
import { useWorkTalk } from "@/lib/setup";
import { warmScreens } from "@/lib/warm-cache";
import { canRecordScreen } from "@/lib/mac-record";
import { Card, Row, RowMenu, Section, saveFailed } from "./ui";
import { HowYouWorkDialog, HOW_NAMES } from "./HowYouWorkDialog";
import { tell, useThisMac, type ThisMacState } from "./ThisMacSection";

const size = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;

/** Settings → General: how the app is set up here, the switches that have a reader, add-ons, and this computer's saved lists. */
export function GeneralSection() {
  const { talk } = useWorkTalk();
  const [howOpen, setHowOpen] = useState(false);
  const mac = useThisMac(canRecordScreen());
  return (
    <>
      <Section title="Setup">
        <Card>
          <Row id="how-you-work" title="How you use the app" status={HOW_NAMES[talk ?? "app"]} control={<Button size="sm" variant="outline" onClick={() => setHowOpen(true)}>Change</Button>} />
          <Row id="run-setup" title="Setup" control={<Button asChild size="sm" variant="outline"><Link to="/?setup=agents">Run again</Link></Button>} />
        </Card>
        {howOpen && <HowYouWorkDialog onClose={() => setHowOpen(false)} />}
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
 * change. Refresh (lib/warm-cache.ts) fills them again from the server; Clear empties them. Failures are toasts.
 */
function ThisComputer() {
  const me = useAuth((s) => s.me);
  const [usage, setUsage] = useState(() => cachedUsage(me?.username));
  const [busy, setBusy] = useState(false);
  const measure = useCallback(() => setUsage(cachedUsage(useAuth.getState().me?.username)), []);
  useEffect(() => measure(), [measure, me]);

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await warmScreens();
    } catch {
      saveFailed("The saved lists did not refresh. Try again.");
    } finally {
      setBusy(false);
      measure();
    }
  };
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
          title="Saved lists"
          description="Copies the screens open from, so they show at once. Your work stays."
          status={usage.items > 0 ? `${usage.items} · ${size(usage.bytes)}` : undefined}
          control={
            <RowMenu
              label="Saved lists"
              items={[
                { label: busy ? "Refreshing…" : "Refresh", onSelect: refresh },
                { label: "Clear", onSelect: clear },
              ]}
            />
          }
        />
      </Card>
    </Section>
  );
}
