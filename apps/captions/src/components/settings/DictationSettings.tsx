import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { confirmDialog } from "@/lib/dialogs";
import { Card, Row, Section, SettingsSelect, Status } from "./ui";
import { tell, type ThisMacState } from "./ThisMacSection";

const KEEP = [5, 10, 25, 50, 100];

/**
 * Dictation on this Mac (apps/mac Dictation.swift): shown only where the app reports it. The app keeps every value; each
 * change goes to it as `dictation:<what>:<value>` and comes back in its next answer.
 */
export function Dictation({ mac, serverNeeds }: { mac: ThisMacState | null; serverNeeds?: string }) {
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
          status={d.paused ?? (d.on && d.needs ? <Status tone="attention">Needs {d.needs}</Status> : undefined)}
          control={
            <>
              {d.on && d.needs && !d.paused && <Button size="sm" variant="outline" onClick={() => set("setup")}>Allow</Button>}
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
            {d.engine && (
              <Row
                id="dictation-engine"
                title="Engine"
                description={d.engine === "server" ? "Your Deepgram or OpenAI key, as Talking to the assistant uses them." : undefined}
                status={d.engine === "server" && serverNeeds ? <Status tone="attention">{serverNeeds}</Status> : undefined}
                control={
                  <SettingsSelect
                    label="Engine"
                    value={d.engine}
                    onValueChange={(v) => set("engine", v)}
                    options={[{ value: "mac", label: "This Mac" }, { value: "server", label: "Your server" }]}
                  />
                }
              />
            )}
            {d.engine !== "server" && <Row
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
            />}
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
