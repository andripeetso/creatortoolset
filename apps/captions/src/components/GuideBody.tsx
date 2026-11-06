import { Play } from "lucide-react";
import type { GuideDoc, GuideStep } from "@/lib/guide";
import { clipRangeHref, guideAssetUrl } from "@/lib/guide";

function fmt(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function GuideBody({
  docId,
  guide,
  editing,
  onChange,
  onPlay,
}: {
  docId: string;
  guide: GuideDoc;
  editing?: boolean;
  onChange?: (guide: GuideDoc) => void;
  onPlay: (step: GuideStep) => void;
}) {
  const setStep = (id: string, patch: Partial<Pick<GuideStep, "title" | "instruction">>) => {
    onChange?.({
      ...guide,
      steps: guide.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  };

  return (
    <div className="flex flex-col gap-8">
      {editing ? (
        <textarea
          value={guide.purpose}
          onChange={(e) =>
            onChange?.({ ...guide, purpose: e.target.value.slice(0, 800) })
          }
          placeholder="What this walkthrough is for"
          rows={2}
          className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus:border-violet-500"
        />
      ) : guide.purpose ? (
        <p className="text-[15px] leading-relaxed text-foreground">{guide.purpose}</p>
      ) : null}

      {guide.prerequisites.length > 0 && (
        <section>
          <h2 className="mb-2 text-xl font-semibold text-foreground">
            Before you start
          </h2>
          <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-foreground">
            {guide.prerequisites.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>
      )}

      {guide.steps.map((step, i) => {
        const shot = step.media[0];
        const start = step.source.startMs / 1000;
        const end = step.source.endMs / 1000;
        return (
          <section
            key={step.id}
            id={step.id}
            aria-labelledby={`${step.id}-title`}
            className="flex flex-col gap-3"
          >
            {editing ? (
              <input
                id={`${step.id}-title`}
                value={step.title}
                onChange={(e) => setStep(step.id, { title: e.target.value })}
                className="w-full bg-transparent text-xl font-semibold text-foreground outline-none"
              />
            ) : (
              <h2
                id={`${step.id}-title`}
                className="text-xl font-semibold text-foreground"
              >
                {i + 1}. {step.title}
              </h2>
            )}
            {shot ? (
              <figure className="overflow-hidden rounded-xl border border-border bg-black">
                <img
                  src={guideAssetUrl(docId, shot.assetId)}
                  alt={shot.alt || step.title}
                  className="w-full bg-black object-contain"
                />
              </figure>
            ) : null}
            {editing ? (
              <textarea
                value={step.instruction}
                onChange={(e) =>
                  setStep(step.id, { instruction: e.target.value })
                }
                rows={3}
                className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-[15px] leading-relaxed text-foreground outline-none focus:border-violet-500"
              />
            ) : (
              <p className="text-[15px] leading-relaxed text-foreground">
                {step.instruction}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onPlay(step)}
                className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-violet-500"
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                Watch {fmt(step.source.startMs)}–{fmt(step.source.endMs)}
              </button>
              <a
                href={clipRangeHref(step.source.clipId, start, end)}
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Open clip
              </a>
            </div>
          </section>
        );
      })}

      {guide.verification.length > 0 && (
        <section>
          <h2 className="mb-2 text-xl font-semibold text-foreground">
            Check your work
          </h2>
          <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-foreground">
            {guide.verification.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
