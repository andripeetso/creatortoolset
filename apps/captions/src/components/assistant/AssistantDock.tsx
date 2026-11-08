import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ArrowUpRight, KeyRound, MessageCircle, PanelRight, PanelRightClose, Volume2, VolumeX, X } from "lucide-react";
import type { AssistantMessage, AssistantView } from "@contracts/assistant";
import { ReplyText } from "@/components/ReplyText";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMe } from "@/lib/auth";
import {
  cancelSecret,
  getAssistant,
  keySaved,
  navigated,
  openAssistant,
  saveKey,
  sendTurn,
  useAssistant,
} from "@/lib/assistant";
import { cornerOf, storePlace, storedPlace, type Corner, type Place } from "@/lib/dock-place";
import { canSpeak, speak, stopSpeaking, unlockAudio, useReadAloud } from "@/lib/read-aloud";
import { cn } from "@/lib/utils";
import { currentProject, PROJECT_COLORS, projectColor, useWorkspace } from "@/lib/workspace";
import { useAppearance } from "@/lib/settings";
import { Composer } from "./Composer";
import { useThrow } from "./useThrow";

/** Width of the chat docked to the right edge; the page moves over by as much. */
const DOCK_W = 400;
/** Below the pages' top bars, above the corner buttons bottom left. */
const AT: Record<Corner, string> = { tl: "left-4 top-16", tr: "right-4 top-16", bl: "left-4 bottom-14", br: "right-4 bottom-4" };
const ORIGIN: Record<Corner, string> = { tl: "origin-top-left", tr: "origin-top-right", bl: "origin-bottom-left", br: "origin-bottom-right" };

/** A few things to ask, for the page you're on; a tap sends it. */
function suggestionsFor(path: string): string[] {
  if (path.startsWith("/workshop")) return ["Tighten the piece I'm on", "Give me three other hooks", "What should I make next?"];
  if (path.startsWith("/review")) return ["What's new in Review?", "Sum up the comments on my latest video", "Which versions are approved?"];
  if (path.startsWith("/editor")) return ["How are my edits doing?", "What changed in the last draft?"];
  if (path.startsWith("/instagram") || path.startsWith("/analyzer")) return ["How did my last five posts do?", "Refresh my Instagram numbers"];
  return ["What's waiting for me today?", "What can you do for me here?", "Open the Workshop"];
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
  const { collapsed, setupAsked, set } = useAssistant();
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

  useEffect(() => {
    if (!real) return;
    void load();
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
  const project = useWorkspace(currentProject);
  const { projectTint } = useAppearance();
  const tint = { "--tint": `rgb(${PROJECT_COLORS[projectTint && project ? projectColor(project) : "violet"].rgb})` } as React.CSSProperties;

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

  const send = async (text: string) => {
    stopSpeaking();
    unlockAudio();
    setBusy(true);
    setError(null);
    const r = await sendTurn(text);
    setBusy(false);
    if (r.ok) setView(r.data);
    else {
      setError(r.error);
      if (r.code === "NO_PROVIDER") void load();
    }
  };

  const pick = (how: "self" | "chat") => {
    set({ setupAsked: false });
    if (how === "self") navigate("/?setup=how");
    else void send("Set me up. Go one step at a time.");
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
    >
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
        {canSpeak() && (
          <button
            type="button"
            onClick={readAloud.toggle}
            className={cn(headBtn, readAloud.on && "text-[var(--tint)] hover:brightness-110", readAloud.speaking && "motion-safe:animate-pulse")}
            aria-pressed={readAloud.on}
            aria-label="Read replies aloud"
            title={readAloud.on ? "Reading replies aloud. Click to turn off." : "Read replies aloud (a natural voice that runs on this computer; downloads once, about 90 MB)"}
          >
            {readAloud.on ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
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

      {readAloud.loading !== null && (
        <p className="mx-4 mb-1 flex shrink-0 items-center gap-2 text-xs text-muted-foreground motion-safe:animate-in motion-safe:fade-in" aria-live="polite">
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full bg-[var(--tint)] transition-[width] duration-300" style={{ width: `${Math.round(readAloud.loading * 100)}%` }} />
          </span>
          Getting the voice ready
        </p>
      )}

      <div className="relative min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-3 text-sm">
        {!view && <Dots />}

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

        {empty && (
          <div className="flex h-full flex-col justify-end gap-2 pb-1">
            {suggestionsFor(pathname).map((s, i) => (
              <button
                key={`${pathname}-${s}`}
                type="button"
                disabled={busy}
                onClick={() => void send(s)}
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

        {chatting && !empty && (
          <div className="flex flex-col gap-3">
            {view.messages.map((m) => (
              <Message key={m.id} m={m} />
            ))}
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
          <Composer onSend={(t) => void send(t)} waiting={busy || thinking} autoFocus />
        </div>
      )}
    </section>
  );
}

function Message({ m }: { m: AssistantMessage }) {
  const enter = "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300";
  if (m.role === "note") return <p className={cn("mx-auto max-w-[90%] text-center text-xs text-muted-foreground", enter)}>{m.text}</p>;
  if (m.role === "user")
    return (
      <div
        className={cn(
          "ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-[var(--tint)] px-3.5 py-2 whitespace-pre-wrap text-white",
          enter,
          "motion-safe:slide-in-from-bottom-2 motion-safe:zoom-in-95 motion-safe:origin-bottom-right",
        )}
      >
        {m.text}
      </div>
    );
  const steps = m.steps ?? [];
  const working = m.status === "thinking";
  if (working && !m.text)
    return (
      <div className="space-y-1">
        <Steps steps={steps} working />
        <Dots />
      </div>
    );
  if (m.status === "error" && !m.text) return <p className={cn("text-destructive", enter)}>That didn&apos;t work. Try again.</p>;
  return (
    <div className={cn("max-w-[94%] leading-relaxed", enter, "motion-safe:slide-in-from-bottom-1")}>
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
      <ReplyText text={m.text} />
      {m.status === "thinking" && <span className="ml-0.5 inline-block h-3.5 w-1.5 rounded-sm bg-[var(--tint)] align-middle motion-safe:animate-pulse" aria-hidden />}
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
