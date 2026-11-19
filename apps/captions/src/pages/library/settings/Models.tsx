import { useState } from "react";
import { Link } from "react-router";
import { LIBRARY_WORDS, WATCH_MODELS, levelOf, watchModelOf, type LibrarySettings } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Card, Row } from "@/components/settings/ui";
import { RadioList } from "./RadioList";

/**
 * The Models rows (UNIFIED-PRD §3.1 Models). A row whose work is off at this effort is hidden: Descriptions and
 * Transcripts from Low, Video breakdown from High (its flag). Descriptions and Transcripts are the person's own choice,
 * set on their AI and Voice pages; Video breakdown is the workspace's and opens its options inline.
 */
export function Models({ settings, save }: { settings: LibrarySettings; save: (s: Partial<LibrarySettings>) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const level = levelOf(settings);
  const model = WATCH_MODELS.find((m) => m.value === watchModelOf(settings.timelineModel))!;
  return (
    <Card>
      {level !== "off" && (
        <Row
          title={LIBRARY_WORDS.descriptions}
          tip={LIBRARY_WORDS.descriptionsTip}
          control={
            <Button asChild size="sm" variant="outline">
              <Link to="/settings/providers">Change</Link>
            </Button>
          }
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
          control={
            <Button asChild size="sm" variant="outline">
              <Link to="/settings/voice">Change</Link>
            </Button>
          }
        />
      )}
    </Card>
  );
}
