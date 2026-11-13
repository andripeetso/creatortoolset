import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth";
import { confirmDialog } from "@/lib/dialogs";
import { cachedUsage, clearAccountCache } from "@/lib/local-cache";
import { persistConfirmDeletes, persistStatusBars, storedConfirmDeletes, storedStatusBars } from "@/lib/settings";
import { canRecordScreen } from "@/lib/mac-record";
import { useWorkPrefs } from "@/lib/setup";
import { Card, Row, Section, SettingsSelect, Status, saveFailed } from "./ui";
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
      <Dictation mac={mac} />
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
        <AskFit />
      </Card>
    </Section>
  );
}

/** The assistant asks when dropped footage doesn't seem to fit the open project (work-prefs askFit; its "Don't ask again" turns it off). */
function AskFit() {
  const prefs = useWorkPrefs((s) => s.prefs);
  // read each time the page opens: the chat's "Don't ask again" may have turned it off meanwhile
  useEffect(() => void useWorkPrefs.getState().load(), []);
  if (!prefs) return null;
  return (
    <Row
      id="ask-fit"
      title="Ask when dropped footage doesn't fit the open project"
      control={<Switch checked={prefs.askFit !== false} aria-label="Ask when dropped footage doesn't fit the open project" onCheckedChange={(on) => void useWorkPrefs.getState().put({ askFit: on })} />}
    />
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

const KEEP = [5, 10, 25, 50, 100];

/**
 * Dictation on this Mac (apps/mac Dictation.swift): shown only where the app reports it. The app keeps every value; each
 * change goes to it as `dictation:<what>:<value>` and comes back in its next answer.
 */
export function Dictation({ mac }: { mac: ThisMacState | null }) {
  const d = mac?.dictation;
  if (!d) return null;
  const set = (what: string, value = "") => tell(`dictation:${what}:${value}`);
  const model = d.models.find((m) => m.id === d.model);
  const keep = KEEP.includes(d.keep) ? KEEP : [...KEEP, d.keep].sort((a, b) => a - b);
  const remove = async () => {
    if (!model) return;
    if (await confirmDialog({ title: `Remove ${model.name}?`, body: `It downloads again (${model.size}) the next time you dictate.`, ok: "Remove", danger: true })) set("remove", model.id);
  };
  return (
    <Section title="Dictation">
      <Card>
        <Row
          id="dictation"
          title="Dictation"
          description="Talk, and the words go where the cursor is. F13 starts and stops, F16 cancels."
          status={d.on && d.needs ? <Status tone="attention">Needs {d.needs}</Status> : undefined}
          control={
            <>
              {d.on && d.needs && <Button size="sm" variant="outline" onClick={() => set("setup")}>Allow</Button>}
              <Switch checked={d.on} aria-label="Dictation" onCheckedChange={(on) => set("on", on ? "1" : "0")} />
            </>
          }
        />
        {d.on && (
          <>
            <Row
              id="dictation-hold"
              title="Hold to talk"
              control={
                <SettingsSelect
                  label="Hold to talk"
                  value={d.hold}
                  onValueChange={(v) => set("hold", v)}
                  options={[{ value: "off", label: "Off" }, ...d.holdKeys.map((k) => ({ value: k.id, label: k.name }))]}
                />
              }
            />
            <Row
              id="dictation-model"
              title="Speech model"
              status={model && model.progress !== null ? `Downloading · ${Math.round(model.progress * 100)}%` : undefined}
              control={
                <>
                  {model && !model.here && model.progress === null && <Button size="sm" variant="outline" onClick={() => set("download", model.id)}>Download</Button>}
                  {model?.removable && <Button size="sm" variant="outline" onClick={() => void remove()}>Remove</Button>}
                  <SettingsSelect
                    label="Speech model"
                    value={d.model}
                    onValueChange={(v) => set("model", v)}
                    options={d.models.map((m) => ({ value: m.id, label: `${m.name} · ${m.size}` }))}
                  />
                </>
              }
            />
            <Row
              id="dictation-history"
              title="History"
              description="The last recordings, to copy or transcribe again. F14 opens it."
              control={
                <>
                  <SettingsSelect
                    label="Recordings kept"
                    value={String(d.keep)}
                    onValueChange={(v) => set("keep", v)}
                    options={keep.map((n) => ({ value: String(n), label: `Last ${n}` }))}
                    className="sm:min-w-28"
                  />
                  <Button size="sm" variant="outline" onClick={() => set("history")}>Open</Button>
                </>
              }
            />
            <Row
              id="dictation-file"
              title="Transcribe a file"
              description="Audio or video, on this Mac. F15 opens it."
              control={<Button size="sm" variant="outline" onClick={() => set("file")}>Open</Button>}
            />
            <Row
              id="dictation-sounds"
              title="Sounds when it starts and stops"
              control={<Switch checked={d.sounds} aria-label="Sounds when dictation starts and stops" onCheckedChange={(on) => set("sounds", on ? "1" : "0")} />}
            />
          </>
        )}
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
      saveFailed("The saved lists did not clear. Try again.");
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
      saveFailed("The switch did not save. Try again.");
    }
  };
  return (
    <Row
      id="usage-reports"
      title="Send anonymous usage and crash reports"
      description="Which pages you open, which AIs are set up, and error messages, under a random id. Never your name, files or content."
      control={<Switch checked={state.on} aria-label="Send anonymous usage and crash reports" onCheckedChange={(on) => void toggle(on)} />}
    />
  );
}
