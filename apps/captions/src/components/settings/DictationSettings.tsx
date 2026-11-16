import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, InUse, ListRow, Row, RowMenu, Section, SettingsSelect, Status } from "./ui";
import { tell, type DictationAction, type ThisMacState } from "./ThisMacSection";

const KEEP = [5, 10, 25, 50, 100];
const NAMES: Record<DictationAction, string> = { talk: "Talk", history: "History", file: "Transcribe a file", cancel: "Cancel" };
/** What each of the Mac's models is good at, in a few words; a model this page doesn't know shows its size alone. */
const GOOD_AT: Record<string, string> = {
  "whisper-large-v3-turbo": "Most accurate · every language",
  "parakeet-tdt-0.6b-v3": "Fastest · 25 European languages",
  "parakeet-tdt-0.6b-v2": "Fastest",
  "whisper-small": "Quicker, less accurate · every language",
  "whisper-small.en": "Quicker, less accurate",
  "whisper-base.en": "Smallest, least accurate",
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
      className="sm:w-72"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => e.key === "Enter" && done()}
    />
  );
}

/**
 * Dictation on this Mac (apps/mac Dictation.swift): shown only where the app reports it. The app keeps every value; each
 * change goes to it as `dictation:<what>:<value>` and comes back in its next answer.
 */
export function Dictation({ mac, serverNeeds }: { mac: ThisMacState | null; serverNeeds?: string }) {
  const d = mac?.dictation;
  if (!d) return null;
  const set = (what: string, value = "") => tell(`dictation:${what}:${value}`);
  const key = (action: DictationAction) => (
    <Button size="sm" variant="outline" className="min-w-24" aria-label={`${NAMES[action]} key`} title="Change key" onClick={() => set("pick", action)}>
      <Keyboard className="text-muted-foreground" aria-hidden />
      {d.picking === action ? "Press a key…" : d.keys[action] || "Choose key"}
    </Button>
  );
  // the app downloads one model at a time
  const downloading = d.models.some((m) => m.progress !== null);
  const keep = KEEP.includes(d.keep) ? KEEP : [...KEEP, d.keep].sort((a, b) => a - b);
  return (
    <Section title="Dictation">
      <Card>
        <Row
          id="dictation"
          title="Dictation"
          description="Talk, and the words go where the cursor is."
          status={!d.on ? undefined : d.paused ? d.paused : d.needs ? <Status tone="attention">Needs {d.needs}</Status> : undefined}
          control={
            <>
              {d.on && <Button size="sm" variant="outline" onClick={() => set("guide")}>Open setup</Button>}
              <Switch checked={d.on} aria-label="Dictation" onCheckedChange={(on) => set("on", on ? "1" : "0")} />
            </>
          }
        />
        {d.on && (
          <>
            <Row id="dictation-key-talk" title="Talk" description="Tap, or hold while you talk." control={key("talk")} />
            <Row id="dictation-key-cancel" title="Cancel" description="Stops without pasting." control={key("cancel")} />
            <Row
              id="dictation-sounds"
              title="Sound cues"
              control={<Switch checked={d.sounds} aria-label="Sound cues" onCheckedChange={(on) => set("sounds", on ? "1" : "0")} />}
            />
            <Row
              id="dictation-history"
              title="History"
              description="Recent recordings, to copy or redo."
              control={
                <>
                  <SettingsSelect
                    label="Recordings kept"
                    value={String(d.keep)}
                    onValueChange={(v) => set("keep", v)}
                    options={keep.map((n) => ({ value: String(n), label: `Keep ${n}` }))}
                    className="sm:min-w-28"
                  />
                  {key("history")}
                  <Button size="sm" variant="outline" onClick={() => set("history")}>Open</Button>
                </>
              }
            />
            <Row
              id="dictation-file"
              title="Transcribe a file"
              description="Audio or video, on this Mac."
              control={
                <>
                  {key("file")}
                  <Button size="sm" variant="outline" onClick={() => set("file")}>Open</Button>
                </>
              }
            />
            {d.engine && (
              <Row
                id="dictation-engine"
                title="Transcribed by"
                status={d.engine === "server" && serverNeeds ? <Status tone="attention">{serverNeeds}</Status> : undefined}
                control={
                  <SettingsSelect
                    label="Transcribed by"
                    value={d.engine}
                    onValueChange={(v) => set("engine", v)}
                    options={[{ value: "mac", label: d.server ? "Your server, then this Mac" : "This Mac" }, { value: "server", label: "Deepgram or OpenAI (your key)" }]}
                  />
                }
              />
            )}
            {d.engine !== "server" && d.server !== undefined && (
              <Row
                id="dictation-server"
                title="Speech server"
                description={d.server ? undefined : "Your own server's address. Tried first, then this Mac."}
                status={d.server && d.serverAnswers === false
                  ? <Status tone="attention">{d.models.find((m) => m.id === d.model)?.here ? "Not answering · this Mac transcribes for now" : "Not answering · recordings wait in History"}</Status>
                  : undefined}
                control={<ServerField value={d.server} save={(v) => set("server", v)} />}
              />
            )}
            {d.engine !== "server" && (
              <Row id="dictation-model" title="Speech model on this Mac" description={d.server ? "Used when your server doesn't answer." : undefined}>
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
                          : chosen && !m.here ? <Status tone="attention">Chosen, not on this Mac yet</Status>
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
              </Row>
            )}
          </>
        )}
      </Card>
    </Section>
  );
}
