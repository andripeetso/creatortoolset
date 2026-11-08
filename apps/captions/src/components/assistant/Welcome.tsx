import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantNotice } from "@/lib/assistant";
import type { Corner } from "@/lib/dock-place";
import { cn } from "@/lib/utils";

/**
 * The assistant's first hello (after setup), the "I'm here if you need me" pill that follows it, and the notice line a
 * tool can show. All client text: nothing here is stored on the server or sent to the AI.
 */

export const WELCOME_CONNECTED = "Hey, I'm your assistant. If you ever need anything, I'm here. Send me a message, drop a video, whatever.";
export const WELCOME_NOT_CONNECTED = "Hey, I'm your assistant. I can't help yet, because I need your AI connected first. It only takes a moment.";
export const PILL_TEXT = "I'm here if you need me";
/** Typing speed of the welcome, per character (ms). */
export const TYPE_MS = 22;
/** The pill's timing (ms): wait after the close, enter, show, leave. */
export const PILL = { wait: 400, enter: 250, show: 4000, leave: 400 } as const;

export type WelcomeStage = "idle" | "typing" | "ready" | "ended";
export type WelcomeEvent = "start" | "typed" | "away" | "sent" | "closed";

/**
 * The welcome's stages. It starts (typing) the first time the dock opens after setup. It is ready once the typing
 * is done: from then on a press outside closes the dock ("away"). A press before that does nothing. A sent message
 * or a close ends it for good.
 */
export function welcomeStep(stage: WelcomeStage, ev: WelcomeEvent): WelcomeStage {
  if (stage === "idle") return ev === "start" ? "typing" : stage;
  if (stage === "typing") return ev === "typed" ? "ready" : ev === "sent" || ev === "closed" ? "ended" : stage;
  if (stage === "ready") return ev === "away" || ev === "sent" || ev === "closed" ? "ended" : stage;
  return stage;
}

/** The pill follows a close or a press outside, once per browser (never after a sent message). */
export const pillAfter = (ev: WelcomeEvent, shownBefore: boolean): boolean => !shownBefore && (ev === "closed" || ev === "away");

const WELCOMED = (user: string) => `ct-assistant-welcomed:${user}`;
const PILL_KEY = "ct-assistant-pill-shown";
/** Flags also kept for this page load, for when browser storage is blocked. */
const seenThisLoad = new Set<string>();

function flag(key: string): boolean {
  if (seenThisLoad.has(key)) return true;
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function setFlag(key: string): void {
  seenThisLoad.add(key);
  try {
    localStorage.setItem(key, "1");
  } catch {
    /* blocked: the flag lasts this page load */
  }
}

/**
 * The welcome as the dock shows it: typed out one character at a time, and where the session stands. `shown` is what
 * is typed so far; `pillDue` says the pill should appear now (it is cleared by pillDone, or when the dock opens).
 */
export function useWelcome({ open, eligible, connected, user }: { open: boolean; eligible: boolean; connected: boolean; user: string }) {
  const [stage, setStage] = useState<WelcomeStage>("idle");
  const stageRef = useRef<WelcomeStage>("idle");
  const [full, setFull] = useState("");
  const [n, setN] = useState(0);
  const [pillDue, setPillDue] = useState(false);

  const move = useCallback((ev: WelcomeEvent) => {
    const next = welcomeStep(stageRef.current, ev);
    if (next === stageRef.current) return;
    if (pillAfter(ev, flag(PILL_KEY))) setPillDue(true);
    stageRef.current = next;
    setStage(next);
  }, []);

  // starts once per browser: the first time the dock opens after setup, with nothing said yet
  useEffect(() => {
    if (!open || !eligible || stageRef.current !== "idle" || flag(WELCOMED(user))) return;
    setFlag(WELCOMED(user));
    setFull(connected ? WELCOME_CONNECTED : WELCOME_NOT_CONNECTED);
    setN(0);
    move("start");
  }, [open, eligible, connected, user, move]);

  const typing = stage === "typing";
  useEffect(() => {
    if (!typing) return;
    if (n >= full.length) {
      move("typed");
      return;
    }
    const t = window.setTimeout(() => setN((c) => c + 1), TYPE_MS);
    return () => window.clearTimeout(t);
  }, [typing, n, full, move]);

  // opening the dock again (the pill's click, or the bubble) takes the pill away
  useEffect(() => {
    if (open) setPillDue(false);
  }, [open]);

  const end = useCallback((ev: "sent" | "closed" | "away") => move(ev), [move]);
  return {
    stage,
    shown: full.slice(0, n),
    showing: stage === "typing" || stage === "ready",
    /** the dock closed or was pressed outside after the welcome: the pill follows */
    pillDue,
    pillDone: () => setPillDue(false),
    end,
  };
}

/** The welcome line, as one assistant message; a caret while it types. */
export function WelcomeLine({ text, typing }: { text: string; typing: boolean }) {
  return (
    <div className="max-w-[94%] leading-relaxed motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
      {text}
      {typing && <span className="ml-0.5 inline-block h-3.5 w-1.5 rounded-sm bg-[var(--tint)] align-middle motion-safe:animate-pulse" aria-hidden />}
    </div>
  );
}

/** A notice a tool put in the chat: its text, and a chip that sends its words when clicked (only when an AI answers). */
export function NoticeLine({ notice, onChip }: { notice: AssistantNotice; onChip?: (send: string) => void }) {
  const chip = notice.chip;
  return (
    <div className="flex max-w-[94%] flex-col items-start gap-2 leading-relaxed motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
      <p>{notice.text}</p>
      {chip && onChip && (
        <button
          type="button"
          onClick={() => onChip(chip.send)}
          className="rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:border-[color-mix(in_srgb,var(--tint)_50%,transparent)] hover:text-[var(--tint)]"
        >
          {chip.label}
        </button>
      )}
    </div>
  );
}

/** Beside the collapsed bubble, on the page's side of its corner. */
const PILL_AT: Record<Corner, string> = {
  tl: "left-[5.25rem] top-16",
  tr: "right-[5.25rem] top-16",
  bl: "left-[5.25rem] bottom-14",
  br: "right-[5.25rem] bottom-4",
};

type PillPhase = "wait" | "in" | "shown" | "out";

/**
 * The pill, once: waits, slides in toward the bubble, shows, fades out, then `onDone` takes it away. A click opens the
 * dock (`onOpen`). Reduced motion: it only fades.
 */
export function WelcomePill({ corner, onOpen, onDone }: { corner: Corner; onOpen: () => void; onDone: () => void }) {
  const [phase, setPhase] = useState<PillPhase>("wait");
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  });
  useEffect(() => {
    const t = [
      window.setTimeout(() => {
        setFlag(PILL_KEY);
        setPhase("in");
      }, PILL.wait),
      window.setTimeout(() => setPhase("shown"), PILL.wait + PILL.enter),
      window.setTimeout(() => setPhase("out"), PILL.wait + PILL.enter + PILL.show),
      window.setTimeout(() => doneRef.current(), PILL.wait + PILL.enter + PILL.show + PILL.leave),
    ];
    return () => t.forEach((id) => window.clearTimeout(id));
  }, []);

  const up = phase === "in" || phase === "shown";
  // starts 8 px further from the bubble and slides toward it
  const away = corner.endsWith("r") ? "-translate-x-2" : "translate-x-2";
  return (
    <div role="status" aria-live="polite" className={cn("fixed z-40", PILL_AT[corner])}>
      <button
        type="button"
        onClick={onOpen}
        tabIndex={up ? 0 : -1}
        className={cn(
          "rounded-full border bg-popover px-4 py-2 text-sm whitespace-nowrap text-popover-foreground shadow-md transition-[opacity,transform] ease-out motion-reduce:translate-none",
          up ? "pointer-events-auto translate-x-0 opacity-100 duration-[250ms]" : phase === "out" ? "pointer-events-none opacity-0 duration-[400ms]" : cn("pointer-events-none opacity-0 duration-0", away),
        )}
      >
        {PILL_TEXT}
      </button>
    </div>
  );
}
