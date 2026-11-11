import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  CLIP_BLOCK_CATALOG,
  addClipBlock,
  clipChapters,
  deleteClipBlock,
  displayBlocks,
  isProcessing,
  reorderClipBlocks,
  retryClipBlock,
  useClipsAvailability,
  type ClipBlock,
  type ClipBlockKind,
  type ClipChapter,
  type ClipSession,
} from "@/lib/clips";

function fmtMmSs(t: number): string {
  const m = Math.floor(Math.max(0, t) / 60);
  const s = Math.floor(Math.max(0, t) % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const label =
  "mb-2 flex items-center justify-between gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground";

export function ChapterRail({
  chapters,
  playhead,
  seek,
  pending,
  failed,
  onRetry,
  retrying,
}: {
  chapters: ClipChapter[];
  playhead: number;
  seek: (t: number) => void;
  pending?: boolean;
  /** this visit's request ended with no chapters: what went wrong. The rail stays, so the page does not move */
  failed?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const activeI = chapters.reduce(
    (acc, ch, i) => (playhead >= ch.t ? i : acc),
    0,
  );
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeI]);
  return (
    <aside className="flex max-h-56 min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card lg:max-h-none lg:h-full">
      <h2 className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Chapters
        {onRetry ? (
          <button
            type="button"
            title="Regenerate chapters"
            disabled={retrying || pending}
            onClick={onRetry}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            {retrying ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCcw className="h-3 w-3" />
            )}
          </button>
        ) : null}
      </h2>
      {chapters.length ? null : pending ? (
        <p className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Generating…
        </p>
      ) : failed ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">{failed}</p>
      ) : null}
      <nav className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 pt-1">
        {chapters.map((ch, i) => {
          const on = i === activeI;
          return (
            <button
              key={`${ch.t}-${ch.title}`}
              ref={on ? activeRef : undefined}
              type="button"
              aria-current={on ? "true" : undefined}
              onClick={() => seek(ch.t)}
              className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent ${
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
    </aside>
  );
}

/**
 * Chapters are made for this clip without being asked: your own, processed, with a transcript and no chapters yet, on
 * an install with an AI connected. With none there is nothing to ask and no row is drawn for it (`ai` false).
 */
export const wantsChapters = (session: ClipSession, owns: boolean, ai = true): boolean =>
  ai && owns && !isProcessing(session) && session.hasTranscript && !clipChapters(session).length;

/**
 * Generate the chapter rail as soon as a transcript exists. `pending` while that runs, from the first frame the clip is
 * drawn (the line that says so is there at once, not added a frame later) until the request ends. `failed`: this
 * visit's request ended with no chapters, with what the server said; the row that said "Generating…" stays to say so,
 * so nothing under it moves, and `retry` asks again.
 */
export function useChapters(session: ClipSession, owns: boolean, onChange: (s: ClipSession) => void) {
  const tried = useRef<string | null>(null);
  const [end, setEnd] = useState<{ id: string; error?: string } | null>(null);
  const [again, setAgain] = useState(false);
  // known from the saved copy before the first frame; not read yet (a first-ever visit) counts as connected
  const ai = useClipsAvailability().data?.ai ?? true;
  const wants = wantsChapters(session, owns, ai);
  const id = session.id;
  const ask = useCallback(() => {
    tried.current = id;
    addClipBlock(id, "chapters")
      .then(
        (s) => {
          onChange(s);
          return clipChapters(s).length ? undefined : NO_CHAPTERS;
        },
        (e: unknown) => (e instanceof Error && e.message ? e.message : NO_CHAPTERS),
      )
      .then((error) => {
        setEnd({ id, error });
        setAgain(false);
      });
  }, [id, onChange]);
  useEffect(() => {
    if (wants && tried.current !== id) ask();
  }, [wants, id, ask]);
  // what the request of this clip ended with, when it ended with none
  const error = end?.id === id ? end.error : undefined;
  return {
    // until the page's clip has its chapters (an answer with chapters is not shown as nothing in between), or it failed
    pending: wants && (again || !error),
    failed: wants && !again && error ? error : null,
    retry: () => {
      setAgain(true);
      ask();
    },
  };
}
const NO_CHAPTERS = "Couldn't make chapters.";

/** True while the chapters are being made (useChapters, for a page that only shows that). */
export const useAutoChapters = (session: ClipSession, owns: boolean, onChange: (s: ClipSession) => void): boolean =>
  useChapters(session, owns, onChange).pending;

function jump(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function useLocalChecks(clipId: string, stamp: string) {
  const key = `clip-check:${clipId}:${stamp}`;
  const [done, setDone] = useState<Set<number>>(() => {
    try {
      const raw = localStorage.getItem(key);
      return new Set(JSON.parse(raw ?? "[]") as number[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (i: number) => {
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        /* private mode */
      }
      return next;
    });
  };
  return { done, toggle };
}

export function ClipBlockBody({
  clipId,
  block,
  seek,
}: {
  clipId: string;
  block: ClipBlock;
  seek: (t: number) => void;
}) {
  const checks = useLocalChecks(
    clipId,
    `${block.kind}:${block.items?.[0]?.text ?? ""}`,
  );

  if (block.kind === "summary" && block.text) {
    return (
      <p className="text-sm leading-relaxed text-foreground">{block.text}</p>
    );
  }

  if (!block.items?.length) return null;

  if (block.kind === "actions") {
    return (
      <ul className="flex flex-col gap-1.5">
        {block.items.map((it, i) => (
          <li key={`${it.text}-${i}`}>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-1 hover:bg-accent">
              <input
                type="checkbox"
                checked={checks.done.has(i)}
                onChange={() => checks.toggle(i)}
                className="mt-1 h-3.5 w-3.5 shrink-0 rounded border-border bg-background text-violet-500"
              />
              <span
                className={`min-w-0 text-sm leading-relaxed ${
                  checks.done.has(i) ? "text-muted-foreground line-through" : "text-foreground"
                }`}
              >
                {it.text}
              </span>
              {typeof it.t === "number" && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    seek(it.t!);
                  }}
                  className="ml-auto shrink-0 font-mono text-[11px] text-violet-400 hover:text-violet-300"
                >
                  {fmtMmSs(it.t)}
                </button>
              )}
            </label>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {block.items.map((it, i) => (
        <li key={`${it.text}-${i}`} className="flex gap-3 text-sm text-foreground">
          {block.kind === "quotes" ? (
            <span className="mt-0.5 text-violet-500/80">“</span>
          ) : (
            <span className="mt-0.5 w-4 shrink-0 font-mono text-[11px] text-muted-foreground">
              {i + 1}
            </span>
          )}
          {typeof it.t === "number" ? (
            <button
              type="button"
              onClick={() => seek(it.t!)}
              className="text-left leading-relaxed hover:text-foreground"
            >
              {it.text}
            </button>
          ) : (
            <span className="leading-relaxed">{it.text}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ClipBlocks({
  session,
  owns,
  seek,
  hasTranscript,
  onChange,
}: {
  session: ClipSession;
  owns: boolean;
  seek: (t: number) => void;
  hasTranscript: boolean;
  onChange: (s: ClipSession) => void;
}) {
  const avail = useClipsAvailability().data;
  const [busy, setBusy] = useState<Set<ClipBlockKind>>(() => new Set());
  const busyRef = useRef<Set<ClipBlockKind>>(new Set());
  const [removed, setRemoved] = useState<Set<ClipBlockKind>>(() => new Set());
  const removedRef = useRef(removed);
  removedRef.current = removed;
  const [error, setError] = useState<string | null>(null);
  const [dragKind, setDragKind] = useState<ClipBlockKind | null>(null);
  const blocks = displayBlocks(session).filter((b) => !removed.has(b.kind));

  const present = new Set(blocks.map((b) => b.kind));
  if (clipChapters(session).length) present.add("chapters");
  const canAi = !!avail?.ai;
  const canInstant = (kind: ClipBlockKind) =>
    (kind === "summary" && !!session.summary) ||
    (kind === "chapters" && !!session.chapters?.length);
  const canAdd = (kind: ClipBlockKind) =>
    hasTranscript && (canAi || canInstant(kind));

  const run = async (fn: () => Promise<ClipSession>, kind: ClipBlockKind) => {
    if (busyRef.current.has(kind)) return;
    busyRef.current.add(kind);
    setBusy(new Set(busyRef.current));
    setError(null);
    try {
      const next = await fn();
      const drop = removedRef.current;
      if (!drop.size) {
        onChange(next);
      } else {
        onChange({
          ...next,
          summary: drop.has("summary") ? undefined : next.summary,
          blocks: displayBlocks(next).filter((b) => !drop.has(b.kind)),
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current.delete(kind);
      setBusy(new Set(busyRef.current));
    }
  };

  const remove = (kind: ClipBlockKind) => {
    if (busyRef.current.has(kind)) return;
    setRemoved((prev) => new Set(prev).add(kind));
    void run(async () => {
      try {
        return await deleteClipBlock(session.id, kind);
      } catch (e) {
        setRemoved((prev) => {
          if (!prev.has(kind)) return prev;
          const next = new Set(prev);
          next.delete(kind);
          return next;
        });
        throw e;
      }
    }, kind);
  };

  const persistOrder = async (order: ClipBlockKind[]) => {
    const current = displayBlocks(session);
    if (
      order.length !== current.length ||
      order.some((k) => !current.some((b) => b.kind === k))
    ) {
      return;
    }
    const prev = session;
    const byKind = new Map(current.map((b) => [b.kind, b]));
    onChange({ ...session, blocks: order.map((k) => byKind.get(k)!) });
    try {
      onChange(await reorderClipBlocks(session.id, order));
    } catch (e) {
      onChange(prev);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const move = (kind: ClipBlockKind, dir: -1 | 1) => {
    const i = blocks.findIndex((b) => b.kind === kind);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= blocks.length) return;
    const order = blocks.map((b) => b.kind);
    const [item] = order.splice(i, 1);
    order.splice(j, 0, item);
    void persistOrder(order);
  };

  const unused = CLIP_BLOCK_CATALOG.filter((c) => !present.has(c.kind));

  return (
    <div className="mt-5">
      <div className="mb-4 flex flex-wrap gap-1.5">
        {blocks.map((block) => {
          const c = CLIP_BLOCK_CATALOG.find((x) => x.kind === block.kind);
          if (!c) return null;
          return (
            <button
              key={c.kind}
              type="button"
              title={owns && blocks.length > 1 ? "Drag to reorder" : c.label}
              draggable={owns && blocks.length > 1}
              onDragStart={(e) => {
                setDragKind(c.kind);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (!dragKind || dragKind === c.kind) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (!dragKind || dragKind === c.kind) return;
                const order = blocks.map((b) => b.kind);
                const from = order.indexOf(dragKind);
                const to = order.indexOf(c.kind);
                if (from < 0 || to < 0) return;
                order.splice(from, 1);
                order.splice(to, 0, dragKind);
                setDragKind(null);
                void persistOrder(order);
              }}
              onDragEnd={() => setDragKind(null)}
              onClick={() => jump(`clip-block-${c.kind}`)}
              className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                dragKind === c.kind
                  ? "border-violet-500 bg-violet-500/15 text-violet-700 dark:text-violet-100"
                  : "border-border bg-card text-foreground hover:border-muted-foreground"
              } ${owns && blocks.length > 1 ? "cursor-grab active:cursor-grabbing" : ""}`}
            >
              {owns && blocks.length > 1 && (
                <GripVertical className="h-3 w-3 text-muted-foreground" />
              )}
              {c.label}
            </button>
          );
        })}
        {owns &&
          unused.map((c) => {
            const adding = busy.has(c.kind);
            const disabled = adding || !canAdd(c.kind);
            return (
              <button
                key={c.kind}
                type="button"
                disabled={disabled}
                title={c.hint}
                onClick={() => {
                  setRemoved((prev) => {
                    if (!prev.has(c.kind)) return prev;
                    const next = new Set(prev);
                    next.delete(c.kind);
                    return next;
                  });
                  void run(() => addClipBlock(session.id, c.kind), c.kind);
                }}
                className="flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:border-violet-500/60 hover:text-violet-700 dark:hover:text-violet-200 disabled:opacity-40"
              >
                {adding ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Plus className="h-3 w-3" />
                )}
                {c.label}
              </button>
            );
          })}
        {hasTranscript && (
          <button
            type="button"
            onClick={() => jump("clip-transcript")}
            className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:border-muted-foreground hover:text-foreground"
          >
            Transcript
          </button>
        )}
      </div>

      {owns && hasTranscript && !canAi && (
        <p className="mb-3 text-[11px] text-muted-foreground">
          Takeaways, action plan, and quotes need AI keys. Summary from
          processing can still be added.
        </p>
      )}
      {error && <p className="mb-3 text-[11px] text-red-400">{error}</p>}

      {blocks.map((block, i) => {
        const meta = CLIP_BLOCK_CATALOG.find((c) => c.kind === block.kind);
        return (
          <section
            key={block.kind}
            id={`clip-block-${block.kind}`}
            className="mb-4 scroll-mt-4 rounded-xl border border-border bg-card px-4 py-3.5"
          >
            <h2 className={label}>
              <span>{meta?.label ?? block.kind}</span>
              {owns && (
                <span className="flex items-center gap-0.5">
                  <button
                    type="button"
                    title="Move up"
                    disabled={i === 0}
                    onClick={() => move(block.kind, -1)}
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
                  >
                    <ChevronUp className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    title="Move down"
                    disabled={i === blocks.length - 1}
                    onClick={() => move(block.kind, 1)}
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
                  >
                    <ChevronDown className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    title="Regenerate"
                    disabled={busy.has(block.kind)}
                    onClick={() =>
                      void run(
                        () => retryClipBlock(session.id, block.kind),
                        block.kind,
                      )
                    }
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                  >
                    {busy.has(block.kind) ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3 w-3" />
                    )}
                  </button>
                  <button
                    type="button"
                    title="Remove from page"
                    disabled={busy.has(block.kind)}
                    onClick={() => remove(block.kind)}
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-red-400 disabled:opacity-40"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </span>
              )}
            </h2>
            <ClipBlockBody clipId={session.id} block={block} seek={seek} />
          </section>
        );
      })}
    </div>
  );
}
