import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ExternalLink, Loader2, X } from "lucide-react";
import { ClipBlockBody } from "@/components/ClipBlocks";
import { ClipPlayer, type ClipPlayerHandle } from "@/components/ClipPlayer";
import {
  CLIP_BLOCK_CATALOG,
  clipChapters,
  displayBlocks,
  getClip,
  getClipTranscript,
  playClipUrl,
  thumbClipUrl,
  type ClipChapter,
  type ClipSession,
  type ClipWord,
} from "@/lib/clips";
import { clipRangeHref } from "@/lib/guide";
import {
  releaseAllVideos,
  releaseOtherVideos,
  restoreVideos,
} from "@/lib/clip-playback";

function fmtMmSs(t: number): string {
  const m = Math.floor(Math.max(0, t) / 60);
  const s = Math.floor(Math.max(0, t) % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function ModalChapters({
  chapters,
  playhead,
  seek,
}: {
  chapters: ClipChapter[];
  playhead: number;
  seek: (t: number) => void;
}) {
  const activeI = chapters.reduce(
    (acc, ch, i) => (playhead >= ch.t ? i : acc),
    0,
  );
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Chapters
      </h3>
      <nav className="flex flex-col">
        {chapters.map((ch, i) => {
          const on = i === activeI;
          return (
            <button
              key={`${ch.t}-${ch.title}`}
              type="button"
              aria-current={on ? "true" : undefined}
              onClick={() => seek(ch.t)}
              className={`flex w-full items-start gap-2 rounded-md px-1 py-1.5 text-left text-sm hover:bg-accent ${
                on ? "bg-accent text-foreground" : "text-muted-foreground"
              }`}
            >
              <span
                className={`mt-0.5 shrink-0 font-mono text-[11px] ${
                  on ? "text-violet-300" : "text-violet-400/80"
                }`}
              >
                {fmtMmSs(ch.t)}
              </span>
              <span className="min-w-0 leading-snug">{ch.title}</span>
            </button>
          );
        })}
      </nav>
    </section>
  );
}

export function ClipSourceModal({
  id,
  title,
  note,
  backTo,
  onClose,
  start,
  end,
}: {
  id: string;
  title: string;
  note?: string;
  backTo?: string;
  onClose: () => void;
  start?: number;
  end?: number;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<ClipPlayerHandle>(null);
  const leaving = useRef(false);
  const parked = useRef<{ el: HTMLVideoElement; src: string }[]>([]);
  const [clip, setClip] = useState<ClipSession | null | undefined>(undefined);
  const [words, setWords] = useState<ClipWord[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [armed, setArmed] = useState(false);

  useLayoutEffect(() => {
    parked.current = releaseOtherVideos(dialogRef.current);
    setArmed(true);
    return () => {
      if (!leaving.current) restoreVideos(parked.current);
      parked.current = [];
    };
  }, []);

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const scrollY = window.scrollY;
    const prev = {
      htmlOverflow: html.style.overflow,
      htmlOverscroll: html.style.overscrollBehavior,
      bodyOverflow: body.style.overflow,
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyLeft: body.style.left,
      bodyRight: body.style.right,
      bodyWidth: body.style.width,
    };
    html.style.overflow = "hidden";
    html.style.overscrollBehavior = "none";
    body.style.overflow = "hidden";
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";

    const root = dialogRef.current;
    const prevFocus = document.activeElement as HTMLElement | null;
    root?.focus();
    const focusables = () =>
      root
        ? [
            ...root.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
            ),
          ]
        : [];
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !root) return;
      const items = focusables();
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey) {
        if (i <= 0) {
          e.preventDefault();
          items[items.length - 1]?.focus();
        }
      } else if (i === items.length - 1 || i < 0) {
        e.preventDefault();
        items[0]?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      html.style.overflow = prev.htmlOverflow;
      html.style.overscrollBehavior = prev.htmlOverscroll;
      body.style.overflow = prev.bodyOverflow;
      body.style.position = prev.bodyPosition;
      body.style.top = prev.bodyTop;
      body.style.left = prev.bodyLeft;
      body.style.right = prev.bodyRight;
      body.style.width = prev.bodyWidth;
      window.scrollTo(0, scrollY);
      prevFocus?.focus?.();
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setClip(undefined);
    setWords([]);
    setPlayhead(0);
    getClip(id)
      .then((c) => {
        if (!cancelled) setClip(c);
      })
      .catch(() => {
        if (!cancelled) setClip(null);
      });
    getClipTranscript(id)
      .then((t) => {
        if (!cancelled) setWords(t.words);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id]);

  const name = clip?.name || title;
  const blocks = clip ? displayBlocks(clip) : [];
  const chapters = clip ? clipChapters(clip) : [];
  const seek = (t: number) => playerRef.current?.seek(t);

  return (
    <div
      className="fixed inset-0 z-[60] flex cursor-pointer items-end justify-center bg-black/50 p-0 backdrop-blur-[2px] sm:items-center sm:p-4 [transform:translateZ(0)]"
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onClose();
      }}
      onWheel={(e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="clip-source-title"
        tabIndex={-1}
        className="flex max-h-[92vh] w-full max-w-2xl cursor-auto flex-col overflow-hidden rounded-t-2xl border border-border bg-card shadow-2xl outline-none [transform:translateZ(0)] sm:rounded-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2
            id="clip-source-title"
            className="min-w-0 truncate text-sm font-medium text-foreground"
          >
            {name}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <ClipPlayer
            src={armed ? playClipUrl(id) : undefined}
            poster={clip?.hasThumb ? thumbClipUrl(id) : undefined}
            duration={clip?.duration}
            playerRef={playerRef}
            onTime={setPlayhead}
            words={words}
            start={start}
            end={end}
            autoPlay={start != null}
          />
          <div className="space-y-4 p-4">
            {clip === undefined ? (
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading…
              </p>
            ) : null}
            {note ? (
              <p className="text-xs leading-relaxed text-muted-foreground">{note}</p>
            ) : null}
            {clip === null ? (
              <p className="text-[11px] text-muted-foreground">
                Clip details aren’t available here. Open the clip page for
                takeaways and the action plan.
              </p>
            ) : clip && blocks.length === 0 && chapters.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No takeaways or action plan on this clip yet. Open the clip
                page to generate them.
              </p>
            ) : null}
            {chapters.length > 0 ? (
              <ModalChapters
                chapters={chapters}
                playhead={playhead}
                seek={seek}
              />
            ) : null}
            {blocks.map((block) => {
              const meta = CLIP_BLOCK_CATALOG.find((c) => c.kind === block.kind);
              return (
                <section key={block.kind}>
                  <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {meta?.label ?? block.kind}
                  </h3>
                  <ClipBlockBody clipId={id} block={block} seek={seek} />
                </section>
              );
            })}
          </div>
        </div>
        <div className="flex gap-2 border-t border-border p-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-md border border-border px-3 py-2 text-sm text-foreground hover:bg-accent"
          >
            Close
          </button>
          <Link
            to={clipRangeHref(id, start, end)}
            state={backTo ? { from: backTo } : undefined}
            onClick={() => {
              leaving.current = true;
              releaseAllVideos();
            }}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500"
          >
            Open clip <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </div>
  );
}
