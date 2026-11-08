import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, LayoutGrid, RectangleHorizontal, Sparkles, X } from "lucide-react";
import { CarouselSlideCard, slideChrome } from "./carousel-cards";
import { layoutSourceHash, liveCompose, type CarouselLayoutSet } from "@/lib/carousel-layout";
import { askUsageText } from "@/lib/workshop";
import {
  CAROUSEL_TYPES,
  resolveCarouselType,
  visualizeCarousel,
  type CarouselTypeId,
} from "@/lib/carousel-visualize";

export interface VisualizeBlock {
  key: string;
  id?: string;
  text: string;
}

export type LayoutPass = {
  typeId?: string;
  slide?: number;
  regenerate?: boolean;
  pick?: number;
};

type View = "all" | "swipe";

const pickOn = "rounded-md border border-violet-500/60 bg-violet-600/20 px-2 py-0.5 text-[11px] text-violet-950 dark:text-violet-100";
const pickOff = "rounded-md border border-border bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground hover:border-violet-400/50 hover:text-foreground";

export function CarouselVisualizeModal({
  blocks,
  caption,
  typeId,
  locked,
  aiAvailable = true,
  storedLayouts,
  onClose,
  onType,
  onReorder,
  onLayouts,
}: {
  blocks: VisualizeBlock[];
  caption: string;
  typeId?: string | null;
  locked: boolean;
  aiAvailable?: boolean;
  storedLayouts?: CarouselLayoutSet;
  onClose: () => void;
  onType: (id: CarouselTypeId) => void;
  onReorder: (fromKey: string, toKey: string, extras?: string[]) => void;
  onLayouts?: (opts: LayoutPass) => Promise<void>;
}) {
  const [picked, setPicked] = useState<CarouselTypeId | null>(null);
  const type = resolveCarouselType(picked ?? typeId);
  const hash = useMemo(() => layoutSourceHash(type.id, blocks.map((b) => b.text)), [type.id, blocks]);
  const compose = liveCompose(storedLayouts, hash, blocks.length);
  const model = useMemo(
    () => visualizeCarousel({ typeId: type.id, blocks, caption, compose }),
    [type.id, blocks, caption, compose],
  );
  const [view, setView] = useState<View>("all");
  const [index, setIndex] = useState(0);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "gen" | "pick">(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const count = model.slides.length;
  const current = model.slides[Math.min(index, Math.max(0, count - 1))];
  const live = !!compose;
  const variants = live ? storedLayouts!.variants : [];

  const run = async (opts: LayoutPass) => {
    if (!onLayouts || busy) return;
    const kind = opts.pick !== undefined && !opts.regenerate && opts.slide == null ? "pick" : "gen";
    setBusy(kind);
    setLayoutError(null);
    try {
      await onLayouts({ ...opts, typeId: type.id });
    } catch (e) {
      setLayoutError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const redoSlide = (blockKey?: string) => {
    const i = blocks.findIndex((b) => b.key === blockKey || b.id === blockKey);
    if (i < 0) return;
    void run({ slide: i + 1 });
  };

  useEffect(() => {
    setIndex((i) => (count ? Math.min(i, count - 1) : 0));
  }, [count, type.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (view !== "swipe") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.metaKey || e.altKey || e.ctrlKey) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setIndex((i) => Math.min(count - 1, i + 1));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, view, count]);

  const canDrag = !locked && blocks.filter((b) => b.text.trim() || b.id).length > 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div
        role="dialog"
        aria-labelledby="carousel-visualize-title"
        aria-modal="true"
        className="relative flex max-h-[92vh] w-[min(1080px,96vw)] flex-col overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 flex-wrap items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="carousel-visualize-title" className="text-base font-semibold">
              Visualize carousel
            </h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {type.summary} · {type.min}–{type.max} slides
            </p>
            <div className="mt-2 flex flex-wrap gap-1">
              {CAROUSEL_TYPES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setPicked(t.id);
                    onType(t.id);
                  }}
                  title={t.summary}
                  className={type.id === t.id ? pickOn : pickOff}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {onLayouts ? (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {storedLayouts?.usage ? <span className="text-[10px] text-muted-foreground">{askUsageText(storedLayouts.usage)}</span> : null}
                {variants.length > 1
                  ? variants.map((_, i) => (
                      <button
                        key={i}
                        type="button"
                        disabled={!!busy}
                        onClick={() => void run({ pick: i })}
                        className={(storedLayouts?.pick ?? 0) === i ? pickOn : pickOff}
                      >
                        {String.fromCharCode(65 + i)}
                      </button>
                    ))
                  : null}
                <button
                  type="button"
                  disabled={!!busy || locked || !aiAvailable || !blocks.length}
                  onClick={() => void run(live ? { regenerate: true } : {})}
                  title={aiAvailable ? (live ? "Pick a new pairing from the same kit" : "Compose text layout and image wells from the kit") : "AI is not configured"}
                  className={`${pickOff} inline-flex items-center gap-1 disabled:opacity-40`}
                >
                  <Sparkles className="h-3 w-3" />
                  {busy === "gen" ? "Picking…" : live ? "Regenerate" : "Generate layouts"}
                </button>
                {layoutError ? <span className="text-[11px] text-red-500">{layoutError}</span> : null}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setView("all")}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] ${view === "all" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              <LayoutGrid className="h-3 w-3" /> All
            </button>
            <button
              type="button"
              onClick={() => setView("swipe")}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] ${view === "swipe" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              <RectangleHorizontal className="h-3 w-3" /> Swipe
            </button>
            <button type="button" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {model.gaps.length ? (
          <ul className="shrink-0 border-b border-border bg-muted/30 px-4 py-2 text-[12px] text-amber-800 dark:text-amber-200/90">
            {model.gaps.map((g) => (
              <li key={g.id}>{g.text}</li>
            ))}
          </ul>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-zinc-925 px-4 py-5">
          {view === "all" ? (
            <div className="flex flex-wrap justify-center gap-5">
              {model.slides.map((s) => {
                const draggable = canDrag && !s.ghost && !!s.blockKey;
                return (
                  <div
                    key={s.key}
                    onDragOver={(e) => {
                      if (!dragKey || dragKey === s.blockKey || s.ghost || !s.blockKey) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setOverKey(s.blockKey);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (!dragKey || !s.blockKey) {
                        setDragKey(null);
                        setOverKey(null);
                        return;
                      }
                      onReorder(dragKey, s.blockKey);
                      setDragKey(null);
                      setOverKey(null);
                    }}
                    className={`flex flex-col items-center gap-1.5 ${overKey === s.blockKey && dragKey && dragKey !== s.blockKey ? "opacity-80 ring-2 ring-violet-400/70" : ""} ${dragKey === s.blockKey ? "opacity-40" : ""}`}
                  >
                    <div
                      draggable={draggable}
                      aria-label={draggable ? `Reorder ${slideChrome(s)}` : slideChrome(s)}
                      onDragStart={(e) => {
                        if (!s.blockKey) return;
                        setDragKey(s.blockKey);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => {
                        setDragKey(null);
                        setOverKey(null);
                      }}
                      onClick={() => {
                        setIndex(s.n - 1);
                        setView("swipe");
                      }}
                      className={draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}
                    >
                      <CarouselSlideCard slide={s} width={196} />
                    </div>
                    <p className="text-[11px] text-zinc-400">{slideChrome(s)}</p>
                  </div>
                );
              })}
            </div>
          ) : current ? (
            <SwipeView
              slides={model.slides}
              index={Math.min(index, count - 1)}
              onIndex={setIndex}
              busy={busy === "gen"}
              canRedo={!!onLayouts && aiAvailable && !locked && live}
              onRedo={redoSlide}
            />
          ) : (
            <p className="py-12 text-center text-sm text-zinc-500">No slides yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function SwipeView({
  slides,
  index,
  onIndex,
  busy,
  canRedo,
  onRedo,
}: {
  slides: ReturnType<typeof visualizeCarousel>["slides"];
  index: number;
  onIndex: (i: number) => void;
  busy: boolean;
  canRedo: boolean;
  onRedo: (blockKey?: string) => void;
}) {
  const slide = slides[index];
  if (!slide) return null;
  const prev = slides[index - 1];
  const next = slides[index + 1];
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center justify-center gap-3">
        <button
          type="button"
          disabled={index <= 0}
          onClick={() => onIndex(index - 1)}
          className="rounded-md p-2 text-zinc-400 hover:bg-zinc-50/5 hover:text-zinc-50 disabled:opacity-20"
          aria-label="Previous slide"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        {prev ? (
          <button type="button" onClick={() => onIndex(index - 1)} className="hidden opacity-40 transition hover:opacity-70 sm:block" aria-label="Previous slide">
            <CarouselSlideCard slide={prev} width={132} />
          </button>
        ) : (
          <div className="hidden w-[132px] sm:block" />
        )}
        <CarouselSlideCard slide={slide} width={300} />
        {next ? (
          <button type="button" onClick={() => onIndex(index + 1)} className="hidden opacity-40 transition hover:opacity-70 sm:block" aria-label="Next slide">
            <CarouselSlideCard slide={next} width={132} />
          </button>
        ) : (
          <div className="hidden w-[132px] sm:block" />
        )}
        <button
          type="button"
          disabled={index >= slides.length - 1}
          onClick={() => onIndex(index + 1)}
          className="rounded-md p-2 text-zinc-400 hover:bg-zinc-50/5 hover:text-zinc-50 disabled:opacity-20"
          aria-label="Next slide"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
      <p className="text-[12px] text-zinc-400">
        {slideChrome(slide)} · {index + 1} / {slides.length}
      </p>
      {canRedo && !slide.ghost ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onRedo(slide.blockKey)}
          className="rounded-md border border-zinc-50/15 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-50/5 disabled:opacity-40"
        >
          {busy ? "Picking…" : "Redo this slide"}
        </button>
      ) : null}
      <div className="flex max-w-full flex-wrap justify-center gap-1.5">
        {slides.map((s, i) => (
          <button
            key={s.key}
            type="button"
            onClick={() => onIndex(i)}
            className={`h-1.5 w-4 rounded-full ${i === index ? "bg-white" : "bg-white/25 hover:bg-white/50"}`}
            aria-label={slideChrome(s)}
          />
        ))}
      </div>
    </div>
  );
}
