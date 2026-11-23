import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useVoice } from "@/lib/voice";
import { Card, InUse, ListRow, LoadingRow, markSave, Row, RowMenu, Section, SettingsSelect, Status } from "./ui";
import { hasThisMac, tell, useThisMac, type DictationAction, type ThisMacState } from "./ThisMacSection";

/** Settings → Dictation (Mac app only): this Mac's dictation, and what the server's engine still needs for it. */
export function DictationSection() {
  const mac = useThisMac(hasThisMac());
  const { data } = useVoice();
  const mic = data?.resolved.find((r) => r.use === "mic");
  if (!mac?.dictation)
    return (
      <Card>
        {mac ? <Row title="Dictation" status={<Status tone="attention">Needs a newer Mac app</Status>} /> : <LoadingRow />}
      </Card>
    );
  return (
    <div className="space-y-8">
      <Dictation mac={mac} serverNeeds={mic && "needs" in mic ? mic.needs : undefined} />
    </div>
  );
}

const KEEP = [5, 10, 25, 50, 100];
/** Each key's row: its title, and what the key does in one sentence. */
const KEYS: Record<DictationAction, { title: string; does?: string }> = {
  talk: { title: "Talk", does: "Starts dictation on a tap, or while it is held." },
  cancel: { title: "Cancel", does: "Stops dictation without typing the words." },
  history: { title: "History", does: "Opens the recent recordings." },
  file: { title: "File transcription", does: "Opens file transcription." },
};
/** What each of the Mac's models is good at, in a few words; a model this page doesn't know shows its size alone. */
const GOOD_AT: Record<string, string> = {
  "whisper-large-v3-turbo": "Most accurate · every language",
  "parakeet-tdt-0.6b-v3": "Fastest · 25 European languages",
  "parakeet-tdt-0.6b-v2": "Fastest · English",
  "whisper-small": "Quicker, less accurate · every language",
  "whisper-small.en": "Quicker, less accurate · English",
  "whisper-base.en": "Smallest, least accurate · English",
};

/** The speech server's address, saved on Enter or when the field loses focus; empty for none. */
function ServerField({ value, save }: { value: string; save: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const done = () => text.trim() !== value && save(text.trim());
  return (
    <Input
      aria-label="Speech server"
      placeholder="https://…/api/transcribe"
      className="sm:w-64"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => e.key === "Enter" && done()}
    />
  );
}

/**
 * Dictation on this Mac (apps/mac Dictation.swift): shown only where the app reports it. The app keeps every value; each
 * change goes to it as `dictation:<what>:<value>` and comes back in its next answer. Every row does one thing: a key's
 * button changes that key, Open opens that window, and the Mac's models are a list of their own under the settings.
 */
export function Dictation({ mac, serverNeeds }: { mac: ThisMacState | null; serverNeeds?: string }) {
  const d = mac?.dictation;
  if (!d) return null;
  const set = (what: string, value = "") => tell(`dictation:${what}:${value}`);
  // a setting the Mac app keeps (told, not answered), marked in the header like every other change
  const pref = (what: string, value: string) => void markSave(set(what, value));
  // the button shows the key and changes it
  const key = (action: DictationAction, id?: "dictation-key-talk" | "dictation-key-cancel") => (
    <Row
      id={id}
      title={KEYS[action].title}
      description={KEYS[action].does}
      control={
        <Button size="sm" variant="outline" className="min-w-24" aria-label={`${KEYS[action].title} key`} title="Change key" onClick={() => set("pick", action)}>
          <Keyboard className="text-muted-foreground" aria-hidden />
          {d.picking === action ? "Press a key…" : d.keys[action] || "Not set"}
        </Button>
      }
    />
  );
  const open = (what: string, label: string) => <Button size="sm" variant="outline" aria-label={label} onClick={() => set(what)}>Open</Button>;
  // the app downloads one model at a time
  const downloading = d.models.some((m) => m.progress !== null);
  const keep = KEEP.includes(d.keep) ? KEEP : [...KEEP, d.keep].sort((a, b) => a - b);
  return (
    <>
      <Section title="Dictation">
        <Card>
          <Row
            id="dictation"
            title="Dictation"
            description="Types what is said at the cursor."
            status={!d.on ? undefined : d.paused ? d.paused : d.needs ? <Status tone="attention">Needs {d.needs}</Status> : undefined}
            control={<Switch checked={d.on} aria-label="Dictation" onCheckedChange={(on) => pref("on", on ? "1" : "0")} />}
          />
          {d.on && (
            <>
              <Row title="Setup" control={open("guide", "Open setup")} />
              <Row
                id="dictation-sounds"
                title="Sound cues"
                control={<Switch checked={d.sounds} aria-label="Sound cues" onCheckedChange={(on) => pref("sounds", on ? "1" : "0")} />}
              />
            </>
          )}
        </Card>
      </Section>
      {d.on && (
        <>
          <Section title="Keys">
            <Card>
              {key("talk", "dictation-key-talk")}
              {key("cancel", "dictation-key-cancel")}
              {key("history")}
              {key("file")}
            </Card>
          </Section>
          <Section title="History">
            <Card>
              <Row id="dictation-history" title="Recent recordings" description="Copy or redo a recent dictation." control={open("history", "Open history")} />
              <Row
                title="Recordings kept"
                control={
                  <SettingsSelect
                    label="Recordings kept"
                    value={String(d.keep)}
                    onValueChange={(v) => pref("keep", v)}
                    options={keep.map((n) => ({ value: String(n), label: String(n) }))}
                    className="sm:min-w-28"
                  />
                }
              />
              <Row id="dictation-file" title="File transcription" description="Transcribes an audio or video file on this Mac." control={open("file", "Open file transcription")} />
            </Card>
          </Section>
          {(d.engine || (d.engine !== "server" && d.server !== undefined)) && (
            <Section title="Transcription">
              <Card>
                {d.engine && (
                  <Row
                    id="dictation-engine"
                    title="Engine"
                    status={d.engine === "server" && serverNeeds ? <Status tone="attention">{serverNeeds}</Status> : undefined}
                    control={
                      <SettingsSelect
                        label="Dictation engine"
                        value={d.engine}
                        onValueChange={(v) => pref("engine", v)}
                        options={[{ value: "mac", label: d.server ? "Your server, then this Mac" : "This Mac" }, { value: "server", label: "Deepgram or OpenAI (your key)" }]}
                      />
                    }
                  />
                )}
                {d.engine !== "server" && d.server !== undefined && (
                  <Row
                    id="dictation-server"
                    title="Speech server"
                    description={d.server ? undefined : "The address of a speech server of your own, tried before this Mac."}
                    status={d.server && d.serverAnswers === false
                      ? <Status tone="attention">{d.models.find((m) => m.id === d.model)?.here ? "Offline · transcribed on this Mac" : "Offline · recordings kept in History"}</Status>
                      : undefined}
                    control={<ServerField value={d.server} save={(v) => set("server", v)} />}
                  />
                )}
              </Card>
            </Section>
          )}
        </>
      )}
      {d.on && d.engine !== "server" && (
        <Section id="dictation-model" title="Model">
          <Card>
            {d.models.map((m) => {
              const chosen = m.id === d.model;
              return (
                <ListRow
                  key={m.id}
                  title={m.name}
                  subtitle={[GOOD_AT[m.id], m.size].filter(Boolean).join(" · ")}
                  status={
                    m.progress !== null ? `Downloading · ${Math.round(m.progress * 100)}% of ${m.size}`
                    : chosen && !m.here ? <Status tone="attention">Needs download</Status>
                    : undefined
                  }
                  actions={
                    <>
                      {m.progress !== null && d.cancel && (
                        <Button size="sm" variant="ghost" aria-label={`Cancel the download of ${m.name}`} onClick={() => set("cancel", m.id)}>Cancel</Button>
                      )}
                      {chosen && m.here && <InUse>In use</InUse>}
                      {!chosen && m.here && <Button size="sm" variant="outline" aria-label={`Use ${m.name}`} onClick={() => set("model", m.id)}>Use</Button>}
                      {!m.here && m.progress === null && (
                        <Button size="sm" variant="outline" aria-label={`Download ${m.name}`} disabled={downloading} onClick={() => set("download", m.id)}>Download</Button>
                      )}
                      {/* the menu's room is kept on every row, so the buttons line up */}
                      {!m.removable && <span className="size-7 shrink-0" aria-hidden />}
                      {m.removable && (
                        <RowMenu
                          label={`${m.name}: more`}
                          items={[{
                            label: "Remove",
                            destructive: true,
                            confirm: { title: `Remove ${m.name}?`, body: `Downloading it again is ${m.size}.`, ok: "Remove" },
                            onSelect: () => set("remove", m.id),
                          }]}
                        />
                      )}
                    </>
                  }
                />
              );
            })}
          </Card>
        </Section>
      )}
    </>
  );
}
