import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { confirmDialog } from "@/lib/dialogs";
import { Card, Row, Section, SettingsSelect, Status } from "./ui";
import { tell, type DictationAction, type ThisMacState } from "./ThisMacSection";

const KEEP = [5, 10, 25, 50, 100];
const KEYS: Array<[DictationAction, string]> = [["talk", "Talk"], ["history", "History"], ["file", "Transcribe a file"], ["cancel", "Cancel"]];

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
          description="Talk, and the words go where the cursor is."
          status={d.on && d.needs ? <Status tone="attention">Needs {d.needs}</Status> : undefined}
          control={
            <>
              {d.on && <Button size="sm" variant="outline" onClick={() => set("guide")}>Set up dictation</Button>}
              <Switch checked={d.on} aria-label="Dictation" onCheckedChange={(on) => set("on", on ? "1" : "0")} />
            </>
          }
        />
        {d.on && (
          <>
            {KEYS.map(([action, title]) => (
              <Row
                key={action}
                id={`dictation-key-${action}`}
                title={title}
                description={action === "talk" ? "Tap to start and stop, or hold a key like fn while you talk." : undefined}
                control={
                  <Button size="sm" variant="outline" className="min-w-24" aria-label={`${title} key`} onClick={() => set("pick", action)}>
                    {d.picking === action ? "Press a key…" : d.keys[action] || "Choose"}
                  </Button>
                }
              />
            ))}
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
              description="The last recordings, to copy or transcribe again."
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
              description="Audio or video, on this Mac."
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
