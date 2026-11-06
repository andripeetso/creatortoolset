import { useEffect, useState } from "react";
import { Cloud, Lock, MonitorSmartphone, ScrollText, Timer } from "lucide-react";
import { isGuest, useViewedMe } from "@/lib/auth";

// -2: guests who saw the old "nothing is uploaded" intro see this one once
const KEY = "cap-guest-welcomed-2";

/**
 * One-time intro for guest sessions: the same cloud engines as an account,
 * the 3-minute and daily caps, what we keep (api/guest.ts), and what stays
 * account-only. Dismissal is remembered in localStorage.
 */
export function GuestWelcomeDialog() {
  const me = useViewedMe();
  const [open, setOpen] = useState(() => {
    try {
      return !localStorage.getItem(KEY);
    } catch {
      return false;
    }
  });

  const show = open && isGuest(me);

  function dismiss() {
    setOpen(false);
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* private mode — show again next visit */
    }
  }

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.stopPropagation();
        dismiss();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [show]);

  if (!show) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={dismiss}
    >
      <div
        className="w-[380px] max-w-[94vw] rounded-2xl border border-zinc-700 bg-[#141419] p-5 text-zinc-200 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <MonitorSmartphone className="h-4 w-4 text-violet-400" /> You're in
          guest mode
        </h2>
        <p className="mb-3 text-xs leading-5 text-zinc-400">
          You get the full Caption Studio, with the same engines as an account.
          A few things to know:
        </p>
        <ul className="mb-4 flex flex-col gap-2.5 text-xs leading-5 text-zinc-400">
          <li className="flex gap-2">
            <Cloud className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
            <span>
              <b className="text-zinc-200">Transcription and the AI caption
              pass run on our servers</b>. Your video's audio is sent there;
              the video itself stays in your browser.
            </span>
          </li>
          <li className="flex gap-2">
            <Timer className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
            <span>
              <b className="text-zinc-200">Videos up to 3 minutes</b>, with a
              daily guest allowance. Sign in for longer videos.
            </span>
          </li>
          <li className="flex gap-2">
            <ScrollText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
            <span>
              <b className="text-zinc-200">We keep the transcripts</b> (file name
              and text) to see how guest mode is used. Your project is saved
              only in this browser.
            </span>
          </li>
          <li className="flex gap-2">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
            <span>
              <b className="text-zinc-200">Account-only</b>: server-side
              exports and the other tools. Export in your browser works as a
              guest, and so do Review (videos kept 7 days) and the Audio
              Enhancer (files deleted an hour after they're done).
            </span>
          </li>
        </ul>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
            <Lock className="h-3 w-3" /> Sign in to unlock everything
          </span>
          <button
            autoFocus
            onClick={dismiss}
            className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
