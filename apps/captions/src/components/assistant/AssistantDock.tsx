import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ArrowUpRight, Check, Copy, CornerDownLeft, FileText, History, KeyRound, MessageCircle, PanelRight, PanelRightClose, Pencil, RotateCcw, SquarePen, Trash2, VolumeX, X } from "lucide-react";
import type { AssistantImage, AssistantMessage, AssistantView } from "@contracts/assistant";
import { ReplyText } from "@/components/ReplyText";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMe } from "@/lib/auth";
import {
  cancelSecret,
  chatText,
  deletePast,
  getAssistant,
  keySaved,
  navigated,
  openAssistant,
  openPast,
  saveKey,
  sendTurn,
  startOver,
  stopTurn,
  useAssistant,
} from "@/lib/assistant";
import { cornerOf, storePlace, storedPlace, type Corner, type Place } from "@/lib/dock-place";
import { pageContext } from "@/lib/page-context";
import { speak, stopSpeaking, unlockAudio, useReadAloud } from "@/lib/read-aloud";
import { cn } from "@/lib/utils";
import { Composer, PictureOverlay } from "./Composer";
import { EMPTY_DRAFT, MAX_PICTURES, isLongPaste, isPicture, toPicture, type Draft } from "./draft";
import { useThrow } from "./useThrow";
import { Elapsed, WorkCards } from "./WorkCards";

/** Width of the chat docked to the right edge; the page moves over by as much. */
const DOCK_W = 400;
/** Below the pages' top bars, above the corner buttons bottom left. */
const AT: Record<Corner, string> = { tl: "left-4 top-16", tr: "right-4 top-16", bl: "left-4 bottom-14", br: "right-4 bottom-4" };
const ORIGIN: Record<Corner, string> = { tl: "origin-top-left", tr: "origin-top-right", bl: "origin-bottom-left", br: "origin-bottom-right" };

const QUEUE_KEY = "ct-assistant:queue";
/** A message waiting its turn, with what goes with it (an older stored one is only { id, text }). */
type Queued = { id: string; text: string; images?: AssistantImage[]; pasted?: Draft["pasted"]; quote?: string };
const storedQueue = (): Queued[] => {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]") as Queued[];
  } catch {
    return [];
  }
};

/** A few things to ask, for the page you're on; a tap sends it. */
function suggestionsFor(path: string): string[] {
  if (path.startsWith("/workshop")) return ["Tighten the piece I'm on", "Give me three other hooks", "What should I make next?"];
  if (path.startsWith("/review")) return ["What's new in Review?", "Sum up the comments on my latest video", "Which versions are approved?"];
  if (path.startsWith("/editor")) return ["How are my edits doing?", "What changed in the last draft?"];
  if (path.startsWith("/instagram") || path.startsWith("/analyzer")) return ["How did my last five posts do?", "Refresh my Instagram numbers"];
  return ["Where did I leave off?", "What can I finish right away?", "Find my next content idea"];
}

/**
 * The assistant, on every signed-in page (App.tsx): a bubble you can drag or throw to any corner, that opens into
 * the chat. Drag the chat by its header to another corner, or against the right edge to dock it there as a panel
 * beside the page. Its state is the server's (api/assistant.ts): no AI yet = "Install Claude Code first"; an AI = the
 * chat; the choice of setup paths only when asked for (openAssistant("setup")). It starts folded to the bubble. A key it asks for is
 * typed into a password box that saves straight to My API keys. You can talk to it (the mic) and have its replies
 * read aloud (the speaker).
 */
export function AssistantDock() {
  const me = useMe();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { collapsed, setupAsked, set, quote, setQuote, images: handed } = useAssistant();
  const readAloud = useReadAloud();
  const real = !!me;
  const [view, setView] = useState<AssistantView | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [place, setPlaceState] = useState<Place>(storedPlace);
  const [closing, setClosing] = useState(false);
  /** The last message you've seen (undefined until the first load): a newer reply while closed nudges the bubble. */
  const [seenId, setSeenId] = useState<string | null | undefined>(undefined);
  /** The list of earlier conversations shows in place of the chat. */
  const [showPast, setShowPast] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLElement>(null);

  const setPlace = useCallback((p: Place) => {
    setPlaceState(p);
    storePlace(p);
  }, []);
  const bubbleThrow = useThrow(bubbleRef, false, setPlace);
  const cardThrow = useThrow(cardRef, true, setPlace);

  const load = useCallback(async () => {
    const r = await getAssistant();
    if (!r.ok) return;
    setView(r.data);
    setSeenId((s) => (s === undefined ? (r.data.messages.at(-1)?.id ?? null) : s));
  }, []);

  // the provider is read with the view: again on each page (back from Settings → AI providers) and when the window comes back
  useEffect(() => {
    if (real) void load();
  }, [real, load, pathname]);
  useEffect(() => {
    if (!real) return;
    const again = () => void load();
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [real, load]);

  const last = view?.messages.at(-1);
  const thinking = last?.status === "thinking";
  // a reply on the Mac takes a while: look again every 1.5 s until it's done
  useEffect(() => {
    if (!real || !thinking) return;
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [real, thinking, load]);

  // a reply that just finished: read it aloud, when that's on
  const waitingOn = useRef<string | null>(null);
  useEffect(() => {
    if (!last) return;
    if (last.status === "thinking") waitingOn.current = last.id;
    else if (waitingOn.current === last.id) {
      waitingOn.current = null;
      if (last.status === "done" && last.text && useReadAloud.getState().on) speak(last.text);
    }
  }, [last]);
  const unread = collapsed && seenId !== undefined && last?.role === "assistant" && last.status === "done" && last.id !== seenId;

  // a page the assistant opened: move there once, then clear it on the server
  useEffect(() => {
    if (!view?.navigate) return;
    navigate(view.navigate);
    void navigated().then((r) => r.ok && setView(r.data));
  }, [view?.navigate, navigate]);

  useEffect(() => {
    if (!collapsed) bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [view?.messages.length, last?.text, last?.steps?.length, view?.pending, collapsed]);

  // docked and open: the page moves over to make room
  const docked = !collapsed && place.mode === "dock";
  useEffect(() => {
    if (!docked) return;
    const body = document.body.style;
    body.transition = "padding-right 300ms cubic-bezier(.2,.8,.2,1)";
    body.paddingRight = `${DOCK_W}px`;
    return () => {
      body.paddingRight = "";
    };
  }, [docked]);

  // the current project's colour, like the home page's tools (violet when Settings → Appearance turns it off)
  const tint = { "--tint": "rgb(var(--violet-600))" } as React.CSSProperties; // the project's colour (data-tint on <html>)

  const send = async (it: Omit<Queued, "id">): Promise<boolean> => {
    stopSpeaking();
    unlockAudio();
    setBusy(true);
    setError(null);
    const r = await sendTurn({
      text: it.text,
      ...(it.images?.length ? { images: it.images } : {}),
      ...(it.pasted?.length ? { pasted: it.pasted } : {}),
      context: { ...pageContext(), ...(it.quote ? { selection: it.quote } : {}) },
    });
    setBusy(false);
    if (r.ok) setView(r.data);
    else {
      setError(r.error);
      if (r.code === "NO_PROVIDER") void load();
    }
    return r.ok;
  };

  // The queue, as in the Workshop's chat: Enter while a reply runs adds the message here, and the first one sends
  // when the reply is done. Steer stops the reply and sends that one now; Edit puts it back in the box.
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [queue, setQueue] = useState<Queued[]>(storedQueue);
  // a queued message the server refused stays first and waits for a click (no retry loop)
  const [held, setHeld] = useState(false);
  const sending = useRef(false);
  useEffect(() => {
    const save = (q: Queued[]) => (q.length ? localStorage.setItem(QUEUE_KEY, JSON.stringify(q)) : localStorage.removeItem(QUEUE_KEY));
    try {
      save(queue);
    } catch {
      // pictures too big for this browser's storage: keep the words, the pictures stay until reload
      try {
        save(queue.map((it) => ({ ...it, images: undefined })));
      } catch {
        /* the queue stays until reload */
      }
    }
  }, [queue]);

  // Pictures and long pastes: dropped on the card, pasted, picked with the paperclip, or handed over from
  // elsewhere in the app (a screenshot of this screen). Each one is shrunk here to stay well under the server's cap.
  const [dropping, setDropping] = useState(false);
  const addPictures = useCallback((imgs: AssistantImage[]) => {
    setDraft((d) => {
      if (d.images.length + imgs.length > MAX_PICTURES) setError(`At most ${MAX_PICTURES} pictures go with one message`);
      return { ...d, images: [...d.images, ...imgs].slice(0, MAX_PICTURES) };
    });
  }, []);
  const addFiles = useCallback(
    async (files: File[]) => {
      const pics = files.filter(isPicture);
      if (pics.length < files.length) setError("Only pictures can go with a message: paste text into the box");
      if (!pics.length) return;
      try {
        addPictures(await Promise.all(pics.map(toPicture)));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [addPictures],
  );
  const handlePaste = useCallback(
    (data: DataTransfer): boolean => {
      const pics = Array.from(data.files).filter(isPicture);
      if (pics.length) {
        void addFiles(pics);
        return true;
      }
      const t = data.getData("text/plain");
      if (!isLongPaste(t)) return false;
      setDraft((d) => ({ ...d, pasted: [...d.pasted, { name: d.pasted.length ? `Pasted text ${d.pasted.length + 1}` : "Pasted text", text: t }] }));
      return true;
    },
    [addFiles],
  );
  // a paste while a dock button has focus (not the box) still lands in the box
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const a = document.activeElement;
      if (!e.clipboardData || !cardRef.current?.contains(a) || a?.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      if (handlePaste(e.clipboardData)) return;
      const t = e.clipboardData.getData("text/plain");
      if (t) setDraft((d) => ({ ...d, text: d.text + t }));
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [handlePaste]);
  // a picture handed to the dock from elsewhere (useAssistant.addImage) moves into the box
  useEffect(() => {
    if (handed.length) addPictures(useAssistant.getState().takeImages());
  }, [handed, addPictures]);
  const connectedNow = !!view && view.provider !== "none";
  useEffect(() => {
    const next = queue[0];
    if (!next || thinking || held || !connectedNow || sending.current) return;
    sending.current = true;
    void send(next).then((ok) => {
      sending.current = false;
      if (ok) setQueue((q) => q.filter((x) => x.id !== next.id));
      else setHeld(true);
    });
    // send is a fresh function each render; the queue, the reply and the hold decide when to go
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, thinking, held, connectedNow]);
  /** A message (and the highlighted text it asks about) back in the box, after what's there. */
  const putBack = (it: Queued) => {
    setDraft((cur) => ({
      text: cur.text.trim() ? `${cur.text}\n\n${it.text}` : it.text,
      images: [...cur.images, ...(it.images ?? [])].slice(0, MAX_PICTURES),
      pasted: [...cur.pasted, ...(it.pasted ?? [])],
    }));
    if (it.quote) setQuote(it.quote);
  };
  // the pending highlighted text goes with this message and leaves the box
  const submit = (d: Draft) => {
    const it: Queued = { id: `${Date.now()}-${queue.length}`, ...d, ...(quote ? { quote } : {}) };
    setQuote(null);
    if (thinking || busy || queue.length) setQueue((q) => [...q, it]);
    // refused or failed: it comes back to the box rather than being lost
    else void send(it).then((ok) => !ok && putBack(it));
  };
  const stop = () => void stopTurn().then((r) => r.ok && setView(r.data));
  const steer = (id: string) => {
    setQueue((q) => [...q.filter((x) => x.id === id), ...q.filter((x) => x.id !== id)]);
    setHeld(false);
    if (thinking) stop();
  };
  const editQueued = (it: Queued) => {
    setQueue((q) => q.filter((x) => x.id !== it.id));
    if (queue[0]?.id === it.id) setHeld(false);
    putBack(it);
  };
  const unqueue = (it: Queued) => {
    setQueue((q) => q.filter((x) => x.id !== it.id));
    if (queue[0]?.id === it.id) setHeld(false);
  };

  if (!real) return null;

  const corner = cornerOf(place);

  if (collapsed) {
    return (
      <button
        ref={bubbleRef}
        type="button"
        onPointerDown={bubbleThrow.onPointerDown}
        onClick={() => {
          if (bubbleThrow.dragged.current) return;
          setSeenId(last?.id ?? null);
          openAssistant();
        }}
        aria-label={unread ? "Open the assistant: a new reply" : "Open the assistant"}
        style={tint}
        title="Assistant · drag to move"
        className={cn(
          "group fixed z-40 size-14 touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint)] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-50 motion-safe:duration-300",
          AT[corner],
        )}
      >
        {thinking && <span className="absolute inset-0 rounded-full bg-[color-mix(in_srgb,var(--tint)_50%,transparent)] motion-safe:animate-ping" aria-hidden />}
        <span
          className={cn(
            "relative flex size-full items-center justify-center rounded-full bg-[var(--tint)] text-white shadow-lg shadow-black/25",
            "transition-transform duration-300 ease-[cubic-bezier(.3,1.6,.5,1)] group-hover:scale-110 group-active:scale-95",
            unread && "motion-safe:animate-[ct-nudge_0.9s_ease-out_2]",
          )}
        >
          <MessageCircle className="size-6 transition-transform duration-300 group-hover:-rotate-12" aria-hidden />
          {unread && <span className="absolute top-0.5 right-0.5 size-3.5 rounded-full border-2 border-background bg-emerald-400" aria-hidden />}
        </span>
        {/* its line beside the bubble, on the page's side of whichever corner it sits in */}
        <span
          className={cn(
            "pointer-events-none absolute top-1/2 -translate-y-1/2 rounded-full border bg-popover px-4 py-2 text-sm whitespace-nowrap text-popover-foreground shadow-md",
            corner.endsWith("r") ? "right-full mr-3" : "left-full ml-3",
          )}
        >
          I&apos;m here if you need me.
        </span>
      </button>
    );
  }

  const close = () => {
    setSeenId(last?.id ?? null);
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      set({ collapsed: true });
    }, 160);
  };

  const pick = (how: "self" | "chat") => {
    set({ setupAsked: false });
    if (how === "self") navigate("/?setup=how");
    else void send({ text: "Set me up. Go one step at a time." });
  };

  const later = () => set({ collapsed: true, setupAsked: false });

  const connected = !!view && view.provider !== "none";
  const showChoice = connected && setupAsked;
  const chatting = connected && !showChoice;
  const empty = chatting && !view.messages.length;
  const pending = view?.pending;
  const headBtn = "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40";

  return (
    <section
      ref={cardRef}
      aria-label="Assistant"
      className={cn(
        "fixed z-40 flex flex-col overflow-hidden bg-popover text-popover-foreground",
        place.mode === "dock"
          ? "inset-y-0 right-0 border-l shadow-2xl"
          : cn("h-[min(600px,calc(100dvh-6rem))] w-[min(400px,calc(100vw-2rem))] rounded-2xl border shadow-2xl shadow-black/30", AT[place.corner], ORIGIN[place.corner]),
        // opening grows out of the bubble's corner with a little overshoot (docked: slides in); closing shrinks back
        closing
          ? cn("motion-safe:animate-out motion-safe:fill-mode-forwards motion-safe:duration-150", place.mode === "dock" ? "motion-safe:slide-out-to-right" : "motion-safe:fade-out motion-safe:zoom-out-90")
          : cn(
              "motion-safe:animate-in motion-safe:duration-300",
              place.mode === "dock" ? "motion-safe:slide-in-from-right" : "motion-safe:fade-in motion-safe:zoom-in-90 motion-safe:ease-[cubic-bezier(.3,1.3,.5,1)]",
            ),
      )}
      style={place.mode === "dock" ? { ...tint, width: DOCK_W } : tint}
      onDragOver={(e) => {
        if (!connectedNow || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        if (!connectedNow || !e.dataTransfer.files.length) return;
        e.preventDefault();
        void addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {dropping && (
        <div className="pointer-events-none absolute inset-1.5 z-10 flex items-center justify-center rounded-[14px] border-2 border-dashed border-[var(--tint)] bg-[color-mix(in_srgb,var(--tint)_10%,transparent)] text-sm font-medium text-[var(--tint)] motion-safe:animate-in motion-safe:fade-in">
          Drop pictures to add them
        </div>
      )}
      <header
        onPointerDown={cardThrow.onPointerDown}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          cardThrow.moveTo(place.mode === "dock" ? { mode: "float", corner: "br" } : { mode: "dock" });
        }}
        className="flex shrink-0 cursor-grab touch-none items-center gap-2.5 px-4 pt-3 pb-2 select-none active:cursor-grabbing"
        title="Drag to move · against the right edge to dock · double-click to dock or float"
      >
        <span className="relative flex size-2.5" aria-hidden>
          {thinking && <span className="absolute inset-0 rounded-full bg-[color-mix(in_srgb,var(--tint)_70%,transparent)] motion-safe:animate-ping" />}
          <span className={cn("relative size-2.5 rounded-full transition-colors duration-500", thinking ? "bg-[var(--tint)]" : connected ? "bg-emerald-500" : "bg-muted-foreground/50")} />
        </span>
        <span className="flex-1 text-sm font-semibold tracking-tight">Assistant</span>
        {/* read-aloud is an add-on (Settings → General): the dock only offers to stop a reply being read */}
        {readAloud.speaking && (
          <button type="button" onClick={stopSpeaking} className={cn(headBtn, "text-[var(--tint)] motion-safe:animate-pulse")} aria-label="Stop reading aloud" title="Stop reading">
            <VolumeX className="size-4" />
          </button>
        )}
        {!!view?.messages.length && !showPast && <CopyButton className={headBtn} text={() => chatText(view.messages)} label="Copy the whole chat" />}
        {!!view?.past.length && (
          <button
            type="button"
            className={cn(headBtn, showPast && "bg-muted text-foreground")}
            onClick={() => setShowPast((s) => !s)}
            aria-pressed={showPast}
            aria-label="Earlier chats"
            title="Earlier chats"
          >
            <History className="size-4" />
          </button>
        )}
        {!!view?.messages.length && (
          <button
            type="button"
            className={headBtn}
            disabled={thinking}
            onClick={() => {
              stopSpeaking();
              setShowPast(false);
              void startOver().then((r) => {
                if (!r.ok) return;
                setView(r.data);
                setSeenId(null);
              });
            }}
            aria-label="Start a new chat"
            title="New chat (this one stays in Earlier chats)"
          >
            <SquarePen className="size-4" />
          </button>
        )}
        <button
          type="button"
          className={headBtn}
          onClick={() => cardThrow.moveTo(place.mode === "dock" ? { mode: "float", corner: "br" } : { mode: "dock" })}
          aria-label={place.mode === "dock" ? "Float over the page" : "Dock to the side"}
          title={place.mode === "dock" ? "Float over the page" : "Dock to the side"}
        >
          {place.mode === "dock" ? <PanelRightClose className="size-4" /> : <PanelRight className="size-4" />}
        </button>
        <button type="button" className={headBtn} onClick={close} aria-label="Hide the assistant" title="Hide">
          <X className="size-4" />
        </button>
      </header>

      <div className="relative min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-3 text-sm">
        {!view && <Dots />}

        {view && showPast && (
          <PastList
            view={view}
            busy={thinking}
            onOpen={(id) =>
              void openPast(id).then((r) => {
                if (!r.ok) return setError(r.error);
                setView(r.data);
                setSeenId(r.data.messages.at(-1)?.id ?? null);
                setShowPast(false);
              })
            }
            onDelete={(id) => void deletePast(id).then((r) => r.ok && setView(r.data))}
          />
        )}

        {view?.provider === "none" && (
          <div className="flex h-full flex-col items-start justify-end gap-3 pb-2 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2">
            <p className="text-base font-semibold">Install Claude Code first</p>
            <p className="text-muted-foreground">The assistant runs on your own Claude, on this Mac and your own plan. Install it and sign in, then come back:</p>
            <pre className="w-full select-all rounded bg-muted px-2 py-1.5 text-xs">npm install -g @anthropic-ai/claude-code{"\n"}claude</pre>
            <Button size="sm" variant="outline" onClick={() => navigate("/?setup=ai")}>Check again</Button>
          </div>
        )}

        {showChoice && (
          <div className="flex h-full flex-col justify-end gap-3 pb-1 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2">
            <p>Want help setting up Creator Toolset?</p>
            <div className="flex flex-col gap-2">
              <Button variant="outline" onClick={() => pick("self")}>Do it myself (click through the setup)</Button>
              <Button onClick={() => pick("chat")} disabled={busy}>Set up with chat</Button>
              <Button variant="ghost" onClick={later}>Later</Button>
            </div>
          </div>
        )}

        {empty && !showPast && (
          <div className="flex h-full flex-col justify-end gap-2 pb-1">
            {suggestionsFor(pathname).map((s, i) => (
              <button
                key={`${pathname}-${s}`}
                type="button"
                disabled={busy}
                onClick={() => submit({ ...EMPTY_DRAFT, text: s })}
                style={{ animationDelay: `${i * 60}ms` }}
                className={cn(
                  "group flex w-fit max-w-full items-center gap-2 rounded-2xl border bg-background px-3.5 py-2 text-left text-sm transition-all duration-200",
                  "hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--tint)_50%,transparent)] hover:shadow-md active:translate-y-0",
                  "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:fill-mode-both motion-safe:duration-300",
                )}
              >
                <span>{s}</span>
                <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-[var(--tint)]" />
              </button>
            ))}
          </div>
        )}

        {chatting && !empty && !showPast && (
          <div className="flex flex-col gap-3">
            {view.messages.map((m, i, all) => {
              const asked = all[i - 1];
              // the last reply failed or was cut off (a restart, the Mac gone): send the question again
              const retry =
                i === all.length - 1 && m.status === "error" && asked?.role === "user" && !thinking && !busy
                  ? () => void send({ text: asked.text, ...(asked.quote ? { quote: asked.quote } : {}) })
                  : undefined;
              return <Message key={m.id} m={m} onRetry={retry} />;
            })}
          </div>
        )}

        {pending && (
          <form
            className="mt-3 space-y-2 rounded-lg border border-dashed p-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const value = secret.trim();
              setSecret("");
              if (!value) return;
              const saved = await saveKey(pending.env, value);
              if (!saved.ok) return setError(saved.error);
              const r = await keySaved(pending.env);
              if (r.ok) setView(r.data);
              else setError(r.error);
            }}
          >
            <p className="flex items-center gap-2 font-medium"><KeyRound className="size-4" aria-hidden /> {pending.name} key</p>
            <p className="text-muted-foreground">{pending.why}</p>
            <Input type="password" autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={`Paste your ${pending.name} key`} aria-label={`${pending.name} key`} />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={!secret.trim()}>Save key</Button>
              <Button type="button" size="sm" variant="ghost" onClick={async () => { setSecret(""); const r = await cancelSecret(); if (r.ok) setView(r.data); }}>Not now</Button>
            </div>
          </form>
        )}

        {error && (
          <p role="alert" className="mt-3 text-xs text-destructive motion-safe:animate-in motion-safe:fade-in">
            {error}
          </p>
        )}
        <div ref={bottom} />
      </div>

      {chatting && (
        <div className="shrink-0 px-3 pt-1 pb-3">
          {queue.length > 0 && (
            <ul className="mb-1.5 flex flex-col gap-1">
              {queue.map((it, i) => (
                <li
                  key={it.id}
                  className="flex items-center gap-2 rounded-xl border bg-muted/60 px-3 py-1.5 text-[13px] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1"
                >
                  <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground uppercase">{i === 0 && held ? "Not sent" : "Queued"}</span>
                  <span className="min-w-0 flex-1 truncate" title={it.text}>
                    {it.text.trim() || attachmentsLabel(it)}
                    {it.text.trim() && attachmentsLabel(it) ? <span className="ml-1.5 text-[11px] text-muted-foreground">+ {attachmentsLabel(it)}</span> : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => steer(it.id)}
                    className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--tint)] hover:bg-[color-mix(in_srgb,var(--tint)_15%,transparent)]"
                    title={thinking ? "Steer: stop the reply and send this now" : "Send this now"}
                  >
                    <CornerDownLeft className="size-3" /> {thinking ? "Steer" : "Send"}
                  </button>
                  <button type="button" onClick={() => editQueued(it)} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground" title="Edit: back into the message box" aria-label="Edit queued message">
                    <Pencil className="size-3" />
                  </button>
                  <button type="button" onClick={() => unqueue(it)} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground" title="Remove from the queue" aria-label="Remove queued message">
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Composer
            draft={draft}
            setDraft={setDraft}
            onSend={(d) => {
              setDraft(EMPTY_DRAFT);
              submit(d);
            }}
            onStop={stop}
            onFiles={(fs) => void addFiles(fs)}
            onPaste={handlePaste}
            quote={quote}
            onDropQuote={() => setQuote(null)}
            waiting={busy || thinking}
            autoFocus
          />
        </div>
      )}
    </section>
  );
}

/** "2 pictures, Pasted text": what a queued message carries besides its words. */
const attachmentsLabel = (it: Queued) =>
  [it.images?.length ? `${it.images.length} picture${it.images.length === 1 ? "" : "s"}` : "", ...(it.pasted ?? []).map((p) => p.name)].filter(Boolean).join(", ");

function Message({ m, onRetry }: { m: AssistantMessage; onRetry?: () => void }) {
  const [big, setBig] = useState<string | null>(null);
  const enter = "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300";
  if (m.role === "note") return <p className={cn("mx-auto max-w-[90%] text-center text-xs text-muted-foreground", enter)}>{m.text}</p>;
  if (m.role === "user")
    return (
      <div className={cn("ml-auto flex max-w-[85%] flex-col items-end gap-1", enter)}>
        {m.quote && (
          <p className="line-clamp-2 border-r-2 border-[color-mix(in_srgb,var(--tint)_50%,transparent)] pr-2 text-right text-xs text-muted-foreground" title={m.quote}>
            «{m.quote}»
          </p>
        )}
        {(!!m.images?.length || !!m.pasted?.length) && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {m.images?.map((im) => (
              <button key={im.id} type="button" onClick={() => setBig(`/api/assistant/images/${encodeURIComponent(im.id)}`)} title={im.name} aria-label={`Show ${im.name}`} className="cursor-zoom-in">
                <img src={`/api/assistant/images/${encodeURIComponent(im.id)}`} alt={im.name} loading="lazy" className="size-16 rounded-lg border bg-muted object-cover" />
              </button>
            ))}
            {m.pasted?.map((name, i) => (
              <span key={i} className="flex h-8 items-center gap-1.5 rounded-lg border bg-muted px-2 text-[11px]">
                <FileText className="size-3.5 shrink-0 text-[var(--tint)]" aria-hidden />
                {name}
              </span>
            ))}
          </div>
        )}
        {m.text.trim() && (
          <div className="group/msg flex items-end gap-1">
            <CopyButton className={msgCopy} text={() => m.text} label="Copy" />
            <div className={cn("rounded-2xl rounded-br-md bg-[var(--tint)] px-3.5 py-2 whitespace-pre-wrap text-white", enter, "motion-safe:slide-in-from-bottom-2 motion-safe:zoom-in-95 motion-safe:origin-bottom-right")}>
              {m.text}
            </div>
          </div>
        )}
        {big && <PictureOverlay src={big} onClose={() => setBig(null)} />}
      </div>
    );
  const steps = m.steps ?? [];
  const working = m.status === "thinking";
  if (working && !m.text)
    return (
      <div className="space-y-1">
        <Steps steps={steps} working />
        <Elapsed since={m.at} />
        <WorkCards work={m.work} />
        <Dots />
      </div>
    );
  const again = onRetry && (
    <button
      type="button"
      onClick={onRetry}
      className="mt-1.5 flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:border-[color-mix(in_srgb,var(--tint)_50%,transparent)] hover:text-[var(--tint)]"
      title="Send your last message again"
    >
      <RotateCcw className="size-3.5" /> Try again
    </button>
  );
  if (m.status === "error" && !m.text)
    return (
      <div>
        <WorkCards work={m.work} />
        <p className={cn("text-destructive", enter)}>That didn&apos;t work.</p>
        {again}
      </div>
    );
  return (
    <div className={cn("group/msg max-w-[94%] leading-relaxed", enter, "motion-safe:slide-in-from-bottom-1")}>
      {working ? (
        <Steps steps={steps} working />
      ) : (
        steps.length > 0 && (
          <details className="group mb-1.5 text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer list-none select-none hover:text-foreground">
              {steps.length === 1 ? steps[0] : `${steps.length} steps`}
              {steps.length > 1 && <span className="ml-1 inline-block transition-transform group-open:rotate-90">›</span>}
            </summary>
            {steps.length > 1 && <Steps steps={steps} />}
          </details>
        )
      )}
      {working && <Elapsed since={m.at} />}
      <WorkCards work={m.work} />
      {m.status === "error" ? <p className="text-destructive">{m.text}</p> : <ReplyText text={m.text} />}
      {again}
      {m.status === "thinking" && <span className="ml-0.5 inline-block h-3.5 w-1.5 rounded-sm bg-[var(--tint)] align-middle motion-safe:animate-pulse" aria-hidden />}
      {!working && <CopyButton className={cn(msgCopy, "-ml-1 mt-0.5")} text={() => m.text} label="Copy" />}
    </div>
  );
}

const msgCopy =
  "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-60";

/** Copies text; a tick for a moment says it did. */
function CopyButton({ text, label, className }: { text: () => string; label: string; className: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={done ? "Copied" : label}
      onClick={() =>
        void navigator.clipboard.writeText(text()).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        })
      }
    >
      {done ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
    </button>
  );
}

const ago = (at: number) => {
  const d = new Date(at);
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days < 1 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
};

/** Earlier chats, newest first: open one to read it or carry on; the bin deletes it for good. */
function PastList({ view, busy, onOpen, onDelete }: { view: AssistantView; busy: boolean; onOpen: (id: string) => void; onDelete: (id: string) => void }) {
  return (
    <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1">
      <p className="mb-2 text-xs font-medium text-muted-foreground">Earlier chats</p>
      <ul className="flex flex-col">
        {view.past.map((p) => (
          <li key={p.id} className="group/past flex items-center gap-1 rounded-lg hover:bg-muted">
            <button
              type="button"
              disabled={busy}
              onClick={() => onOpen(p.id)}
              className="flex min-w-0 flex-1 items-baseline gap-2 px-2.5 py-2 text-left disabled:opacity-50"
              title={busy ? "Wait for the reply first" : "Open this chat"}
            >
              <span className="min-w-0 flex-1 truncate">{p.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{ago(p.at)}</span>
            </button>
            <button
              type="button"
              onClick={() => onDelete(p.id)}
              className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-background hover:text-destructive focus-visible:opacity-100 group-hover/past:opacity-100"
              aria-label={`Delete "${p.title}"`}
              title="Delete for good"
            >
              <Trash2 className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the reply did on the way, one line per tool; while it works, the newest one pulses. */
function Steps({ steps, working = false }: { steps: string[]; working?: boolean }) {
  if (!steps.length) return null;
  return (
    <ul className="mt-1 mb-1.5 space-y-0.5 text-xs text-muted-foreground">
      {steps.map((s, i) => {
        const now = working && i === steps.length - 1;
        return (
          <li key={i} className="flex items-center gap-1.5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-left-1 motion-safe:duration-300">
            <span className={cn("size-1.5 shrink-0 rounded-full", now ? "bg-[var(--tint)] motion-safe:animate-pulse" : "bg-muted-foreground/40")} aria-hidden />
            <span className={cn(now && "text-foreground")}>
              {s}
              {now && "…"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Thinking: three dots that bounce in turn. */
function Dots() {
  return (
    <span className="flex h-6 items-center gap-1 motion-safe:animate-in motion-safe:fade-in" role="status" aria-label="Thinking">
      {[0, 1, 2].map((i) => (
        <span key={i} className="size-1.5 rounded-full bg-muted-foreground/70 motion-safe:animate-[ct-dot_1.2s_ease-in-out_infinite]" style={{ animationDelay: `${i * 0.15}s` }} />
      ))}
    </span>
  );
}
