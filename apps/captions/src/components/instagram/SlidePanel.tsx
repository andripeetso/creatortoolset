import { useState } from "react";
import { ChevronLeft, ChevronRight, Film, Image as ImageIcon } from "lucide-react";
import {
  fmtMmSs,
  isProcessing,
  transcriptParagraphs,
  usefulAltText,
  type InstagramPost,
  type Slide,
  type TranscriptWord,
} from "@/lib/instagram";

const label =
  "mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500";

function TranscriptBlock({
  words,
  onSeek,
}: {
  words: TranscriptWord[] | undefined;
  onSeek: (t: number) => void;
}) {
  const paras = words ? transcriptParagraphs(words) : [];
  if (!paras.length) return <p className="text-xs text-zinc-500">Loading…</p>;
  return (
    <div className="flex flex-col gap-2">
      {paras.map((p, i) => (
        <p key={i} className="text-sm leading-relaxed text-zinc-300">
          <button
            type="button"
            onClick={() => onSeek(p[0].start)}
            className="mr-1.5 rounded bg-zinc-800 px-1 py-0.5 font-mono text-[10px] text-zinc-400 hover:bg-violet-600 hover:text-white"
          >
            {fmtMmSs(p[0].start)}
          </button>
          {p.map((w) => w.text).join(" ")}
        </p>
      ))}
    </div>
  );
}

function slideHasText(s: Slide): boolean {
  return Boolean(s.vision.hook || s.vision.onScreenText || s.caption || s.transcript.status === "done");
}

/**
 * Text for the slide that is open in the viewer — caption, hook,
 * on-screen text, description, transcript — with prev/next, plus an
 * "All slides" reading mode that lists every slide's text densely.
 */
export function SlidePanel({
  post,
  index,
  onIndex,
  transcripts,
  onSeek,
  onRead,
}: {
  post: InstagramPost;
  index: number;
  onIndex: (i: number) => void;
  transcripts: Record<number, TranscriptWord[]>;
  onSeek: (slideIndex: number, t: number) => void;
  /** Make the transcript and on-screen text (a chip that isn't done yet was clicked). */
  onRead?: () => void;
}) {
  // a post of several slides that has been read opens on all of its text; one slide, or nothing read yet, on the slide
  const [mode, setMode] = useState<"one" | "all">(() => (post.slides.length > 1 && post.slides.some(slideHasText) ? "all" : "one"));
  const processing = isProcessing(post);
  const slides = post.slides;
  const slide = slides[index];
  if (!slide) return null;
  const count = slides.length;
  const anyText = slides.some(slideHasText);
  const v = slide.vision;
  const alt = usefulAltText(slide);
  /** Provenance for text selection (SelectionToContext reads it): which post, slide and field. */
  const ctx = (field: "slides" | "transcript" | "caption" | "description", at: number) =>
    JSON.stringify({ postId: post.id, handle: post.creator.username, slide: at, field });

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 px-4 py-2.5">
        {slide.kind === "video" ? (
          <Film className="h-3.5 w-3.5 text-zinc-500" />
        ) : (
          <ImageIcon className="h-3.5 w-3.5 text-zinc-500" />
        )}
        {count > 1 ? (
          <span className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous slide"
              disabled={index === 0}
              onClick={() => onIndex(index - 1)}
              className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="text-xs font-medium tabular-nums text-zinc-200">
              Slide {index + 1} / {count}
            </span>
            <button
              type="button"
              aria-label="Next slide"
              disabled={index === count - 1}
              onClick={() => onIndex(index + 1)}
              className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </span>
        ) : (
          <span className="text-xs font-medium text-zinc-200">{slide.kind === "video" ? "Video" : "Image"}</span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {count > 1 && anyText && (
            <span className="flex overflow-hidden rounded-md border border-zinc-800 text-[10px]">
              <button
                type="button"
                onClick={() => setMode("one")}
                className={`px-2 py-0.5 ${mode === "one" ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
              >
                This slide
              </button>
              <button
                type="button"
                onClick={() => setMode("all")}
                className={`px-2 py-0.5 ${mode === "all" ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
              >
                All slides
              </button>
            </span>
          )}
        </span>
      </div>

      {mode === "all" && count > 1 ? (
        <ol className="flex flex-col divide-y divide-zinc-800/60 px-2 py-1">
          {slides.map((s) => {
            const words = transcripts[s.index];
            const spoken = words?.length ? words.map((w) => w.text).join(" ") : "";
            const empty = !slideHasText(s);
            return (
              <li key={s.index}>
                <button
                  type="button"
                  onClick={() => {
                    onIndex(s.index);
                    setMode("one");
                  }}
                  className={`flex w-full gap-3 rounded-md px-2 py-2 text-left hover:bg-zinc-800/50 ${
                    s.index === index ? "bg-zinc-800/40" : ""
                  }`}
                >
                  <span className="mt-0.5 w-5 shrink-0 font-mono text-[10px] text-zinc-500">{s.index + 1}</span>
                  <span className="min-w-0 flex-1">
                    {s.caption && (
                      <span data-ctx={ctx("caption", s.index)} className="mb-0.5 block text-xs text-violet-200">{s.caption}</span>
                    )}
                    {s.vision.hook && s.index === 0 && (
                      <span data-ctx={ctx("slides", s.index)} className="mb-0.5 block text-sm font-medium text-zinc-100">{s.vision.hook}</span>
                    )}
                    {s.vision.onScreenText ? (
                      <span data-ctx={ctx("slides", s.index)} className="block whitespace-pre-wrap text-sm leading-snug text-zinc-300">
                        {s.vision.onScreenText}
                      </span>
                    ) : null}
                    {spoken ? (
                      <span data-ctx={ctx("transcript", s.index)} className="mt-1 block text-xs leading-snug text-zinc-400">
                        <span className="mr-1 text-[10px] uppercase tracking-wider text-zinc-500">said</span>
                        {spoken}
                      </span>
                    ) : null}
                    {empty ? (
                      <span className="block text-xs text-zinc-600">
                        {s.vision.status === "pending" && processing ? "Reading…" : "No text yet"}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="px-4 py-3">
          {slide.caption && (
            <div className="mb-3">
              <p className={label}>Slide caption</p>
              <p data-ctx={ctx("caption", slide.index)} className="whitespace-pre-wrap text-sm text-violet-100">{slide.caption}</p>
            </div>
          )}
          {v.hook && slide.index === 0 && (
            <p data-ctx={ctx("slides", slide.index)} className="mb-3 text-sm font-medium text-zinc-100">
              <span className="mr-1.5 text-[10px] uppercase tracking-wider text-violet-300">Hook</span>
              {v.hook}
            </p>
          )}
          {v.onScreenText && v.textKind !== "none" ? (
            <div className="mb-3">
              <p className={label}>
                On-screen text
                {v.textKind === "captions" ? <span className="normal-case tracking-normal text-zinc-600">· only subtitles of what's said</span> : null}
              </p>
              <p data-ctx={ctx("slides", slide.index)} className={`whitespace-pre-wrap leading-relaxed ${v.textKind === "captions" ? "text-xs text-zinc-500" : "text-sm text-zinc-200"}`}>{v.onScreenText}</p>
            </div>
          ) : v.status === "done" ? (
            <p className="mb-3 text-xs text-zinc-500">No text on screen.</p>
          ) : null}
          {slide.kind === "video" && slide.transcript.status === "done" && (
            <div className="mb-3 scroll-mt-4" id={`transcript-${post.id}-${slide.index}`} data-ctx={ctx("transcript", slide.index)}>
              <p className={label}>Transcript</p>
              <TranscriptBlock words={transcripts[slide.index]} onSeek={(t) => onSeek(slide.index, t)} />
            </div>
          )}
          {v.description && (
            <div className="mb-3">
              <p className={label}>What it shows</p>
              <p data-ctx={ctx("description", slide.index)} className="text-sm text-zinc-400">{v.description}</p>
            </div>
          )}
          {alt && !v.description && <p className="mb-3 text-xs text-zinc-500">Alt text: {alt}</p>}
          {(v.status === "error" || slide.transcript.status === "error") && (
            <p className="mb-2 flex flex-wrap items-center gap-2 text-xs text-amber-400">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              Couldn't read this slide
              {onRead && !processing ? (
                <button type="button" onClick={onRead} className="underline underline-offset-2 hover:text-amber-300">
                  Try again
                </button>
              ) : null}
            </p>
          )}
          {!slideHasText(slide) && v.status !== "error" && (
            <p className="text-xs text-zinc-600">
              {processing && (v.status === "pending" || slide.transcript.status === "pending")
                ? "Reading this slide…"
                : anyText
                  ? "Nothing read on this slide."
                  : onRead ? (
                      <button type="button" onClick={onRead} className="text-violet-300 hover:text-violet-200 hover:underline">
                        Make the transcript and on-screen text
                      </button>
                    ) : (
                      "No on-screen text yet — run Transcript & on-screen text."
                    )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
