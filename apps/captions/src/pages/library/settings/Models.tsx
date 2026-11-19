import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { LIBRARY_WORDS, WATCH_MODELS, levelOf, watchModelOf, type AnalysisLevel, type LibrarySettings, type WatchModel } from "@contracts/library";
import { STT_MODELS, runsOn } from "@contracts/voice";
import { Button } from "@/components/ui/button";
import { Card, Row, Status, saveFailed } from "@/components/settings/ui";
import { useMyKeys } from "@/components/settings/MyKeysSection";
import { msg } from "@/components/settings/helpers";
import { activeSet, effectiveSelection, modelName, modelsOf, saveOwn, useProviders } from "@/lib/providers";
import { SAME, modelOf, needWords, putModel, putVoice, useVoice } from "@/lib/voice";
import { RadioList } from "./RadioList";

/**
 * The model each of the person's own rows works with now, as their AI and Voice pages resolve it (the same source for
 * Settings → Media Library and the setup sheet). "Not set" until those pages have loaded or when nothing answers.
 */
export function useModelsInUse(): { descriptions: string; transcripts: string } {
  const providers = useProviders().data;
  const voice = useVoice().data;
  const active = providers ? activeSet(providers) : null;
  const sel = active ? (active.settings.jobs.library ?? active.settings.default) : null;
  const inst = active && sel ? active.settings.instances.find((i) => i.id === sel.instance) : undefined;
  const descModel = active && providers && inst ? effectiveSelection(active.settings, inst, modelsOf(providers, inst)).model : (sel?.model ?? "");
  const r = voice?.resolvedDefault;
  const transcripts = !r ? "" : "needs" in r ? needWords(r) : (modelOf(r.model)?.name ?? r.model);
  return { descriptions: descModel ? modelName(descModel) : "", transcripts };
}

type Opt = { value: string; label: string; note: string; chip?: ReactNode; disabled?: boolean };

/** A state chip: the key a model needs, with the link to API keys. */
function NeedsKey({ text }: { text: string }) {
  return (
    <>
      <Status tone="attention">{text}</Status>{" "}
      <Link to="/settings/keys" className="underline underline-offset-4 hover:underline">
        {LIBRARY_WORDS.apiKeys}
      </Link>
    </>
  );
}

/** One Models row: the value in use on the right; a click opens its options as a radio list under it. */
function ModelRow({ name, title, tip, value, selected, options, onPick }: { name: string; title: string; tip: string; value: string; selected: string; options: () => Opt[]; onPick: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Row
      title={title}
      tip={tip}
      control={
        <Button size="sm" variant="outline" aria-label={title} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {value}
        </Button>
      }
    >
      {open && options().length === 0 && (
        // nothing to pick yet (no AI connected): say so and point where one is added, never an empty list
        <p className="pt-2 text-sm text-muted-foreground">
          {LIBRARY_WORDS.noModelsYet}{" "}
          <Link to="/settings/providers" className="underline underline-offset-4 hover:underline">
            {LIBRARY_WORDS.providers}
          </Link>
        </p>
      )}
      {open && options().length > 0 && (
        <RadioList
          name={name}
          value={selected}
          options={options().map((o) => ({ value: o.value, label: o.label, disabled: o.disabled, status: o.chip ? <>{o.note} · {o.chip}</> : o.note }))}
          onChange={onPick}
        />
      )}
    </Row>
  );
}

/**
 * The Models rows (UNIFIED-PRD §3.1 Models, Rulings 11-19), shared by Settings → Media Library and setup step 4. A row
 * whose work is off at this effort is hidden: Descriptions and Transcripts from Low, Video breakdown from High (its flag).
 * Each row writes its own store: Descriptions the person's AI-by-job pick (jobs.library), Transcripts the person's Voice
 * choice for transcripts, Video breakdown the library's timelineModel (`video`, `onVideo`).
 */
export function ModelRows({ level, timeline, transcribe, video, onVideo }: { level: AnalysisLevel; timeline: boolean; transcribe: boolean; video: WatchModel; onVideo: (v: WatchModel) => void }) {
  const inUse = useModelsInUse();
  const providers = useProviders();
  const voice = useVoice();
  const keys = useMyKeys().data;
  const view = providers.data;
  const stt = voice.data;
  const computers = stt?.computers ?? [];

  // a key the person has not added: its chip (only once the key list has answered)
  const missingKey = (env: string): ReactNode => {
    const k = Array.isArray(keys) ? keys.find((x) => x.env === env) : undefined;
    return k && !(k.set || k.server) ? <NeedsKey text={LIBRARY_WORDS.needsKey(k.name)} /> : undefined;
  };

  // Descriptions: the person's own set (the set that answers them; a member's or admin's without its own starts as a copy)
  const base = view ? (activeSet(view)?.settings ?? null) : null;
  const descOpts: Opt[] =
    view && base
      ? base.instances.map((i) => {
          const chip = i.driver === "gemini" ? missingKey("GEMINI_API_KEY") : undefined;
          return { value: i.id, label: modelName(effectiveSelection(base, i, modelsOf(view, i)).model), note: i.name, chip, disabled: !i.enabled || !!chip };
        })
      : [];
  const descSel = base ? (base.jobs.library ?? base.default).instance : "";
  const pickDesc = (id: string) => {
    const inst = view && base ? base.instances.find((i) => i.id === id) : undefined;
    if (!view || !base || !inst) return;
    const { model, effort } = effectiveSelection(base, inst, modelsOf(view, inst));
    saveOwn({ ...base, jobs: { ...base.jobs, library: { instance: id, model, effort } } }).then(providers.set, (e) => saveFailed(msg(e)));
  };

  // Transcripts: the person's Voice choice for transcripts; a model on a computer shows Download until a computer has it
  const sttDefault = stt?.resolvedDefault;
  // built when its row opens: a Voice view without its speech lists (an older page) must not break the closed row
  const sttOpts = (): Opt[] =>
    stt
    ? [
        { value: SAME, label: LIBRARY_WORDS.sameAsDefault, note: !sttDefault ? "" : "needs" in sttDefault ? needWords(sttDefault) : (modelOf(sttDefault.model)?.name ?? sttDefault.model) },
        ...STT_MODELS.filter((m) => !m.computer || computers.some((c) => runsOn(m, c.os, c.version) || c.models.some((x) => x.id === m.id))).map((m): Opt => {
          if (m.engine === "deepgram" || m.engine === "openai") {
            const chip = stt.available.includes(m.engine) ? undefined : <NeedsKey text={needWords({ use: "transcripts", needs: "", key: m.engine === "deepgram" ? "DEEPGRAM_API_KEY" : "OPENAI_API_KEY" })} />;
            return { value: m.id, label: m.name, note: m.about, chip, disabled: !!chip };
          }
          if (!m.computer) return { value: m.id, label: m.name, note: m.about };
          if (computers.some((c) => c.models.some((x) => x.id === m.id && x.state === "ready"))) return { value: m.id, label: m.name, note: m.about };
          const holder = computers.some((c) => c.models.some((x) => x.id === m.id));
          const host = computers.find((c) => runsOn(m, c.os, c.version));
          const chip = holder ? LIBRARY_WORDS.downloading : host ? <Button size="sm" variant="outline" onClick={() => putModel(host.id, m.id, true).then(voice.set, (e) => saveFailed(msg(e)))}>{LIBRARY_WORDS.download}</Button> : undefined;
          return { value: m.id, label: m.name, note: m.about, chip, disabled: true };
        }),
      ]
    : [];
  const ownStt = stt?.stt?.per?.transcripts;
  const pickStt = (v: string) => {
    const m = modelOf(v);
    putVoice({ stt: { per: { transcripts: m ? { engine: m.engine, model: m.id } : null } } }).then(voice.set, (e) => saveFailed(msg(e)));
  };

  // Video breakdown: the Gemini models need the Gemini key; Antigravity is the person's own sign-in
  const videoOpts: Opt[] = WATCH_MODELS.map((m) => {
    const chip = m.value === "antigravity" ? undefined : missingKey("GEMINI_API_KEY");
    return { value: m.value, label: m.label, note: m.note, chip, disabled: !!chip };
  });

  return (
    <>
      {level !== "off" && (
        <ModelRow
          name="models-descriptions"
          title={LIBRARY_WORDS.descriptions}
          tip={LIBRARY_WORDS.descriptionsTip}
          value={inUse.descriptions || LIBRARY_WORDS.notSet}
          selected={descSel}
          options={() => descOpts}
          onPick={pickDesc}
        />
      )}
      {timeline && (
        <ModelRow
          name="models-video"
          title={LIBRARY_WORDS.videoBreakdown}
          tip={LIBRARY_WORDS.videoBreakdownTip}
          value={WATCH_MODELS.find((m) => m.value === video)?.label ?? ""}
          selected={video}
          options={() => videoOpts}
          onPick={(v) => onVideo(v as WatchModel)}
        />
      )}
      {transcribe && level !== "off" && (
        <ModelRow
          name="models-transcripts"
          title={LIBRARY_WORDS.transcripts}
          tip={LIBRARY_WORDS.transcriptsTip}
          value={inUse.transcripts || LIBRARY_WORDS.notSet}
          selected={ownStt ? (ownStt.model ?? "") : SAME}
          options={sttOpts}
          onPick={pickStt}
        />
      )}
    </>
  );
}

/** Settings → Media Library → Models: the library's rows in one card. */
export function Models({ settings, save }: { settings: LibrarySettings; save: (s: Partial<LibrarySettings>) => Promise<unknown> }) {
  return (
    <Card>
      <ModelRows
        level={levelOf(settings)}
        timeline={!!settings.timeline}
        transcribe={settings.transcribe !== false}
        video={watchModelOf(settings.timelineModel)}
        onVideo={(v) => void save({ timelineModel: v })}
      />
    </Card>
  );
}
