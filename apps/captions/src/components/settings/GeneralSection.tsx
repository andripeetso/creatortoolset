import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth";
import { cachedUsage, clearAccountCache } from "@/lib/local-cache";
import { persistConfirmDeletes, persistStatusBars, storedConfirmDeletes, storedStatusBars } from "@/lib/settings";
import { canRecordScreen } from "@/lib/mac-record";
import { useWorkPrefs } from "@/lib/setup";
import { Card, Row, Section, saveFailed } from "./ui";
import { hasThisMac, tell, useThisMac, type ThisMacState } from "./ThisMacSection";

const size = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;

/** Settings → General: the switches that have a reader, and this computer's saved lists. */
export function GeneralSection() {
  const mac = useThisMac(hasThisMac());
  return (
    <>
      <Working />
      <ScreenRecording mac={canRecordScreen() ? mac : null} />
      <ThisComputer version={mac?.version} />
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
          title="Confirm deletes"
          description="Moving to the trash and deleting a comment are confirmed; a permanent delete always is."
          control={
            <Switch
              checked={confirm}
              aria-label="Confirm deletes"
              onCheckedChange={(on) => {
                setConfirm(on);
                persistConfirmDeletes(on);
              }}
            />
          }
        />
        <Row
          id="status-colours"
          title="Workshop status colours"
          control={
            <Switch
              checked={bars}
              aria-label="Workshop status colours"
              onCheckedChange={(on) => {
                setBars(on);
                persistStatusBars(on);
              }}
            />
          }
        />
        <AskFit />
        <UsageLimits />
      </Card>
    </Section>
  );
}

/** The assistant asks when dropped footage doesn't seem to fit the open workspace (work-prefs askFit; its "Don't ask again" turns it off). */
function AskFit() {
  const prefs = useWorkPrefs((s) => s.prefs);
  // read each time the page opens: the chat's "Don't ask again" may have turned it off meanwhile
  useEffect(() => void useWorkPrefs.getState().load(), []);
  if (!prefs) return null;
  return (
    <Row
      id="ask-fit"
      title="Footage workspace prompt"
      description="The assistant asks when dropped footage does not fit the open workspace."
      control={<Switch checked={prefs.askFit !== false} aria-label="Footage workspace prompt" onCheckedChange={(on) => void useWorkPrefs.getState().put({ askFit: on })} />}
    />
  );
}

/** What a chat does when a usage limit stops its reply (work-prefs autoResume, snoozeLimited); each chat's banner changes its own. */
function UsageLimits() {
  const prefs = useWorkPrefs((s) => s.prefs);
  if (!prefs) return null;
  return (
    <>
      <Row
        id="auto-resume-limited"
        title="Auto-resume"
        description="A chat stopped by a usage limit resumes when the limit resets."
        control={<Switch checked={prefs.autoResume !== false} aria-label="Auto-resume" onCheckedChange={(on) => void useWorkPrefs.getState().put({ autoResume: on })} />}
      />
      <Row
        id="snooze-limited"
        title="Limit snooze"
        description="A chat stopped by a usage limit is snoozed until the limit resets."
        control={<Switch checked={prefs.snoozeLimited === true} aria-label="Limit snooze" onCheckedChange={(on) => void useWorkPrefs.getState().put({ snoozeLimited: on })} />}
      />
    </>
  );
}

/** The Mac app's recording shortcut (apps/mac RecordShortcut.swift): shown only where the app reports it. */
export function ScreenRecording({ mac }: { mac: ThisMacState | null }) {
  if (typeof mac?.shortcut !== "string") return null;
  return (
    <Section title="Screen Recorder">
      <Card>
        <Row
          id="recording-shortcut"
          title="Recording shortcut"
          status={mac.shortcut || "Not set"}
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
export function ThisComputer({ version }: { version?: string }) {
  const me = useAuth((s) => s.me);
  const [usage, setUsage] = useState(() => cachedUsage(me?.username));
  const measure = useCallback(() => setUsage(cachedUsage(useAuth.getState().me?.username)), []);
  useEffect(() => measure(), [measure, me]);

  // no Refresh: the app fills these lists itself after sign-in (App.tsx warmScreens), so a person never needs to
  const clear = () => {
    try {
      clearAccountCache(me?.username);
    } catch {
      saveFailed("Cache not cleared");
    }
    measure();
  };

  return (
    <Section title="This computer">
      <Card>
        {version && <Row id="app-version" title="Version" status={`Creator Toolset ${version}`} />}
        <Reports />
        <Row
          id="saved-lists"
          title="Cache"
          description="Lists saved on this computer so screens open at once."
          status={size(usage.bytes)}
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

/**
 * The downloaded app's anonymous usage and crash reports (api/lib/telemetry.ts). Shown only in a build that sends them,
 * to the admin; saves at once.
 */
function Reports() {
  const admin = useAuth((s) => s.me?.role === "admin");
  const [state, setState] = useState<{ available: boolean; on: boolean } | null>(null);
  useEffect(() => {
    if (!admin) return;
    fetch("/api/telemetry")
      .then((r) => (r.ok ? r.json() : null))
      .then(setState)
      .catch(() => {});
  }, [admin]);
  if (!admin || !state?.available) return null;
  const toggle = async (on: boolean) => {
    setState({ ...state, on });
    try {
      const r = await fetch("/api/telemetry", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on }) });
      if (!r.ok) throw new Error(String(r.status));
      setState(await r.json());
    } catch {
      setState({ ...state, on: !on });
      saveFailed("Usage and crash reports not saved");
    }
  };
  return (
    <Row
      id="usage-reports"
      title="Usage and crash reports"
      description="Sends the pages opened, the AI providers set up and error messages, under a random id."
      control={<Switch checked={state.on} aria-label="Usage and crash reports" onCheckedChange={(on) => void toggle(on)} />}
    />
  );
}
