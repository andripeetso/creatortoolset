import { useState, type HTMLAttributes, type ReactNode, type RefObject } from "react";
import { clock, rulerMarks } from "@/lib/time-axis";
import { cn } from "@/lib/utils";

/** The ruler's marks are drawn for what shows and this much either side, and again when the view has moved this far. */
const AHEAD = 512;

/**
 * The frame the app's timelines stand in (Review's, components/EditTimeline.tsx, and the screen recording editor's,
 * components/screen-editor/Timeline.tsx): the scroller, the content as wide as the time axis makes it (lib/time-axis.ts),
 * and the ruler with its marks. A tool puts its lanes, its playhead and whatever else it draws over them inside as
 * children, and keeps its own pointer work: `content` carries the handlers of the whole content, `ruler` those of the
 * ruler.
 *
 * `labelWidth` is a column of lane names inside the content, before 0:00 (the frame keeps the ruler's part of it in
 * place while the content scrolls; `rulerLabel` goes in it); `right` is the room after the end.
 */
export function TimelineFrame({ scroller, inner, seconds, pps, labelWidth = 0, right = 0, rulerHeight, className, content, ruler, rulerLabel, rulerChildren, children }: {
  scroller: RefObject<HTMLDivElement | null>;
  inner: RefObject<HTMLDivElement | null>;
  seconds: number;
  /** px a second takes now (0 = no length yet: the content is as wide as the scroller) */
  pps: number;
  labelWidth?: number;
  right?: number;
  rulerHeight: number;
  /** the scroller's own classes (its padding, how it sits in its row) */
  className?: string;
  content?: HTMLAttributes<HTMLDivElement>;
  ruler?: HTMLAttributes<HTMLDivElement>;
  rulerLabel?: ReactNode;
  /** what else stands on the ruler: markers, flags */
  rulerChildren?: ReactNode;
  children: ReactNode;
}) {
  // how far the view has moved, in steps of AHEAD: the marks are drawn again only when it changes
  const [moved, setMoved] = useState(0);
  const from = moved * AHEAD - AHEAD - labelWidth;
  const marks = rulerMarks(pps, seconds, from, from + (scroller.current?.clientWidth ?? 2 * AHEAD) + 3 * AHEAD);
  return (
    <div ref={scroller} className={cn("relative overflow-x-auto", className)}
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
      onScroll={(e) => setMoved(Math.floor(e.currentTarget.scrollLeft / AHEAD))}>
      <div ref={inner} {...content} className={cn("relative", content?.className)}
        style={{ width: seconds > 0 && pps > 0 ? labelWidth + seconds * pps + right : "100%" }}>
        <div className="flex" style={{ height: rulerHeight }}>
          {labelWidth > 0 && (
            <div className="sticky left-0 z-40 flex shrink-0 items-center bg-zinc-950 px-1" style={{ width: labelWidth }}>{rulerLabel}</div>
          )}
          <div {...ruler} className={cn("relative flex-1 overflow-hidden", ruler?.className)}>
            {marks.at.map((t) => (
              <span key={t} className="absolute top-0 h-2 border-l border-zinc-700 pl-0.5 text-[9px] leading-none tabular-nums text-zinc-600"
                style={{ left: t * pps }}>{clock(t, marks.step < 1)}</span>
            ))}
            {rulerChildren}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
