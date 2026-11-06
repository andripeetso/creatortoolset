import { useCallback, useMemo, useState } from "react";
import { Captions } from "lucide-react";
import {
  captionCueAt,
  clipCaptionCues,
  type ClipWord,
} from "@/lib/clips";
import { cn } from "@/lib/utils";

const KEY = "clips-captions-on";

function loadOn(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "0") return false;
    if (v === "1") return true;
  } catch {
    /* private mode */
  }
  return true;
}

function saveOn(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private mode */
  }
}

export function useClipCaptionsOn() {
  const [on, setOn] = useState(loadOn);
  const toggle = useCallback(() => {
    setOn((v) => {
      const next = !v;
      saveOn(next);
      return next;
    });
  }, []);
  return { on, toggle };
}

export function ClipCaptions({
  words,
  time,
  on,
  className,
}: {
  words: ClipWord[];
  time: number;
  on: boolean;
  className?: string;
}) {
  const cues = useMemo(() => clipCaptionCues(words), [words]);
  const cue = on && cues.length ? captionCueAt(cues, time) : null;
  if (!cue) return null;
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 z-[1] flex justify-center px-5",
        className,
      )}
      aria-hidden
    >
      <p
        className="max-w-[90%] rounded-md bg-black/55 px-3 py-1.5 text-center text-[15px] font-semibold leading-snug text-white sm:text-[17px]"
        style={{
          textShadow:
            "0 1px 2px rgba(0,0,0,.9), 0 0 10px rgba(0,0,0,.45)",
        }}
      >
        {cue.words.map((w) => w.text).join(" ")}
      </p>
    </div>
  );
}

export function ClipCaptionsToggle({
  on,
  onToggle,
  className,
}: {
  on: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
      title={on ? "Hide captions" : "Show captions"}
      aria-label={on ? "Hide captions" : "Show captions"}
      aria-pressed={on}
      className={cn(
        "rounded p-1 hover:bg-white/10",
        !on && "opacity-45",
        className,
      )}
    >
      <Captions className="h-4 w-4" />
    </button>
  );
}
