import { Link } from "react-router";
import { ExternalLink, X } from "lucide-react";
import { SPEECH_USES, SPEECH_USE_NAMES, STT_MODELS, type SpeechUse, type SttComputer, type SttEngine, type SttModel, type SttResolved, type VoiceView } from "@contracts/voice";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { canSpeak, useReadAloud } from "@/lib/read-aloud";
import { LANGUAGES, SAME, engineOptions, keyFix, languageName, modelOf, needWords, putModel, putVoice, useVoice, withLanguage } from "@/lib/voice";
import { Card, ErrorRow, LoadingRow, Row, Section, SettingsSelect, Status, saveFailed } from "./ui";
import { msg } from "./helpers";

type Body = Parameters<typeof putVoice>[0];

/**
 * Settings → AI → Voice: the languages spoken in the person's videos, which engine turns speech into text (a default
 * and one per use), and the assistant's read-aloud. Each choice saves at once; what each use runs on comes from the
 * server (`resolved`, api/lib/speech.ts), never worked out here.
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
  const save = async (body: Body, shown: VoiceView) => {
    set(shown);
    try {
      set(await putVoice(body));
    } catch (e) {
      set(data);
      saveFailed(msg(e));
    }
  };
  const want = async (computer: string, model: string, keep: boolean) => {
    try {
      set(await putModel(computer, model, keep));
    } catch (e) {
      saveFailed(msg(e));
    }
  };
  return <VoiceBody view={data} save={(body, shown) => void save(body, shown)} want={(c, m, k) => void want(c, m, k)} />;
}

export function VoiceBody({ view, save, want = () => {} }: { view: VoiceView; save: (body: Body, shown: VoiceView) => void; want?: (computer: string, model: string, keep: boolean) => void }) {
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
            title="Spoken in your videos"
            status={view.languages.length ? undefined : "Detect it"}
            control={
              <SettingsSelect
                label="Add a language"
                value="add"
                onValueChange={(c) => c !== "add" && setLanguages(withLanguage(view, c, true))}
                options={[{ value: "add", label: "Add a language" }, ...unused.map((c) => ({ value: c, label: languageName(c) }))]}
              />
            }
          >
            {view.languages.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {view.languages.map((c) => (
                  <Button key={c} size="sm" variant="secondary" aria-label={`Remove ${languageName(c)}`} onClick={() => setLanguages(withLanguage(view, c, false))}>
                    {languageName(c)}
                    <X />
                  </Button>
                ))}
              </div>
            )}
          </Row>
        </Card>
      </Section>

      <Section title="Speech to text">
        <Card>
          <Row
            id="stt-default"
            title="Default"
            status={<Runs r={view.resolvedDefault} full />}
            control={<SettingsSelect label="Default: engine" value={view.stt.default.engine} onValueChange={(v) => setChoice("default", v)} options={engineOptions(view.available, view.stt.default.engine, true)} />}
          />
          {SPEECH_USES.map((use) => {
            const own = view.stt.per[use];
            const r = view.resolved.find((x) => x.use === use);
            return (
              <Row
                key={use}
                id={`stt-use-${use}`}
                title={SPEECH_USE_NAMES[use]}
                // a use that follows the Default shares its need: the Default's row says it once
                status={r && (own || !("needs" in r)) && <Runs r={r} full={!!own} />}
                control={
                  <SettingsSelect label={`${SPEECH_USE_NAMES[use]}: engine`} value={own?.engine ?? SAME} onValueChange={(v) => setChoice(use, v)} options={engineOptions(view.availableFor[use], own?.engine, false)} />
                }
              />
            );
          })}
        </Card>
      </Section>

      <OnMyComputers computers={view.computers} want={want} />

      <TextToSpeech />
    </div>
  );
}

/** The models a computer can download: one row each per computer, with where it comes from and its licence. */
const COMPUTER_MODELS = STT_MODELS.filter((m) => m.computer);

/** A model's origin in one line: who made it, its licence, its size, its page. */
function Origin({ m }: { m: SttModel }) {
  return (
    <>
      {m.by ? `By ${m.by}` : null}
      {m.by ? " · " : null}
      {m.licence}
      {m.mb ? ` · ${(m.mb / 1000).toFixed(1)} GB` : null} ·{" "}
      <a href={m.page} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
        Model page
        <ExternalLink className="size-3" aria-hidden />
      </a>
    </>
  );
}

/**
 * Speech models on the person's own computers: nothing downloads until Download is pressed, and the strongest computer
 * that has a model does the work. No computer runs them yet: the button that adds one.
 */
function OnMyComputers({ computers, want }: { computers: SttComputer[]; want: (computer: string, model: string, keep: boolean) => void }) {
  return (
    <Section title="Models on your computers">
      {computers.length ? (
        computers.map((c) => (
          <Card key={c.id}>
            <Row title={c.name} status={c.online ? undefined : "Off"} />
            {COMPUTER_MODELS.map((m) => {
              const has = c.models.find((x) => x.id === m.id);
              return (
                <Row
                  key={m.id}
                  title={m.name}
                  status={<Origin m={m} />}
                  control={
                    !has ? (
                      <Button size="sm" variant="outline" onClick={() => want(c.id, m.id, true)}>Download</Button>
                    ) : has.state === "ready" ? (
                      <Button size="sm" variant="outline" onClick={() => want(c.id, m.id, false)}>Remove</Button>
                    ) : (
                      <span className="flex items-center gap-2 text-sm text-muted-foreground">
                        {has.state === "downloading" ? "Downloading" : c.online ? "Starting" : "When it's on"}
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
          <Row
            title="Run speech models on your own computers"
            control={
              <Button asChild size="sm" variant="outline">
                <Link to="/settings/devices">Add a computer</Link>
              </Button>
            }
          />
        </Card>
      )}
    </Section>
  );
}

/**
 * What a row runs on now: the model (its name; with `full` also what it is good at, its licence and its page), or
 * what it needs with the button that fixes it.
 */
function Runs({ r, full }: { r: SttResolved; full?: boolean }) {
  if ("needs" in r) {
    const to = keyFix(r.key);
    return (
      <span className="flex flex-wrap items-center gap-2">
        <Status tone="attention">{needWords(r)}</Status>
        {to && (
          <Button asChild size="sm" variant="outline">
            <Link to={to}>Add key</Link>
          </Button>
        )}
      </span>
    );
  }
  const m = modelOf(r.model);
  if (!m) return <>{r.model}</>;
  if (!full) return <>{m.name}</>;
  return (
    <>
      {m.name}{m.by && !m.name.includes(m.by) ? ` by ${m.by}` : ""}: {m.about} · {m.licence} ·{" "}
      <a href={m.page} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
        Model page
        <ExternalLink className="size-3" aria-hidden />
      </a>
    </>
  );
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
          title="Read the assistant's replies aloud"
          description={loading !== null ? `Downloading the voice · ${Math.round(loading * 100)}%` : "Downloads once, about 90 MB."}
          control={<Switch checked={on} aria-label="Read the assistant's replies aloud" onCheckedChange={toggle} />}
        />
      </Card>
    </Section>
  );
}
