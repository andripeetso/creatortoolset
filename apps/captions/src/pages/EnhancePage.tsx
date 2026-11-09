import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  ArrowLeft,
  AudioLines,
  ChevronDown,
  Download,
  FileAudio,
  Film,
  Loader2,
  Lock,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useCachedList } from "@/lib/local-cache";
import { fmtClock } from "@/lib/ass";
import { fmtBytes, timeAgo } from "@/lib/exports";
import {
  cancelEnhance,
  deleteEnhance,
  downloadEnhanced,
  getAvailability,
  getEnhance,
  isEnhancing,
  listEnhance,
  retryPasses,
  runEnhance,
  setEnhanceMix,
  uploadEnhance,
  ENGINES,
  chainLabel,
  engineLabel,
  type Engine,
  type EnhanceAvailability,
  type EnhanceSession,
} from "@/lib/enhance";
import { EnhancePlayer } from "@/components/EnhancePlayer";
import { AppBar, ToolIntro } from "@/components/AppBar";
import { DropZoneText, dropZoneClass } from "@/components/DropZone";
import { ToolSetupLine } from "@/components/setup/ToolSetupLine";

/**
 * The Audio Enhancer — a standalone tool at /enhance inside Creator
 * Toolset. Pick an engine (NVIDIA or ElevenLabs: api/enhance.ts), drop
 * any audio or video file and it's enhanced immediately; then A/B the
 * result with the Before/After player, set its strength against the
 * original, try another engine on the same file, and download the clean
 * audio (or the original video remuxed with it) at that strength. Every
 * engine's result comes out at the same loudness. Everyone sees every
 * engine; what they can't use is shown locked with why. Admins can add a second pass.
 */

const ENGINE_KEY = "enhance.engine";
const THEN_KEY = "enhance.then";
const saved = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const save = (key: string, v: string) => {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* private mode: just this visit */
  }
};

/** Why this user can't pick an engine now, or null when they can. */
const lockReason = (key: Engine, a: EnhanceAvailability): string | null =>
  a[key] ? null : a.why?.[key] ?? "Not set up";

/** The engines this user can pick now. */
const offered = (avail: EnhanceAvailability | null) =>
  avail ? ENGINES.filter((e) => !lockReason(e.key, avail)) : [];

function Chip({ on, lock, title, onClick, children }: {
  on: boolean;
  lock?: string | null;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={!!lock}
      title={title}
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] disabled:cursor-not-allowed ${
        on
          ? "border-violet-500 bg-violet-500/15 text-violet-200"
          : lock
            ? "border-zinc-800/70 text-zinc-600"
            : "border-zinc-800 text-zinc-400 hover:border-zinc-600"
      }`}
    >
      {lock && <Lock className="h-2.5 w-2.5" />}
      {children}
    </button>
  );
}

/**
 * The engines: described cards before an upload (so everyone sees what each
 * model is), or `compact` chips inside a file's Edit enhancement. Admins get a second pass.
 */
function EnginePicker({ avail, value, onChange, then, onThen, compact = false }: {
  avail: EnhanceAvailability | null;
  value: Engine;
  onChange: (e: Engine) => void;
  then: Engine | null;
  onThen: (e: Engine | null) => void;
  compact?: boolean;
}) {
  if (!avail) return null;
  const second = then === value ? null : then;
  const thens = ENGINES.filter((e) => e.key !== value && !lockReason(e.key, avail)).map((e) => e.key);
  const pick = (k: Engine) => {
    onChange(k);
    save(ENGINE_KEY, k);
  };
  const thenChips = [null, ...thens].map((k) => (
    <Chip
      key={k ?? "none"}
      on={second === k}
      onClick={() => {
        onThen(k);
        save(THEN_KEY, k ?? "");
      }}
    >
      {k ? engineLabel(k) : "None"}
    </Chip>
  ));
  const hint = <span className="text-zinc-600">best: ElevenLabs first, then NVIDIA</span>;
  const noteText = ENGINES.filter((e) => e.key === value || e.key === then).map((e) => e.note?.(avail)).find(Boolean);
  const macNote = noteText ? <p className="mt-2 text-[11px] text-amber-400/80">{noteText}</p> : null;

  if (compact) {
    return (
      <div className="w-full">
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-[11px] text-zinc-500">
          <span>Engine</span>
          <div className="flex flex-wrap gap-1.5">
            {ENGINES.map((e) => {
              const lock = lockReason(e.key, avail);
              return (
                <Chip key={e.key} on={value === e.key && !lock} lock={lock} title={lock ? `${e.name}: ${lock}` : e.name} onClick={() => pick(e.key)}>
                  {e.label}
                </Chip>
              );
            })}
          </div>
          {avail.admin && thens.length > 0 && (
            <>
              <span>Second pass</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {thenChips}
                {hint}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full">
      <div className="grid gap-2 sm:grid-cols-2">
        {ENGINES.map((e) => {
          const lock = lockReason(e.key, avail);
          return (
            <button
              key={e.key}
              type="button"
              disabled={!!lock}
              title={lock ? `${e.name}: ${lock}` : e.hint}
              onClick={() => pick(e.key)}
              className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed ${
                value === e.key && !lock
                  ? "border-violet-500 bg-violet-500/10"
                  : lock
                    ? "border-zinc-800/70 bg-zinc-900/30"
                    : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-600"
              }`}
            >
              <span className={`block text-xs font-medium ${lock ? "text-zinc-500" : "text-zinc-100"}`}>{e.name}</span>
              <span className={`mt-0.5 block text-[11px] leading-snug ${lock ? "text-zinc-600" : "text-zinc-500"}`}>{e.hint}</span>
              {lock && (
                <span className="mt-1.5 inline-flex items-center gap-1 rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] text-zinc-400">
                  <Lock className="h-2.5 w-2.5" /> {lock}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {macNote}
      {avail.admin && thens.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
          <span>Second pass:</span>
          {thenChips}
          {hint}
        </div>
      )}
    </div>
  );
}

/** What the progress card says while an engine works. */
function workingNote(s: EnhanceSession, avail: EnhanceAvailability | null): string {
  const now = s.chain?.[s.step ?? 0] ?? s.engine;
  const pass = (s.chain?.length ?? 1) > 1 ? `Pass ${(s.step ?? 0) + 1} of ${s.chain!.length}, ${engineLabel(now)}. ` : "";
  const working = ENGINES.find((e) => e.key === now)?.working;
  if (working) return pass + working(s, avail);

  if (now === "nvidia") return pass + "About half a minute a minute of audio — you can already listen to the original below.";
  return pass + "Usually seconds — you can already listen to the original below.";
}

const label =
  "mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500";

function StatusChip({ s }: { s: EnhanceSession }) {
  if (isEnhancing(s)) {
    return (
      <span className="flex items-center gap-1 text-[11px] text-violet-400">
        <Loader2 className="h-3 w-3 animate-spin" />
        {Math.round(s.progress * 100)}%
      </span>
    );
  }
  if (s.status === "needs_key") {
    return <span className="text-[11px] text-amber-400">Needs key</span>;
  }
  if (s.status === "error") {
    return <span className="text-[11px] text-red-400">Failed</span>;
  }
  if (s.hasEnhanced) {
    return (
      <span className="flex items-center gap-1 text-[11px] text-emerald-400">
        <Sparkles className="h-3 w-3" /> Enhanced
      </span>
    );
  }
  return <span className="text-[11px] text-zinc-500">Uploaded</span>;
}

function SessionView({
  session,
  avail,
  engine,
  setEngine,
  then,
  setThen,
  onChange,
  onClose,
  onDeleted,
}: {
  session: EnhanceSession;
  avail: EnhanceAvailability | null;
  engine: Engine;
  setEngine: (e: Engine) => void;
  then: Engine | null;
  setThen: (e: Engine | null) => void;
  onChange: (s: EnhanceSession) => void;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const second = avail?.admin && then !== engine ? then : null;

  // the strength: kept on the session (a download without ?mix= uses it too)
  const [mix, setMix] = useState(session.mix ?? 1);
  // Edit enhancement: the engines and "Enhance again", folded away until asked for
  const [editing, setEditing] = useState(false);
  const [mixOf, setMixOf] = useState(session.id);
  if (mixOf !== session.id) {
    setMixOf(session.id);
    setMix(session.mix ?? 1);
    setEditing(false);
  }
  const saveMix = useRef<ReturnType<typeof setTimeout>>(undefined);
  const changeMix = (v: number) => {
    setMix(v);
    clearTimeout(saveMix.current);
    saveMix.current = setTimeout(
      () => void setEnhanceMix(session.id, v).catch((e) => setError(e instanceof Error ? e.message : String(e))),
      600,
    );
  };
  const pct = Math.round(mix * 100);

  // poll while the job runs
  useEffect(() => {
    if (!isEnhancing(session)) return;
    const t = setInterval(async () => {
      const next = await getEnhance(session.id).catch(() => null);
      if (next) onChange(next);
    }, 1000);
    return () => clearInterval(t);
  }, [session, onChange]);

  const retry = async () => {
    setError(null);
    try {
      const [e, then] = retryPasses(session, engine, second);
      onChange(await runEnhance(session.id, e, then));
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const stop = async () => {
    onChange(await cancelEnhance(session.id).catch(() => session));
  };

  const remove = async () => {
    if (
      !window.confirm(`Delete “${session.name}”?\n\nThis cannot be undone.`)
    ) {
      return;
    }
    await deleteEnhance(session.id).catch(() => {});
    onDeleted();
  };

  return (
    <div className="w-full">
      <button
        onClick={onClose}
        className="mb-3 flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> All files
      </button>

      <div className="mb-4 flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
        {session.hasVideo ? (
          <Film className="h-4 w-4 shrink-0 text-zinc-500" />
        ) : (
          <FileAudio className="h-4 w-4 shrink-0 text-zinc-500" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-zinc-200">{session.name}</p>
          <p className="text-[11px] text-zinc-500">
            {session.duration > 0 && <>{fmtClock(session.duration)} · </>}
            {fmtBytes(session.bytes)}
            {session.hasVideo ? " · video" : " · audio"}
            {session.engine && <> · {chainLabel(session)}</>}
          </p>
        </div>
        {!isEnhancing(session) && (
          <button
            onClick={() => setEditing((v) => !v)}
            aria-expanded={editing}
            className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] transition-colors ${
              editing ? "border-violet-500/60 bg-violet-500/10 text-violet-200" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            }`}
          >
            <SlidersHorizontal className="h-3 w-3" /> Edit enhancement
            <ChevronDown className={`h-3 w-3 transition-transform ${editing ? "rotate-180" : ""}`} />
          </button>
        )}
        <button
          onClick={remove}
          title="Delete this file from the server"
          className="rounded p-1.5 text-zinc-600 hover:bg-zinc-800 hover:text-red-400"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {editing && !isEnhancing(session) && (
        <div className="-mt-2 mb-4 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-3">
          <EnginePicker compact avail={avail} value={engine} onChange={setEngine} then={then} onThen={setThen} />
          <button
            onClick={retry}
            className="mt-3 flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500"
          >
            <Sparkles className="h-3 w-3" /> {session.hasEnhanced ? "Enhance again" : "Enhance"} with{" "}
            {chainLabel({ engine, chain: second ? [engine, second] : [engine] })}
          </button>
        </div>
      )}

      {isEnhancing(session) && (
        <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-3">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 text-zinc-300">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400" />
              Enhancing…
            </span>
            <span className="text-zinc-500">
              {Math.round(session.progress * 100)}%
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-violet-500 transition-[width] duration-500"
              style={{ width: `${Math.max(2, session.progress * 100)}%` }}
            />
          </div>
          <div className="mt-2.5 flex items-center justify-between">
            <span className="text-[11px] text-zinc-500">
              {workingNote(session, avail)}
            </span>
            <button
              onClick={stop}
              className="rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-red-400"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {(session.status === "error" || session.status === "needs_key") && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5">
          <span className="min-w-0 text-xs text-red-300">
            {session.error || "Enhancement failed"}
          </span>
          <button
            onClick={retry}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            <RotateCcw className="h-3 w-3" /> Try again
          </button>
        </div>
      )}
      {session.status === "ready" &&
        !session.hasEnhanced &&
        !isEnhancing(session) && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
            <span className="text-xs text-zinc-400">
              Enhancement was cancelled.
            </span>
            <button
              onClick={retry}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-violet-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-violet-500"
            >
              <Sparkles className="h-3 w-3" /> Enhance
            </button>
          </div>
        )}
      {error && <p className="mb-3 text-[11px] text-red-400">{error}</p>}

      <EnhancePlayer session={session} mix={mix} onMix={changeMix} />

      {session.hasEnhanced && (
        <>
          <p className={`${label} mt-5`}>Download</p>
          <div className="flex gap-2">
            <button
              onClick={() => downloadEnhanced(session, "audio", mix)}
              className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-violet-500"
            >
              <Download className="h-3.5 w-3.5" /> Enhanced audio{pct < 100 && <> at {pct}%</>} (.m4a)
            </button>
            {session.videoOutExt && (
              <button
                onClick={() => downloadEnhanced(session, "video", mix)}
                className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3.5 py-2 text-xs text-zinc-200 hover:bg-zinc-800"
              >
                <Film className="h-3.5 w-3.5" /> Video with clean audio (.
                {session.videoOutExt})
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function EnhancePage() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [drag, setDrag] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // the saved list shows at once and refreshes underneath (lib/local-cache)
  const { items: sessions, setItems: setSessions, refresh: loadSessions } = useCachedList("/api/enhance", listEnhance);
  const [current, setCurrent] = useState<EnhanceSession | null>(null);
  const [openingSession, setOpeningSession] = useState(false);
  const [avail, setAvail] = useState<EnhanceAvailability | null>(null);
  const [engine, setEngine] = useState<Engine>("nvidia");
  const [then, setThen] = useState<Engine | null>(null);
  const second = avail?.admin && then !== engine ? then : null;

  useEffect(() => {
    getAvailability()
      .then((a) => {
        setAvail(a);
        // the last ones picked, if still offered; else the server's default
        const can = offered(a);
        setEngine(can.find((e) => e.key === saved(ENGINE_KEY))?.key ?? a.default);
        if (a.admin) setThen(can.find((e) => e.key === saved(THEN_KEY))?.key ?? null);
      })
      .catch(() => {});
  }, []);

  // The route id lets Admin open any user's Audio Enhancer project and
  // also makes ordinary audio projects directly addressable.
  useEffect(() => {
    if (!sessionId) {
      setOpeningSession(false);
      setCurrent(null);
      return;
    }

    let cancelled = false;
    setCurrent(null);
    setOpeningSession(true);
    setUploadError(null);
    getEnhance(sessionId)
      .then((session) => {
        if (!cancelled) setCurrent(session);
      })
      .catch((e) => {
        if (!cancelled) {
          setUploadError(
            e instanceof Error ? e.message : "Could not open audio project",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setOpeningSession(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const refreshList = useCallback(() => {
    loadSessions().catch(() => {});
  }, [loadSessions]);

  const upload = async (f: File) => {
    setUploadError(null);
    setUploadPct(0);
    try {
      // the server queues the enhancement in the same go — the session
      // arrives already running
      const s = await uploadEnhance(f, engine, second, setUploadPct);
      setCurrent(s);
      navigate(`/enhance/${s.id}`);
      refreshList();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploadPct(null);
    }
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void upload(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, second]);

  return (
    <div className="relative flex min-h-screen flex-col items-center bg-zinc-950 pb-10 text-zinc-200">
      <AppBar tool="Audio Enhancer" to={current ? "/enhance" : undefined} trail={current?.name} />

      <ToolIntro icon={AudioLines} title="Audio Enhancer" line="Studio sound for any recording — denoise · de-echo · level" />
      <div className="w-[560px] max-w-[92vw]">
        <ToolSetupLine tool="enhance" />
      </div>

      <div className="w-[560px] max-w-[92vw]">
        {openingSession ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Opening audio project…
          </div>
        ) : current ? (
          <>
            <SessionView
              session={current}
              avail={avail}
              engine={engine}
              setEngine={setEngine}
              then={then}
              setThen={setThen}
              onChange={(s) => {
                setCurrent(s);
                setSessions((list) => list.map((x) => (x.id === s.id ? s : x)));
              }}
              onClose={() => {
                navigate("/enhance");
                refreshList();
              }}
              onDeleted={() => {
                setSessions((list) => list.filter((x) => x.id !== current.id));
                navigate("/enhance");
              }}
            />
          </>
        ) : (
          <>
            <div className="mb-3">
              <EnginePicker avail={avail} value={engine} onChange={setEngine} then={then} onThen={setThen} />
            </div>
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={onDrop}
              className={dropZoneClass(drag, "cursor-pointer")}
            >
              {uploadPct !== null ? (
                <>
                  <Loader2 className="mb-4 h-9 w-9 animate-spin text-violet-400" />
                  <p className="text-base font-medium">
                    {uploadPct < 100
                      ? `Uploading… ${uploadPct}%`
                      : "Starting enhancement…"}
                  </p>
                </>
              ) : (
                <>
                  <DropZoneText
                    title="Drop an audio or video file, or click to browse"
                    hint="Enhanced automatically the moment it lands — the original is never changed"
                  />
                </>
              )}
              <input
                type="file"
                accept="audio/*,video/*,.mkv,.mov,.mp4,.webm,.m4v,.mp3,.wav,.m4a,.aac,.flac,.ogg"
                className="hidden"
                disabled={uploadPct !== null}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                  e.target.value = "";
                }}
              />
            </label>
            {uploadError && (
              <p className="mt-2 text-xs text-red-400">{uploadError}</p>
            )}

            {sessions.length > 0 && (
              <div className="mt-8">
                <h2 className={label}>Your files</h2>
                <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-1">
                  {sessions.map((s) => (
                    <div
                      key={s.id}
                      onClick={() => navigate(`/enhance/${s.id}`)}
                      className="group flex cursor-pointer items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 transition-colors hover:border-violet-500/50 hover:bg-zinc-900"
                    >
                      {s.hasVideo ? (
                        <Film className="h-4 w-4 shrink-0 text-zinc-500" />
                      ) : (
                        <FileAudio className="h-4 w-4 shrink-0 text-zinc-500" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-zinc-200">
                          {s.name}
                        </p>
                        <p className="text-[11px] text-zinc-500">
                          {timeAgo(s.createdAt)}
                          {s.duration > 0 && <> · {fmtClock(s.duration).slice(0, 5)}</>}
                          {s.engine && <> · {chainLabel(s)}</>}
                        </p>
                      </div>
                      <StatusChip s={s} />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (
                            !window.confirm(
                              `Delete “${s.name}”?\n\nThis cannot be undone.`,
                            )
                          ) {
                            return;
                          }
                          void deleteEnhance(s.id).then(() =>
                            setSessions((list) =>
                              list.filter((x) => x.id !== s.id),
                            ),
                          );
                        }}
                        title="Delete"
                        className="rounded p-1.5 text-zinc-600 opacity-0 transition-opacity hover:bg-zinc-800 hover:text-red-400 group-hover:opacity-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
