import { useEffect, useState, type MouseEvent } from "react";
import { toast } from "sonner";
import { MessageSquareText } from "lucide-react";
import type { Edit, LineTakes } from "@contracts/editor";
import type { NleSide } from "@/components/nle/NleEditor";
import { askAbout } from "@/lib/assistant";
import { getLineTakes } from "@/lib/editor";
import { clipFor, lineOf, lineSpan, swapTake, takeRows, type TakeRow } from "@/lib/editor-takes";
import { trim, withLinked } from "@/lib/nle/model";
import { cn } from "@/lib/utils";

/**
 * Beside the viewer in chat mode: the takes of the picked clip's line side by side, and which other versions use each.
 * A click tries a take on the timeline, rippled to its length, from the line's first frame: Keep (or Enter) makes it the
 * person's own edit, nothing sent to the AI; Esc drops it. Takes show only for a picked clip, never for whatever the
 * playhead is over. A try is the editor's own (NleSide `tried`), so it is still on after the chat closes and opens.
 */

// a click leaves no focus behind: the editor's Enter / Esc skip a focused button, so a clicked take would take Enter
// for itself instead of keeping the try (Tab still reaches them)
const noFocus = (e: MouseEvent) => {
  e.preventDefault();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
};
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
type Tried = { take: number; line: string };
const isTried = (x: unknown): x is Tried => !!x && typeof x === "object" && "take" in x && "line" in x;

export function TakePicker({ s, e, name, title }: { s: NleSide; e: Edit; name: string; title: string }) {
  const ids = e.lines.map((l) => l.id);
  const fps = s.tl.timeline.fps;
  const tried = s.trying && isTried(s.tried) ? s.tried : null;
  // while a try plays, the picker stays on its line: the playhead runs over the try, not the kept timeline under it
  const pinned = tried ? (s.tl.tracks.V1?.items ?? []).find((it) => it._k && lineOf(s.tl, it, ids) === tried.line) : undefined;
  const clip = pinned ? { key: pinned._k!, track: "V1", item: pinned } : clipFor(s.tl, s.picked);
  const line = clip?.track === "V1" ? lineOf(s.tl, clip.item, ids) : null;
  const [takes, setTakes] = useState<Record<string, LineTakes | Error>>({});
  const lt = line ? takes[line] : undefined;
  useEffect(() => {
    if (!line || takes[line]) return;
    let live = true;
    getLineTakes(e.id, line).then((t) => live && setTakes((all) => ({ ...all, [line]: t })), (x: Error) => live && setTakes((all) => ({ ...all, [line]: x })));
    return () => void (live = false);
  }, [e.id, line, takes]);
  const got = lt && !(lt instanceof Error) ? lt : null;
  const rows = got && clip ? takeRows(e, name, s.tl, clip.item, got) : [];

  // always from the timeline as kept, so trying 3, then 2, then 5 never stacks them
  const tryTake = (row: TakeRow) => {
    if (!clip || !line || !got) return;
    if (row.here) return void s.preview(null);
    try {
      const next = swapTake(s.tl, line, ids, row.take, got.sources[row.take.src]);
      const start = lineSpan(s.tl, line, ids)?.[0] ?? clip.item.rec;
      const kept = new Set((s.tl.tracks.V1?.items ?? []).map((it) => it._k));
      const key = (next.tracks.V1?.items ?? []).filter((it) => !kept.has(it._k)).sort((x, y) => x.rec - y.rec)[0]?._k;
      const picked = s.picked.length ? s.picked : [clip.key];
      s.seek(start);
      // the seek let the pick go: the kept line's clips (for this panel, and back after Esc) and the try's new ones
      s.pick([...picked, ...(key ? withLinked(next, [key]) : [])]);
      s.preview(next, `Use take ${row.n}`, { take: row.n, line } satisfies Tried);
    } catch (x) {
      toast.error(x instanceof Error ? x.message : String(x));
    }
  };
  const starts = line ? lineSpan(s.tl, line, ids) : null;
  const nextLine = starts ? (s.tl.tracks.V1?.items ?? []).filter((i) => i._k && i.rec >= starts[1]).sort((x, y) => x.rec - y.rec)[0] : undefined;
  const text = got?.text ?? e.lines.find((l) => l.id === line)?.text ?? "";

  return (
    <section aria-label="Takes" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[5px] border border-black/70 bg-[#1b1b1e]">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!clip ? (
          <p className="text-[12px] text-zinc-500">Pick a spoken clip on the timeline to see its takes.</p>
        ) : !line ? (
          <p className="text-[12px] text-zinc-500">This clip isn't a spoken line (B-roll, a card), so it has no takes to pick from.</p>
        ) : lt instanceof Error ? (
          <p className="text-[12px] text-red-400">{lt.message}</p>
        ) : !got ? (
          <p className="text-[12px] text-zinc-500">Reading the takes…</p>
        ) : (
          <>
            <h3 className="text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">
              Takes for <span className="text-[13px] text-zinc-100 normal-case">{line}</span>
            </h3>
            <p className="mt-1 line-clamp-2 text-[12px] text-zinc-400" title={text}>{text}</p>
            {rows.length < 2 && <p className="mt-1 text-[12px] text-zinc-500">This line has one take: there is nothing to swap it for.</p>}
            <ul className="mt-3 flex flex-wrap gap-3">
              {rows.map((row) => {
                const src = got.sources[row.take.src];
                return (
                  <li key={`${row.take.first}-${row.take.last}`} className="flex w-[92px] flex-col items-center gap-1.5">
                    <button type="button" onMouseDown={noFocus} onClick={() => tryTake(row)} title={`Try take ${row.n} on the timeline`}
                      className={cn("relative aspect-[9/16] w-full overflow-hidden rounded-md border bg-zinc-800", row.here ? "border-zinc-100" : "border-zinc-700 hover:border-zinc-400")}>
                      <span className="absolute inset-0 flex items-center justify-center font-mono text-[18px] text-zinc-500">{row.n}</span>
                      {/* its first frame over the number (the browser shows the frame at #t); none, or it fails: the number shows */}
                      {src?.w ? (
                        <video src={`/api/library/media/${encodeURIComponent(src.versionId || row.take.src)}/play#t=${(row.take.cut[0]![0] / (src.fps || fps) + 0.1).toFixed(2)}`}
                          preload="metadata" muted playsInline aria-hidden onError={(x) => void (x.currentTarget.style.display = "none")}
                          className="pointer-events-none absolute inset-0 size-full object-cover" />
                      ) : null}
                    </button>
                    <span className="text-[11px] text-zinc-400">Take {row.n}</span>
                    <span className="flex min-h-4 flex-wrap justify-center gap-1">
                      {row.used.map((v) => (
                        <span key={v} title={`Version ${v} uses it`} className="rounded-[3px] bg-zinc-700 px-1 text-[10px] leading-4 text-zinc-200">{v}</span>
                      ))}
                    </span>
                    {tried?.take === row.n && tried.line === line ? (
                      <button type="button" onMouseDown={noFocus} onClick={() => s.commitPreview()} title={`Keep take ${row.n} on this line in ${title} (Esc drops it)`}
                        className="h-6 rounded-md bg-sky-500 px-2.5 text-[11px] font-medium text-black hover:bg-sky-400">Keep · Enter</button>
                    ) : (
                      <button type="button" disabled={row.here} onMouseDown={noFocus} onClick={() => tryTake(row)} title={row.here ? undefined : `Try take ${row.n} on the timeline`}
                        className={cn("h-6 rounded-md px-2.5 text-[11px] font-medium", row.here ? "bg-zinc-100 text-zinc-900" : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700")}>
                        {row.here ? "In use" : "Try"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
      {clip && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-black/60 bg-[#202024] px-2 py-1.5 text-[11px] text-zinc-300">
          <button type="button" title="The clip ends a frame earlier (what comes after moves up)" disabled={!!tried}
            onClick={() => s.commit(trim(s.tl, clip.key, "tail", -1, true), "Trim the end by a frame")} className="h-6 rounded px-2 hover:bg-white/[0.06] disabled:opacity-40">◂ 1 frame</button>
          <button type="button" title="The clip ends a frame later (what comes after moves on)" disabled={!!tried}
            onClick={() => s.commit(trim(s.tl, clip.key, "tail", 1, true), "Trim the end by a frame")} className="h-6 rounded px-2 hover:bg-white/[0.06] disabled:opacity-40">1 frame ▸</button>
          {nextLine && (
            <button type="button" disabled={!!tried} onMouseDown={noFocus} onClick={() => (s.seek(nextLine.rec), s.pick(withLinked(s.tl, [nextLine._k!])))}
              title={tried ? "Enter keeps the take you're trying, Esc drops it" : "The next line's takes"}
              className="h-6 rounded px-2 hover:bg-white/[0.06] disabled:opacity-40">Next line ▸</button>
          )}
          <button type="button" className="ml-auto inline-flex h-6 items-center gap-1 rounded px-2 hover:bg-white/[0.06]"
            title="This moment of this version into the chat box, to say what should change here"
            onClick={() => askAbout(`${e.name} · ${title} · ${clock(s.playhead / fps)}${line ? ` · line ${line}` : ""}`)}>
            <MessageSquareText className="size-3.5" /> Point chat here
          </button>
        </div>
      )}
    </section>
  );
}
