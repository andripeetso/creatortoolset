import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { LIBRARY_SETUP_DONE, LIBRARY_WORDS, type ActionNeeded } from "@contracts/library";
import { Button } from "@/components/ui/button";

/**
 * The card under a reply whose tool needs the person first (ActionNeeded, contracts/library.ts): the Media Library's
 * setup (its owner sets it up on the page; a member gets no button) or the Downloads switch. The ask it stopped on
 * goes on by itself, once: when the library of its workspace is set up (LIBRARY_SETUP_DONE), or after Turn on.
 */
/** Whether a LIBRARY_SETUP_DONE for `workspace` is the one a setup card waits on. */
export const resumesOn = (action: ActionNeeded, workspace: string): boolean => action.kind === "setup" && action.workspace === workspace;

export function ActionCard({ action, ask, onContinue }: { action?: ActionNeeded; ask?: string; onContinue?: (text: string) => void }) {
  const navigate = useNavigate();
  const [turned, setTurned] = useState<"busy" | "on" | "failed" | null>(null);
  const continued = useRef(false);

  useEffect(() => {
    if (action?.kind !== "setup" || !ask) return;
    const onDone = (e: Event) => {
      if (!resumesOn(action, (e as CustomEvent<{ workspace?: string }>).detail?.workspace ?? "")) return;
      if (!continued.current) onContinue?.(ask);
      continued.current = true;
    };
    window.addEventListener(LIBRARY_SETUP_DONE, onDone);
    return () => window.removeEventListener(LIBRARY_SETUP_DONE, onDone);
  }, [action, ask, onContinue]);

  if (!action) return null;

  if (action.kind === "setup") {
    return (
      <div className="my-1.5 flex flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-sm">
        <p>{action.owner ? LIBRARY_WORDS.setupCard(action.workspaceName) : LIBRARY_WORDS.setupCardMember}</p>
        {action.owner && (
          <Button size="sm" onClick={() => navigate(action.href)}>
            {LIBRARY_WORDS.setupButton}
          </Button>
        )}
      </div>
    );
  }

  const turnOn = async () => {
    setTurned("busy");
    const r = await fetch("/api/library/offline/downloads", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ libraryId: action.libraryId, mode: "needed" }),
    }).catch(() => null);
    if (!r?.ok) return setTurned("failed");
    setTurned("on");
    if (ask && !continued.current) {
      continued.current = true;
      onContinue?.(LIBRARY_WORDS.downloadsDone(ask));
    }
  };

  // once it is on, the chat has gone on with the ask: the card has nothing left to say
  if (turned === "on") return null;
  return (
    <div className="my-1.5 flex flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-sm">
      <p>{LIBRARY_WORDS.downloadsCard}</p>
      <Button size="sm" disabled={turned === "busy"} onClick={() => void turnOn()}>
        {LIBRARY_WORDS.downloadsButton}
      </Button>
      {turned === "failed" && <p className="text-xs text-destructive">Could not turn it on. Try again.</p>}
    </div>
  );
}
