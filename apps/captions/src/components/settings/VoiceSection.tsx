import { useState } from "react";
import { SPEECH_USES, SPEECH_USE_NAMES, STT_MODELS, runsOn, sizeOn, type SpeechUse, type SpeechWord, type SttComputer, type SttEngine, type SttModel, type SttResolved, type VoiceView } from "@contracts/voice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { canSpeak, useReadAloud } from "@/lib/read-aloud";
import { LANGUAGES, SAME, engineOptions, languageName, modelOf, needWords, putModel, putVoice, useVoice, withLanguage, writeDown, type WrittenDown } from "@/lib/voice";
import { Card, EmptyRow, ErrorRow, ListRow, LoadingRow, Row, Section, SettingsSelect, Status, markSave, saveFailed } from "./ui";
import { msg } from "./helpers";

type Body = Parameters<typeof putVoice>[0];
/** Saves a change at once; resolves false when it failed (the form keeps what was typed). */
type Save = (body: Body, shown: VoiceView) => Promise<boolean> | void;

/**
 * Settings → Voice: the languages the person speaks, which engine turns speech into text (a default and one per use),
 * the speech models on their computers and the assistant's read-aloud (dictation has its own page, DictationSettings.tsx). Each choice saves at once; what each
 * use runs on comes from the server (`resolved`, api/lib/speech.ts), never worked out here. The language of a
 * workspace's videos is the workspace's own (Settings → Workspace → Details); one with none set uses the list here.
 */
export function VoiceSection() {
  const { data, error, refresh, set } = useVoice();
  // read-aloud is kept in this browser: it never waits for (or fails with) the server's voice settings
  if (!data)
    return (
      <div className="space-y-8">
        <Card>{error ? <ErrorRow title="Could not load the voice settings" detail={error} retry={() => void refresh().catch(() => {})} /> : <LoadingRow />}</Card>
        <TextToSpeech />
      </div>
    );
  const save = async (body: Body, shown: VoiceView): Promise<boolean> => {
    set(shown);
    try {
      set(await markSave(putVoice(body)));
      return true;
    } catch (e) {
      set(data);
      saveFailed(msg(e));
      return false;
    }
  };
  const want = async (computer: string, model: string, keep: boolean) => {
    try {
      set(await putModel(computer, model, keep));
    } catch (e) {
      saveFailed(msg(e));
    }
  };
  return <VoiceBody view={data} save={save} want={(c, m, k) => void want(c, m, k)} />;
}

export function VoiceBody({ view, save, want = () => {} }: { view: VoiceView; save: Save; want?: (computer: string, model: string, keep: boolean) => void }) {
  const setLanguages = (languages: string[]) => save({ languages }, { ...view, languages });
  const setChoice = (use: SpeechUse | "default", value: string) => {
    if (use === "default") {
      const choice = { engine: value as SttEngine };
      return save({ stt: { default: choice } }, { ...view, stt: { ...view.stt, default: choice } });
    }
    const per = { ...view.stt.per };
    if (value === SAME) delete per[use];
    else per[use] = { engine: value as SttEngine };
    save({ stt: { per: { [use]: value === SAME ? null : { engine: value } } } }, { ...view, stt: { ...view.stt, per } });
  };
  const unused = LANGUAGES.filter((c) => !view.languages.includes(c));

  return (
    <div className="space-y-8">
      <Section title="Languages">
        <Card>
          <Row
            id="voice-languages"
            title="Spoken languages"
            description="Used for dictation, talking to the assistant, and videos in a workspace with no language set."
            control={
              <SettingsSelect
                label="Add language"
                value="add"
                onValueChange={(c) => c !== "add" && setLanguages(withLanguage(view, c, true))}
                options={[{ value: "add", label: "Add language" }, ...unused.map((c) => ({ value: c, label: languageName(c) }))]}
              />
            }
          />
          {view.languages.map((c) => (
            <ListRow
              key={c}
              title={languageName(c)}
              actions={<Button size="sm" variant="outline" aria-label={`Remove ${languageName(c)}`} onClick={() => setLanguages(withLanguage(view, c, false))}>Remove</Button>}
            />
          ))}
        </Card>
      </Section>

      <Section title="Speech to text">
        <Card>
          <Row
            id="stt-default"
            title="Default engine"
            status={<Runs r={view.resolvedDefault} full />}
            control={<SettingsSelect label="Default engine" value={view.stt.default.engine} onValueChange={(v) => setChoice("default", v)} options={engineOptions(view.available, view.stt.default.engine, true)} />}
          />
          {SPEECH_USES.map((use) => {
            const own = view.stt.per[use];
            const r = view.resolved.find((x) => x.use === use);
            return (
              <Row
                key={use}
                id={`stt-use-${use}`}
                title={SPEECH_USE_NAMES[use]}
                // why it runs on another engine than the one picked (the AI Editor: English edits only on computers)
                description={r && "note" in r ? r.note : undefined}
                // a use that follows the Default shares its need: the Default's row says it once; a need of its own
                // (the Default runs on a computer, this use can't) is said here
                status={r && (own || !("needs" in r) || !("needs" in view.resolvedDefault)) && <Runs r={r} full={!!own} />}
                control={
                  <SettingsSelect label={`${SPEECH_USE_NAMES[use]} engine`} value={own?.engine ?? SAME} onValueChange={(v) => setChoice(use, v)} options={engineOptions(view.availableFor[use], own?.engine, false)} />
                }
              />
            );
          })}
        </Card>
      </Section>

      <WordsSection view={view} save={save} />

      <SpeechModels computers={view.computers} want={want} />

      <MicrophoneTest />

      <TextToSpeech />
    </div>
  );
}

/**
 * Names and terms every engine listens for, and what they are misheard as (contracts/voice.ts SpeechWord). Each add or
 * remove saves at once; a word that fails to save stays in the form.
 */
function WordsSection({ view, save }: { view: VoiceView; save: Save }) {
  const words = view.words ?? [];
  const [term, setTerm] = useState("");
  const [like, setLike] = useState("");
  const [missing, setMissing] = useState<string | null>(null);
  const put = (next: SpeechWord[]) => save({ words: next }, { ...view, words: next });
  const add = async () => {
    const t = term.trim();
    if (!t) return setMissing("Type the word first");
    setMissing(null);
    const soundsLike = like.split(",").map((s) => s.trim()).filter(Boolean);
    if ((await put([...words, { term: t, soundsLike }])) !== false) {
      setTerm("");
      setLike("");
    }
  };
  return (
    <Section title="Custom words">
      <Card>
        {words.length ? (
          words.map((w) => (
            <ListRow
              key={w.term}
              title={w.term}
              subtitle={w.soundsLike.length ? `Sounds like ${w.soundsLike.join(", ")}` : undefined}
              actions={
                <Button size="sm" variant="outline" aria-label={`Remove ${w.term}`} onClick={() => void put(words.filter((x) => x !== w))}>
                  Remove
                </Button>
              }
            />
          ))
        ) : (
          <EmptyRow title="No words" description="Names and terms the speech engines should get right." />
        )}
        <Row title="Word" control={<Input aria-label="Word" value={term} onChange={(e) => setTerm(e.target.value)} className="w-56" />} />
        <Row
          title="Sounds like"
          description="Misheard spellings, separated by commas."
          status={missing ? <Status tone="attention">{missing}</Status> : undefined}
          control={
            <div className="flex items-center gap-2">
              <Input aria-label="Sounds like" value={like} onChange={(e) => setLike(e.target.value)} className="w-56" />
              <Button size="sm" variant="outline" onClick={() => void add()}>
                Add word
              </Button>
            </div>
          }
        />
      </Card>
    </Section>
  );
}

const WROTE: Record<string, string> = { device: "This Mac's model", computer: "your computer", deepgram: "Deepgram", openai: "OpenAI" };

/** Records five seconds and writes them down the way the assistant's voice input does; shows the words and what wrote them. */
function MicrophoneTest() {
  const [phase, setPhase] = useState<"idle" | "recording" | "writing">("idle");
  const [result, setResult] = useState<WrittenDown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const test = async () => {
    setError(null);
    setResult(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return setError("Microphone testing is unavailable in this browser.");
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.addEventListener("dataavailable", (e) => e.data.size && chunks.push(e.data));
      const stopped = new Promise<void>((resolve) => recorder.addEventListener("stop", () => resolve(), { once: true }));
      recorder.start();
      setPhase("recording");
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      recorder.stop();
      await stopped;
      setPhase("writing");
      setResult(await writeDown(new Blob(chunks, { type: recorder.mimeType })));
    } catch (e) {
      setError(msg(e));
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      setPhase("idle");
    }
  };
  return (
    <Section title="Microphone">
      <Card>
        <Row
          title="Test"
          description="Records five seconds and writes them down as the assistant does."
          status={
            error ? (
              <Status tone="attention">{error}</Status>
            ) : result ? (
              <>
                {result.text ? `“${result.text}”` : "No words heard"} · written by {WROTE[result.engine] ?? result.engine}
                {result.note ? ` · ${result.note}` : ""}
              </>
            ) : phase !== "idle" ? (
              phase === "recording" ? "Recording" : "Writing it down"
            ) : undefined
          }
          control={
            <Button size="sm" variant="outline" disabled={phase !== "idle"} onClick={() => void test()}>
              Record
            </Button>
          }
        />
      </Card>
    </Section>
  );
}

/** The models a computer can download: one row each per computer, with where it comes from and its licence. */
const COMPUTER_MODELS = STT_MODELS.filter((m) => m.computer);

const sizeText = (mb: number | undefined) => (mb ? (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`) : null);
/** A model in one line: what it is good at and its size, nothing else. */
const lineOf = (m: SttModel, os?: string) => [m.about, sizeText(sizeOn(m, os))].filter(Boolean).join(" · ");

/**
 * Speech models on the person's own computers: nothing downloads until Download is pressed, and the strongest computer
 * that has a model does the work. Computers are added on their own page (Settings → Computers).
 */
function SpeechModels({ computers, want }: { computers: SttComputer[]; want: (computer: string, model: string, keep: boolean) => void }) {
  return (
    <Section title="Speech models">
      {computers.length ? (
        computers.map((c) => (
          <Card key={c.id}>
            <Row title={c.name} status={c.online ? undefined : "Offline"} />
            {COMPUTER_MODELS.filter((m) => runsOn(m, c.os, c.version) || c.models.some((x) => x.id === m.id)).map((m) => {
              const has = c.models.find((x) => x.id === m.id);
              return (
                <Row
                  key={m.id}
                  title={m.name}
                  // its maker and licence, linked to the model's own page: the credit an open model's licence asks for
                  status={
                    <>
                      {lineOf(m, c.os)} ·{" "}
                      <a href={m.page} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                        {m.by && !m.name.includes(m.by) ? `${m.by}, ` : ""}
                        {m.licence}
                      </a>
                    </>
                  }
                  control={
                    !has ? (
                      <Button size="sm" variant="outline" onClick={() => want(c.id, m.id, true)}>Download</Button>
                    ) : has.state === "ready" ? (
                      <Button size="sm" variant="outline" onClick={() => want(c.id, m.id, false)}>Remove</Button>
                    ) : (
                      <span className="flex items-center gap-2 text-sm text-muted-foreground">
                        {has.state === "downloading" ? "Downloading" : c.online ? "Starting" : "Waiting for the computer"}
                        <Button size="sm" variant="ghost" onClick={() => want(c.id, m.id, false)}>Cancel</Button>
                      </span>
                    )
                  }
                />
              );
            })}
          </Card>
        ))
      ) : (
        <Card>
          <EmptyRow title="No computers" />
        </Card>
      )}
    </Section>
  );
}

/** What a row runs on now: the model (its name; with `full` also what it is good at and its size), or what it needs. */
function Runs({ r, full }: { r: SttResolved; full?: boolean }) {
  if ("needs" in r) return <Status tone="attention">{needWords(r)}</Status>;
  const m = modelOf(r.model);
  if (!m) return <>{r.model}</>;
  return <>{full ? `${m.name}: ${lineOf(m)}` : m.name}</>;
}

/** The assistant's read-aloud add-on (lib/read-aloud.ts): off until switched on here; the voice downloads then. */
export function TextToSpeech() {
  const { on, loading, toggle } = useReadAloud();
  if (!canSpeak()) return null;
  return (
    <Section title="Text to speech">
      <Card>
        <Row
          id="read-aloud"
          title="Read replies aloud"
          description={loading !== null ? `Downloading the voice · ${Math.round(loading * 100)}%` : "The voice downloads once, about 90 MB."}
          control={<Switch checked={on} aria-label="Read replies aloud" onCheckedChange={toggle} />}
        />
      </Card>
    </Section>
  );
}
