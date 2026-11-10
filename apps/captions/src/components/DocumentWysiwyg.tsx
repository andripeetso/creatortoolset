import { useEffect, useLayoutEffect, useRef } from "react";
import { Bold, Heading2, Italic, List } from "lucide-react";
import { playClipUrl } from "@/lib/clips";
import { htmlToMarkdown, markdownToHtml } from "@/lib/document-html";
import {
  loadClipSpeed,
  pauseOtherVideos,
  releaseVideo,
} from "@/lib/clip-playback";

function run(cmd: string, value?: string) {
  document.execCommand(cmd, false, value);
}

export function DocumentWysiwyg({
  source,
  onChange,
  onOpenClip,
  media = true,
}: {
  source: string;
  onChange: (md: string) => void;
  onOpenClip: (id: string, title: string) => void;
  media?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const focused = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || focused.current) return;
    el.innerHTML = markdownToHtml(source) || "<p></p>";
    const rate = loadClipSpeed();
    for (const v of el.querySelectorAll("video")) {
      v.playbackRate = rate;
      v.addEventListener("loadedmetadata", () => {
        v.playbackRate = rate;
      });
      v.addEventListener("play", () => pauseOtherVideos(v));
      if (!media) releaseVideo(v);
    }
  }, [source, media]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    for (const v of el.querySelectorAll("video")) {
      const id = v.closest("[data-clip-id]")?.getAttribute("data-clip-id");
      if (!id) continue;
      const want = playClipUrl(id);
      if (media) {
        if (v.getAttribute("src") !== want) v.src = want;
      } else if (v.getAttribute("src") || v.currentSrc) {
        releaseVideo(v);
      }
    }
  }, [media, source]);

  const emit = () => {
    if (!ref.current) return;
    onChange(htmlToMarkdown(ref.current));
  };

  return (
    <div>
      <div
        className="sticky top-[calc(var(--bar-h)+0.5rem)] z-10 -mx-1 mb-3 flex flex-wrap gap-1 rounded-lg border border-border bg-background/95 p-1 backdrop-blur-sm"
        onMouseDown={(e) => e.preventDefault()}
      >
        <button
          type="button"
          title="Bold"
          onClick={() => {
            run("bold");
            emit();
          }}
          className="rounded-md p-2 text-foreground hover:bg-accent hover:text-foreground"
        >
          <Bold className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="Italic"
          onClick={() => {
            run("italic");
            emit();
          }}
          className="rounded-md p-2 text-foreground hover:bg-accent hover:text-foreground"
        >
          <Italic className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="Heading"
          onClick={() => {
            run("formatBlock", "h2");
            emit();
          }}
          className="rounded-md p-2 text-foreground hover:bg-accent hover:text-foreground"
        >
          <Heading2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="List"
          onClick={() => {
            run("insertUnorderedList");
            emit();
          }}
          className="rounded-md p-2 text-foreground hover:bg-accent hover:text-foreground"
        >
          <List className="h-4 w-4" />
        </button>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label="Document"
        className="min-h-[24rem] outline-none [&_a]:text-violet-700 [&_a]:underline dark:[&_a]:text-violet-300 [&_em]:italic [&_h1]:mt-2 [&_h1]:mb-4 [&_h1]:text-3xl [&_h1]:font-semibold [&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-medium [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-3 [&_p]:text-[15px] [&_p]:leading-relaxed [&_p]:text-foreground [&_strong]:font-semibold [&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5"
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
        }}
        onInput={emit}
        onClick={(e) => {
          const btn = (e.target as HTMLElement).closest("[data-clip-open]");
          if (!btn) return;
          e.preventDefault();
          const figure = btn.closest("[data-clip-id]");
          const id = figure?.getAttribute("data-clip-id");
          const title = figure?.getAttribute("data-clip-title") || "Clip";
          if (id) onOpenClip(id, title);
        }}
      />
    </div>
  );
}
