import { useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight, Film, Image as ImageIcon } from "lucide-react";
import {
  fmtMmSs,
  mediaUrl,
  thumbUrl,
  type InstagramPost,
} from "@/lib/instagram";

export interface SeekRequest {
  index: number;
  t: number;
  /** Bump to re-apply the same seek. */
  key: number;
}

/**
 * The media pane: one slide at a time (video with controls, or an image),
 * prev/next, arrow keys, and a thumbnail strip in carousel order.
 */
export function SlideViewer({
  post,
  index,
  onIndex,
  seek,
  onTime,
}: {
  post: InstagramPost;
  index: number;
  onIndex: (i: number) => void;
  seek?: SeekRequest | null;
  onTime?: (index: number, t: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const slides = post.slides;
  const slide = slides[index];
  const count = slides.length;

  // every picture of the post loads as soon as it opens, so stepping through a carousel never waits on a slide
  useEffect(() => {
    for (const s of post.slides) if (s.kind !== "video" && s.bytes > 0) new Image().src = mediaUrl(post.id, s.index);
  }, [post.id, post.slides]);

  useEffect(() => {
    if (!seek || seek.index !== index) return;
    const el = videoRef.current;
    if (!el) return;
    const apply = () => {
      el.currentTime = seek.t;
      void el.play().catch(() => {});
    };
    if (el.readyState >= 1) apply();
    else el.addEventListener("loadedmetadata", apply, { once: true });
    return () => el.removeEventListener("loadedmetadata", apply);
  }, [seek, index]);

  useEffect(() => {
    if (count < 2) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      // Shift+arrows move between posts (handled by the page), not slides.
      if (e.shiftKey || e.metaKey || e.altKey || e.ctrlKey) return;
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "ArrowRight" && index < count - 1) onIndex(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, index, onIndex]);

  if (!slide) {
    return (
      <div className="flex aspect-[4/5] items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-950 px-6 text-center text-sm text-zinc-500">
        {post.status === "processing"
          ? "Media is still downloading…"
          : "No media yet — run a media job to download slides."}
      </div>
    );
  }

  const ready = slide.bytes > 0;
  const ratio =
    slide.width && slide.height
      ? `${slide.width} / ${slide.height}`
      : slide.kind === "video"
        ? "9 / 16"
        : "4 / 5";

  return (
    <div>
      <div
        className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-black"
        style={{ aspectRatio: ratio, maxHeight: "78vh" }}
      >
        {!ready ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Downloading slide {index + 1}…
          </div>
        ) : slide.kind === "video" ? (
          <video
            key={`${post.id}-${index}`}
            ref={videoRef}
            src={mediaUrl(post.id, index)}
            poster={slide.thumb ? thumbUrl(post.id, index) : undefined}
            controls
            playsInline
            preload="metadata"
            onTimeUpdate={(e) => onTime?.(index, e.currentTarget.currentTime)}
            className="h-full w-full object-contain"
          />
        ) : (
          <img
            key={`${post.id}-${index}`}
            src={mediaUrl(post.id, index)}
            alt={slide.accessibilityCaption || `Slide ${index + 1}`}
            // the small thumbnail shows underneath until the full picture has loaded
            style={slide.thumb ? { backgroundImage: `url(${thumbUrl(post.id, index)})`, backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat" } : undefined}
            className="h-full w-full object-contain"
          />
        )}
        {count > 1 && (
          <>
            <button
              type="button"
              aria-label="Previous slide"
              disabled={index === 0}
              onClick={() => onIndex(index - 1)}
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80 disabled:opacity-30"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              aria-label="Next slide"
              disabled={index === count - 1}
              onClick={() => onIndex(index + 1)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80 disabled:opacity-30"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
            <span className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white">
              {index + 1} / {count}
            </span>
          </>
        )}
      </div>

      {ready && (
        <a
          href={mediaUrl(post.id, index)}
          download={`${post.shortcode || post.id}${count > 1 ? `-${index + 1}` : ""}.${(slide.mime || (slide.kind === "video" ? "video/mp4" : "image/jpeg")).split("/")[1]?.replace("jpeg", "jpg") ?? "mp4"}`}
          className="mt-2 inline-block text-xs text-zinc-400 hover:text-zinc-200"
        >
          Save original
        </a>
      )}

      {count > 1 && (
        <div className="mt-2 grid grid-cols-6 gap-1.5 sm:grid-cols-7">
          {slides.map((s) => {
            return (
              <button
                key={s.index}
                type="button"
                onClick={() => onIndex(s.index)}
                title={`Slide ${s.index + 1}`}
                className={`relative aspect-[4/5] overflow-hidden rounded-md border ${
                  s.index === index
                    ? "border-violet-500"
                    : "border-zinc-800 opacity-75 hover:opacity-100"
                }`}
              >
                {s.thumb ? (
                  <img
                    src={thumbUrl(post.id, s.index)}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-zinc-900 text-zinc-600">
                    {s.kind === "video" ? (
                      <Film className="h-4 w-4" />
                    ) : (
                      <ImageIcon className="h-4 w-4" />
                    )}
                  </div>
                )}
                <span className="absolute bottom-0 left-0 rounded-tr bg-black/70 px-1 text-[9px] text-white">
                  {s.index + 1}
                </span>
                {s.kind === "video" && s.durationS ? (
                  <span className="absolute bottom-0 right-0 rounded-tl bg-black/70 px-1 text-[9px] text-white">
                    {fmtMmSs(s.durationS)}
                  </span>
                ) : null}
                {/* a slide that was read shows nothing; one that could not be read gets the one mark */}
                {(s.vision.status === "error" || s.transcript.status === "error") && (
                  <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-500" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
