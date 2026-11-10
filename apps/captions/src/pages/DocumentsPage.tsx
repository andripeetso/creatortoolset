import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  FileText,
  GripVertical,
  ListOrdered,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Share2,
  Trash2,
  TriangleAlert,
  Video,
} from "lucide-react";
import { canUse, useAuth } from "@/lib/auth";
import { useCachedList } from "@/lib/local-cache";
import { Picture } from "@/components/Picture";
import { timeAgo } from "@/lib/exports";
import { isPhoneHub, toolsetHomePath } from "@/lib/mobile";
import { AppBar, ToolIntro } from "@/components/AppBar";
import { DesktopHint } from "@/components/mobile/DesktopHint";
import { thumbClipUrl } from "@/lib/clips";
import {
  createDocument,
  deleteDocument,
  generateDocument,
  getDocument,
  getDocumentsAvailability,
  listDocumentMedia,
  listDocuments,
  patchDocument,
  type DocSource,
  type DocumentRecord,
  type MediaClip,
} from "@/lib/documents";
import { parseDocKind, type DocKind, type GuideDoc } from "@/lib/guide";
import { GuideBody } from "@/components/GuideBody";
import { MarkdownBody } from "@/components/MarkdownBody";
import { DocumentWysiwyg } from "@/components/DocumentWysiwyg";
import { ClipSourceModal } from "@/components/ClipSourceModal";
import { isPublicSharePath } from "@/components/AuthGate";
import { ShareThemeSwitch } from "@/components/ShareTheme";
import {
  parseDocumentMarkdown,
  splitDocumentTitle,
  withDocumentTitle,
} from "@/lib/document-markdown";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function fmtMmSs(t: number): string {
  const m = Math.floor(Math.max(0, t) / 60);
  const s = Math.floor(Math.max(0, t) % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function ComposeForm({
  initial,
  onCreated,
  onUpdated,
  existingId,
  clipId,
}: {
  initial?: { prompt: string; sources: DocSource[]; kind?: DocKind };
  existingId?: string;
  /** A Video Notes clip to start a guide from (?clip=): it becomes the guide's one source. */
  clipId?: string;
  onCreated: (doc: DocumentRecord) => void;
  onUpdated?: (doc: DocumentRecord) => void;
}) {
  const [media, setMedia] = useState<{ clips: MediaClip[] } | null>(null);
  const [ai, setAi] = useState<boolean | null>(null);
  const [kind, setKind] = useState<DocKind>(
    initial?.kind === "guide" || clipId ? "guide" : "brief",
  );
  const [picked, setPicked] = useState<DocSource[]>(initial?.sources ?? []);
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragFrom = useRef<number | null>(null);

  useEffect(() => {
    listDocumentMedia()
      .then((d) => {
        setMedia({ clips: d.clips });
        const clip = clipId ? d.clips.find((c) => c.id === clipId) : undefined;
        if (clip) setPicked([{ type: "clip", id: clip.id, name: clip.name }]);
      })
      .catch(() => setMedia({ clips: [] }));
    getDocumentsAvailability()
      .then((d) => setAi(d.ai))
      .catch(() => setAi(false));
  }, []);

  const add = (s: DocSource, usable: boolean) => {
    if (!usable) return;
    setPicked((cur) => {
      if (kind === "guide") {
        if (s.type !== "clip") return cur;
        return [s];
      }
      return cur.some((x) => x.type === s.type && x.id === s.id)
        ? cur
        : [...cur, s];
    });
  };
  const remove = (type: DocSource["type"], id: string) => {
    setPicked((cur) => cur.filter((x) => !(x.type === type && x.id === id)));
  };
  const move = (i: number, dir: -1 | 1) => {
    setPicked((cur) => {
      const j = i + dir;
      if (j < 0 || j >= cur.length) return cur;
      const next = cur.slice();
      const [row] = next.splice(i, 1);
      next.splice(j, 0, row);
      return next;
    });
  };
  const setNote = (i: number, note: string) => {
    setPicked((cur) =>
      cur.map((s, k) => (k === i ? { ...s, note: note.slice(0, 400) } : s)),
    );
  };

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (existingId) {
        const patched = await patchDocument(existingId, {
          prompt,
          sources: picked,
          kind,
        });
        const next = await generateDocument(existingId);
        onUpdated?.(next.body || next.guide ? next : patched);
      } else {
        onCreated(await createDocument(prompt, picked, kind));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const selected = (type: DocSource["type"], id: string) =>
    picked.some((s) => s.type === type && s.id === id);

  const chooseKind = (next: DocKind) => {
    setKind(next);
    if (next === "guide") {
      setPicked((cur) => cur.filter((s) => s.type === "clip").slice(0, 1));
    }
  };

  const canSubmit =
    !busy &&
    ai !== false &&
    (kind === "guide"
      ? picked.length === 1 && picked[0].type === "clip"
      : picked.length > 0);

  return (
    <div className="flex flex-col gap-6">
      {ai === false && (
        <p className="flex items-center gap-1.5 text-xs text-amber-400/80">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          AI keys are missing — documents can’t be generated until they’re set.
        </p>
      )}

      <section>
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Type
        </h2>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => chooseKind("brief")}
            className={`rounded-lg border px-3 py-2.5 text-left ${
              kind === "brief"
                ? "border-violet-500/50 bg-violet-500/10"
                : "border-border hover:border-muted-foreground"
            }`}
          >
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <FileText className="h-3.5 w-3.5" /> Document
            </span>
            <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
              A written page with clips in place
            </span>
          </button>
          <button
            type="button"
            onClick={() => chooseKind("guide")}
            className={`rounded-lg border px-3 py-2.5 text-left ${
              kind === "guide"
                ? "border-violet-500/50 bg-violet-500/10"
                : "border-border hover:border-muted-foreground"
            }`}
          >
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <ListOrdered className="h-3.5 w-3.5" /> Guide
            </span>
            <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
              Steps and screenshots from one recording
            </span>
          </button>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {kind === "guide" ? "Recording" : "Recordings"}
        </h2>
        {kind === "guide" && (
          <p className="mb-2 text-[11px] text-muted-foreground">
            Guides use one ready recording with a transcript.
          </p>
        )}
        {!media ? (
          <p className="text-sm text-muted-foreground">Loading media…</p>
        ) : media.clips.length === 0 ? (
          <p className="text-sm text-muted-foreground">No clips yet.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {media.clips.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={!c.hasTranscript}
                onClick={() =>
                  selected("clip", c.id)
                    ? remove("clip", c.id)
                    : add(
                        { type: "clip", id: c.id, name: c.name },
                        c.hasTranscript,
                      )
                }
                className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm ${
                  selected("clip", c.id)
                    ? "border-violet-500/50 bg-violet-500/10"
                    : c.hasTranscript
                      ? "border-border hover:border-muted-foreground"
                      : "cursor-not-allowed border-border opacity-50"
                }`}
              >
                {c.hasThumb ? (
                  <div className="h-10 w-16 shrink-0 overflow-hidden rounded bg-muted">
                    <Picture src={thumbClipUrl(c.id)} alt="" className="h-full w-full object-cover" />
                  </div>
                ) : (
                  <span className="flex h-10 w-16 shrink-0 items-center justify-center rounded bg-muted">
                    <Video className="h-4 w-4 text-muted-foreground" />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-foreground">{c.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {c.duration > 0 ? fmtMmSs(c.duration) : "Clip"}
                    {!c.hasTranscript && " · no transcript"}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {picked.length > 0 && (
        <section>
          <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Order and how to use each
          </h2>
          <div className="flex flex-col gap-2">
            {picked.map((s, i) => (
              <div
                key={`${s.type}-${s.id}`}
                draggable
                onDragStart={() => {
                  dragFrom.current = i;
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  const from = dragFrom.current;
                  dragFrom.current = null;
                  if (from == null || from === i) return;
                  setPicked((cur) => {
                    const next = cur.slice();
                    const [row] = next.splice(from, 1);
                    next.splice(i, 0, row);
                    return next;
                  });
                }}
                className="rounded-lg border border-border bg-card p-2.5"
              >
                <div className="mb-1.5 flex items-center gap-2">
                  <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {i + 1}. {s.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => move(i, -1)}
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    title="Move up"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, 1)}
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    title="Move down"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(s.type, s.id)}
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-red-400"
                    title="Remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <input
                  value={s.note ?? ""}
                  onChange={(e) => setNote(i, e.target.value)}
                  placeholder="How to use this source (optional)"
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-violet-500"
                />
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {kind === "guide" ? "What to cover" : "Brief"}
        </h2>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          placeholder={
            kind === "guide"
              ? "Optional: who this is for, or which part of the recording to skip…"
              : "These are three sequential reviews. Use clip 1 first, then…"
          }
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-violet-500"
        />
      </section>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => void submit()}
        className="flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
      >
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Writing…
          </>
        ) : existingId ? (
          kind === "guide" ? "Regenerate this guide" : "Regenerate with these sources"
        ) : kind === "guide" ? (
          "Create guide"
        ) : (
          "Create document"
        )}
      </button>
    </div>
  );
}

function ShareMenu({
  doc,
  onPublished,
}: {
  doc: DocumentRecord;
  onPublished: (published: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const link =
    typeof window === "undefined"
      ? ""
      : `${window.location.origin}/documents/${doc.id}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-violet-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-violet-500"
        >
          <Share2 className="h-3.5 w-3.5" />
          Share
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={8}
        avoidCollisions={false}
        className="w-[min(20rem,calc(100vw-2rem))] p-4 shadow-xl"
      >
        <p className="text-sm font-medium text-foreground">Share this document</p>
        <label className="mt-3 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Who can open
        </label>
        <div className="relative mt-1.5">
          <select
            value={doc.published ? "anyone" : "only-you"}
            onChange={(e) => onPublished(e.target.value === "anyone")}
            className="w-full appearance-none rounded-md border border-border bg-background py-2.5 pr-8 pl-3 text-sm text-foreground outline-none focus:border-violet-500"
          >
            <option value="only-you">Only you</option>
            <option value="anyone">Anyone with the link</option>
          </select>
          <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        </div>
        <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
          {doc.published
            ? "Anyone with this link can view."
            : "Only you can open this document."}
        </p>
        <div className="mt-3 flex gap-1.5">
          <input
            readOnly
            value={link}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2 py-1.5 text-[11px] text-muted-foreground outline-none"
          />
          <button
            type="button"
            onClick={() => void copy()}
            className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground hover:bg-accent"
          >
            {copied ? (
              <span className="flex items-center gap-1">
                <Check className="h-3.5 w-3.5 text-emerald-400" /> Copied
              </span>
            ) : (
              "Copy"
            )}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Editor({
  doc,
  owns,
  onChange,
  onDeleted,
}: {
  doc: DocumentRecord;
  owns: boolean;
  onChange: (d: DocumentRecord) => void;
  onDeleted: () => void;
}) {
  const isGuide = parseDocKind(doc.kind) === "guide";
  const [name, setName] = useState(doc.name);
  const [body, setBody] = useState(
    () => splitDocumentTitle(parseDocumentMarkdown(doc.body)).rest,
  );
  const [guide, setGuide] = useState<GuideDoc | null>(doc.guide ?? null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compose, setCompose] = useState(false);
  const [sourceClip, setSourceClip] = useState<{
    id: string;
    title: string;
    start?: number;
    end?: number;
  } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setName(doc.name);
    setBody(splitDocumentTitle(parseDocumentMarkdown(doc.body)).rest);
    setGuide(doc.guide ?? null);
  }, [doc.id, doc.name, doc.body, doc.guide]);

  const save = useCallback(
    async (patch: {
      name?: string;
      body?: string;
      published?: boolean;
      guide?: GuideDoc;
    }) => {
      setSaving(true);
      setError(null);
      try {
        onChange(await patchDocument(doc.id, patch));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [doc.id, onChange],
  );

  const scheduleBody = (next: string) => {
    setBody(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(
      () => void save({ body: withDocumentTitle(next, name) }),
      700,
    );
  };

  const scheduleGuide = (next: GuideDoc) => {
    setGuide(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save({ guide: next }), 700);
  };

  const flushSave = () => {
    if (!saveTimer.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (isGuide && guide) void save({ guide });
    else void save({ body: withDocumentTitle(body, name) });
  };

  const commitName = (raw: string) => {
    const next = raw.trim().slice(0, 120);
    if (!next) {
      setName(doc.name);
      return;
    }
    setName(next);
    if (next !== doc.name) {
      void save(
        isGuide ? { name: next } : { name: next, body: withDocumentTitle(body, next) },
      );
    }
  };

  return (
    <div className="w-full">
      <div inert={sourceClip ? true : undefined}>
      {owns && (
        <div className="mb-3 flex items-center gap-2 overflow-x-auto pb-0.5 sm:mb-4">
          <span className="mr-auto shrink-0 text-[11px] text-muted-foreground">
            {saving ? "Saving…" : "Saved"}
          </span>
          {editing ? (
            <button
              type="button"
              onClick={() => {
                flushSave();
                setEditing(false);
              }}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-violet-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-violet-500"
            >
              <Check className="h-3.5 w-3.5" />
              Save
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-accent"
            >
              Edit
            </button>
          )}
          <ShareMenu
            doc={doc}
            onPublished={(published) => void save({ published })}
          />
          <button
            type="button"
            onClick={() => setCompose((v) => !v)}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-accent"
          >
            Sources
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={busy}
                className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                title="More"
                aria-label="More"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <MoreHorizontal className="h-3.5 w-3.5" />
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem
                disabled={busy}
                className="items-start py-2 text-xs"
                onSelect={() => {
                  void (async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      onChange(await generateDocument(doc.id));
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    } finally {
                      setBusy(false);
                    }
                  })();
                }}
              >
                <RotateCcw className="mt-0.5 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block">
                    {isGuide ? "Regenerate guide" : "Regenerate document"}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">
                    {isGuide
                      ? "Rebuilds steps and screenshots from the current clip"
                      : "Rewrites the whole page from the current sources"}
                  </span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            onClick={async () => {
              if (
                !window.confirm(
                  `Delete “${name}”?\n\nThis cannot be undone.`,
                )
              ) {
                return;
              }
              await deleteDocument(doc.id).catch(() => {});
              onDeleted();
            }}
            className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-red-400"
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {owns && compose && (
        <div className="mb-6 rounded-xl border border-border p-4">
          <ComposeForm
            existingId={doc.id}
            initial={{
              prompt: doc.prompt,
              sources: doc.sources,
              kind: parseDocKind(doc.kind),
            }}
            onCreated={onChange}
            onUpdated={(d) => {
              onChange(d);
              setCompose(false);
            }}
          />
        </div>
      )}

      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
      {doc.status === "error" && doc.error && (
        <p className="mb-3 text-xs text-red-400">{doc.error}</p>
      )}

      <div className="rounded-xl border border-border bg-card px-4 py-6 shadow-sm sm:px-10 sm:py-8">
            {owns ? (
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={(e) => commitName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  else if (e.key === "Escape") {
                    setName(doc.name);
                    e.currentTarget.blur();
                  }
                }}
                maxLength={120}
                aria-label="Document title"
                className="mb-4 w-full bg-transparent text-2xl font-semibold tracking-tight text-foreground outline-none sm:text-3xl"
              />
            ) : (
              <h1 className="mb-4 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                {doc.name}
              </h1>
            )}
            {owns && editing && !isGuide ? (
              <DocumentWysiwyg
                source={body}
                onChange={scheduleBody}
                onOpenClip={(id, title) => setSourceClip({ id, title })}
                media={!sourceClip}
              />
            ) : isGuide && guide ? (
              <GuideBody
                docId={doc.id}
                guide={guide}
                editing={owns && editing}
                onChange={scheduleGuide}
                onPlay={(step) =>
                  setSourceClip({
                    id: step.source.clipId,
                    title: step.title,
                    start: step.source.startMs / 1000,
                    end: step.source.endMs / 1000,
                  })
                }
              />
            ) : isGuide ? (
              <p className="text-sm text-muted-foreground">
                This guide has no steps yet. Use Sources or Regenerate to build
                it from the recording.
              </p>
            ) : (
              <MarkdownBody
                source={body}
                onOpenClip={(id, title) => setSourceClip({ id, title })}
                media={!sourceClip}
              />
            )}
      </div>
      </div>
      {sourceClip && (
        <ClipSourceModal
          id={sourceClip.id}
          title={sourceClip.title}
          note={doc.sources.find((s) => s.id === sourceClip.id)?.note}
          backTo={`/documents/${doc.id}`}
          start={sourceClip.start}
          end={sourceClip.end}
          onClose={() => setSourceClip(null)}
        />
      )}
    </div>
  );
}

export default function DocumentsPage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { docId } = useParams<{ docId?: string }>();
  const me = useAuth((s) => s.me);
  const required = useAuth((s) => s.required);
  const home = toolsetHomePath();
  const phone = isPhoneHub();
  const composing = docId === "new";
  // ?clip=<id> (the Screen Recorder's "Make a guide"): a new guide from that Video Notes clip
  const [params] = useSearchParams();
  const clipId = params.get("clip") ?? undefined;
  useEffect(() => {
    if (clipId && !docId) navigate(`/documents/new?clip=${encodeURIComponent(clipId)}`, { replace: true });
  }, [clipId, docId, navigate]);
  // the saved list shows at once and refreshes underneath (lib/local-cache)
  const { items: docs, setItems: setDocs, refresh: loadDocs } = useCachedList("/api/documents", listDocuments);
  const [current, setCurrent] = useState<DocumentRecord | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!canUse(me, "guides") || composing || docId) return;
    loadDocs().catch(() => {});
  }, [me, composing, docId, loadDocs]);

  useEffect(() => {
    if (!docId || composing) {
      setCurrent(null);
      setOpening(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setOpening(true);
    setError(null);
    getDocument(docId)
      .then((d) => {
        if (!cancelled) setCurrent(d);
      })
      .catch((e) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Document not found");
      })
      .finally(() => {
        if (!cancelled) setOpening(false);
      });
    return () => {
      cancelled = true;
    };
  }, [docId, composing]);

  const owns =
    !!me &&
    !!current &&
    (me.role === "admin" || me.username === current.owner);

  const wide = Boolean(current && !composing);

  return (
    <div className="flex min-h-screen flex-col bg-background pb-12 text-foreground">
      <AppBar tool="Guide Builder" to={docId ? "/documents" : undefined} trail={current?.name} account={!!me}>
        {isPublicSharePath(pathname) ? <ShareThemeSwitch /> : null}
        {!me && required ? (
          <Link
            to={home}
            className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Sign in
          </Link>
        ) : null}
      </AppBar>
      <div className="flex flex-col items-center px-4 pt-4 sm:px-8 sm:pt-6">

      {!docId && (
        <ToolIntro icon={FileText} title="Guide Builder" line="Turn recordings into SOPs, walkthroughs and step-by-step guides" className="w-full max-w-[720px]">
          {canUse(me, "guides") && !phone && (
            <button
              type="button"
              onClick={() => navigate("/documents/new")}
              className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-violet-500"
            >
              <Plus className="h-4 w-4" /> New
            </button>
          )}
        </ToolIntro>
      )}

      {!docId && phone ? (
        <div className="mb-5 w-full max-w-[720px]">
          <DesktopHint>
            Full Guide Builder is on your desktop. You can still read guides here.
          </DesktopHint>
        </div>
      ) : null}

      <div className={`w-full ${wide ? "max-w-7xl" : "max-w-[720px]"}`}>
        {composing ? (
          <>
            <button
              type="button"
              onClick={() => navigate("/documents")}
              className="mb-4 flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> All guides
            </button>
            <h1 className="mb-4 text-xl font-semibold tracking-tight">
              New guide
            </h1>
            {phone ? (
              <DesktopHint>
                Building a guide needs the desktop editor. Open this on a computer.
              </DesktopHint>
            ) : (
              <ComposeForm
                clipId={clipId}
                onCreated={(d) => {
                  setCurrent(d);
                  navigate(`/documents/${d.id}`);
                }}
              />
            )}
          </>
        ) : opening ? (
          // the guide's final frame, empty: its title line and page, so nothing moves when it arrives
          <div aria-busy="true" aria-label="Opening guide" className="w-full">
            <div className="h-7 w-2/5 rounded bg-muted" />
            <div className="mt-4 h-96 w-full rounded-xl bg-muted/50" />
          </div>
        ) : error && !current ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{error}</p>
        ) : current ? (
          <>
            {owns && (
              <button
                type="button"
                onClick={() => navigate("/documents")}
                className="mb-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> All guides
              </button>
            )}
            <Editor
              doc={current}
              owns={owns}
              onChange={setCurrent}
              onDeleted={() => {
                setDocs((list) => list.filter((d) => d.id !== current.id));
                navigate("/documents");
              }}
            />
          </>
        ) : (
          <div className="flex flex-col gap-1.5">
            {docs.length === 0 ? (
              <p className="py-10 text-center text-sm text-zinc-500">
                No documents yet. Pick a clip to start.
              </p>
            ) : (
              docs.map((d) => (
                <div
                  key={d.id}
                  onClick={() => {
                    if (renaming !== d.id) navigate(`/documents/${d.id}`);
                  }}
                  className="group flex cursor-pointer items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 hover:border-violet-500/50 hover:bg-zinc-900"
                >
                  {parseDocKind(d.kind) === "guide" ? (
                    <ListOrdered className="h-4 w-4 shrink-0 text-zinc-500" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-zinc-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    {renaming === d.id ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onFocus={(e) => e.currentTarget.select()}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          const name = e.currentTarget.value.trim().slice(0, 120);
                          setRenaming(null);
                          if (!name || name === d.name) return;
                          setDocs((list) =>
                            list.map((x) =>
                              x.id === d.id ? { ...x, name } : x,
                            ),
                          );
                          void patchDocument(d.id, { name }).catch(() =>
                            setDocs((list) =>
                              list.map((x) =>
                                x.id === d.id ? { ...x, name: d.name } : x,
                              ),
                            ),
                          );
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                          else if (e.key === "Escape") setRenaming(null);
                        }}
                        maxLength={120}
                        aria-label="Document name"
                        className="w-full rounded-md border border-violet-500 bg-zinc-900 px-1.5 py-0.5 text-sm text-zinc-100 outline-none"
                      />
                    ) : (
                      <p className="truncate text-sm text-zinc-200">{d.name}</p>
                    )}
                    <p className="text-[11px] text-zinc-500">
                      {timeAgo(d.updatedAt)}
                      {parseDocKind(d.kind) === "guide" ? " · Guide" : ""}
                      {d.published ? " · Shared" : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDraft(d.name);
                      setRenaming(d.id);
                    }}
                    title="Rename"
                    className="rounded p-1.5 text-zinc-600 opacity-0 hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (
                        !window.confirm(
                          `Delete “${d.name}”?\n\nThis cannot be undone.`,
                        )
                      ) {
                        return;
                      }
                      void deleteDocument(d.id).then(() =>
                        setDocs((list) => list.filter((x) => x.id !== d.id)),
                      );
                    }}
                    className="rounded p-1.5 text-zinc-600 opacity-0 hover:bg-zinc-800 hover:text-red-400 group-hover:opacity-100"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
