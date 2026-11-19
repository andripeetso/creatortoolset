import { useState } from "react";
import { LIBRARY_WORDS, WATCH_MODELS, levelOf, watchModelOf, type LibrarySettings } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Card, Row } from "@/components/settings/ui";
import { activeSet, effectiveSelection, modelName, modelsOf, useProviders } from "@/lib/providers";
import { needWords, modelOf as voiceModelOf, useVoice } from "@/lib/voice";
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
  const transcripts = !r ? "" : "needs" in r ? needWords(r) : (voiceModelOf(r.model)?.name ?? r.model);
  return { descriptions: descModel ? modelName(descModel) : "", transcripts };
}

/**
 * The Models rows (UNIFIED-PRD §3.1 Models). A row whose work is off at this effort is hidden: Descriptions and Transcripts from Low,
 * Video breakdown from High (its flag). Descriptions and Transcripts show the model in use; they are the person's own
 * choice, made on their AI and Voice pages. Video breakdown is the workspace's and opens its options inline.
 */
export function Models({ settings, save }: { settings: LibrarySettings; save: (s: Partial<LibrarySettings>) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const level = levelOf(settings);
  const inUse = useModelsInUse();
  const model = WATCH_MODELS.find((m) => m.value === watchModelOf(settings.timelineModel))!;
  return (
    <Card>
      {level !== "off" && (
        <Row
          title={LIBRARY_WORDS.descriptions}
          tip={LIBRARY_WORDS.descriptionsTip}
          control={<span className="text-sm text-muted-foreground">{inUse.descriptions || LIBRARY_WORDS.notSet}</span>}
        />
      )}
      {settings.timeline && (
        <Row
          title={LIBRARY_WORDS.videoBreakdown}
          tip={LIBRARY_WORDS.videoBreakdownTip}
          control={
            <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {model.label}
            </Button>
          }
        >
          {open && (
            <RadioList
              name="video-breakdown-model"
              value={model.value}
              options={WATCH_MODELS.map((m) => ({ value: m.value, label: m.label, status: m.note }))}
              onChange={(v) => void save({ timelineModel: v })}
            />
          )}
        </Row>
      )}
      {settings.transcribe !== false && level !== "off" && (
        <Row
          title={LIBRARY_WORDS.transcripts}
          tip={LIBRARY_WORDS.transcriptsTip}
          control={<span className="text-sm text-muted-foreground">{inUse.transcripts || LIBRARY_WORDS.notSet}</span>}
        />
      )}
    </Card>
  );
}
