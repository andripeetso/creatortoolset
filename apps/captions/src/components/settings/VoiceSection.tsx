import { Link } from "react-router";
import { ExternalLink, X } from "lucide-react";
import { SPEECH_USES, SPEECH_USE_NAMES, type SpeechUse, type SttEngine, type SttResolved, type VoiceView } from "@contracts/voice";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { canSpeak, useReadAloud } from "@/lib/read-aloud";
import { LANGUAGES, SAME, engineOptions, keyFix, languageName, modelOf, putVoice, useVoice, withLanguage } from "@/lib/voice";
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
  if (!data) return <Card>{error ? <ErrorRow title="Could not load the voice settings" detail={error} retry={() => void refresh().catch(() => {})} /> : <LoadingRow />}</Card>;
  const save = async (body: Body, shown: VoiceView) => {
    set(shown);
    try {
      set(await putVoice(body));
    } catch (e) {
      set(data);
      saveFailed(msg(e));
    }
  };
  return <VoiceBody view={data} save={(body, shown) => void save(body, shown)} />;
}

export function VoiceBody({ view, save }: { view: VoiceView; save: (body: Body, shown: VoiceView) => void }) {
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
  // the Default's model: what a use that follows it runs on now
  const followsDefault = view.resolved.find((r) => !view.stt.per[r.use]);
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
            status={followsDefault && <Runs r={followsDefault} engine={view.stt.default.engine} full />}
            control={<SettingsSelect label="Default: engine" value={view.stt.default.engine} onValueChange={(v) => setChoice("default", v)} options={engineOptions(view, view.stt.default.engine, true)} />}
          />
          {SPEECH_USES.map((use) => {
            const own = view.stt.per[use];
            const r = view.resolved.find((x) => x.use === use);
            return (
              <Row
                key={use}
                id={`stt-use-${use}`}
                title={SPEECH_USE_NAMES[use]}
                status={r && <Runs r={r} engine={own?.engine ?? view.stt.default.engine} full={!!own} />}
                control={
                  <SettingsSelect label={`${SPEECH_USE_NAMES[use]}: engine`} value={own?.engine ?? SAME} onValueChange={(v) => setChoice(use, v)} options={engineOptions(view, own?.engine, false)} />
                }
              />
            );
          })}
        </Card>
      </Section>

      <TextToSpeech />
    </div>
  );
}

/**
 * What a row runs on now: the model (its name; with `full` also what it is good at, its licence and its page), or
 * what it needs with the button that fixes it.
 */
function Runs({ r, engine, full }: { r: SttResolved; engine: SttEngine; full?: boolean }) {
  if ("needs" in r) {
    const to = keyFix(engine);
    return (
      <span className="flex flex-wrap items-center gap-2">
        <Status tone="attention">{r.needs}</Status>
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
      {m.name}: {m.about} · {m.licence} ·{" "}
      <a href={m.page} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
        Model page
        <ExternalLink className="size-3" aria-hidden />
      </a>
    </>
  );
}

/** The assistant's read-aloud add-on (lib/read-aloud.ts): off until switched on here; the voice downloads then. */
function TextToSpeech() {
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
