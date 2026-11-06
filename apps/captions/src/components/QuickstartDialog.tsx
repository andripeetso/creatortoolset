import { useCallback, useEffect, useState } from "react";
import {
  CircleHelp,
  Download,
  FolderPlus,
  Import,
  Rocket,
  Sparkles,
  Type,
} from "lucide-react";
import { isGuest, useViewedMe } from "@/lib/auth";

/**
 * First-login quickstart for new accounts (server reports logins <= 1).
 * A short numbered tour of the Caption Studio flow; dismissal is
 * remembered per username in localStorage.
 */
export function QuickstartDialog() {
  const me = useViewedMe();
  const isNewUser = !!me && !isGuest(me) && (me.logins ?? Infinity) <= 1;
  const key = `cap-quickstart-seen:${me?.username ?? ""}`;
  const [open, setOpen] = useState(() => {
    try {
      return !localStorage.getItem(key);
    } catch {
      return false;
    }
  });

  const show = open && isNewUser;

  const dismiss = useCallback(() => {
    setOpen(false);
    try {
      localStorage.setItem(key, "1");
    } catch {
      /* private mode — show again next visit */
    }
  }, [key]);

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
  }, [show, dismiss]);

  if (!show) return null;

  const steps = [
    {
      icon: FolderPlus,
      text: (
        <>
          Open <b className="text-zinc-200">Caption Studio</b> and create a
          project — it's saved to your account automatically.
        </>
      ),
    },
    {
      icon: Import,
      text: (
        <>
          <b className="text-zinc-200">Import a video</b> — drag &amp; drop a
          file onto the import screen.
        </>
      ),
    },
    {
      icon: Sparkles,
      text: (
        <>
          Hit <b className="text-zinc-200">Transcribe</b>. If cloud models are
          enabled on your account, pick one in the engine dropdown for the best
          accuracy.
        </>
      ),
    },
    {
      icon: Type,
      text: (
        <>
          Fix words in the transcript, drag the caption box on the video, and{" "}
          <b className="text-zinc-200">style</b> the captions in the right
          panel.
        </>
      ),
    },
    {
      icon: Download,
      text: (
        <>
          <b className="text-zinc-200">Export</b> — burn captions into the
          video or download an SRT.
        </>
      ),
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={dismiss}
    >
      <div
        className="w-[400px] max-w-[94vw] rounded-2xl border border-zinc-700 bg-[#141419] p-5 text-zinc-200 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Rocket className="h-4 w-4 text-violet-400" /> Welcome, {me?.username}
          — quick start
        </h2>
        <ol className="mb-4 flex flex-col gap-2.5">
          {steps.map((s, i) => (
            <li key={i} className="flex items-start gap-2.5 text-xs leading-5 text-zinc-400">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-600/20 text-[10px] font-semibold text-violet-300">
                {i + 1}
              </span>
              <s.icon className="mt-1 h-3.5 w-3.5 shrink-0 text-zinc-500" />
              <span>{s.text}</span>
            </li>
          ))}
        </ol>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
            <CircleHelp className="h-3 w-3" /> Shortcuts &amp; tips live under
            the ? button
          </span>
          <button
            autoFocus
            onClick={dismiss}
            className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500"
          >
            Let's go
          </button>
        </div>
      </div>
    </div>
  );
}
