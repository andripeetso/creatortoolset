import { useState } from "react";
import { Download, X } from "lucide-react";
import { useMacRelease } from "@/components/MacAppDownload";
import { UpdateButton } from "@/components/NewVersionPill";
import { useAccountInCorner } from "@/components/UserMenu";

/**
 * Bottom left on every page: Update after a deploy, and on a Mac browser a one-time card offering the Mac app. The
 * account menu is top right, beside the project switcher.
 */
export function CornerNav() {
  const shown = useAccountInCorner();
  const release = useMacRelease();
  if (!shown) return null;
  const inMacApp = document.documentElement.classList.contains("mac-app");
  return (
    <>
      {release && !inMacApp && <MacAppPrompt version={release.version} />}
      <nav
        aria-label="Your settings"
        className="fixed bottom-2 left-2 z-40 flex items-center gap-2"
      >
        <UpdateButton />
      </nav>
    </>
  );
}

const PROMPT_SEEN = "macapp.prompt";
/** a Mac, not an iPad (iPadOS says "Macintosh" too, with a touch screen) */
const onMac = () =>
  /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints === 0;

/**
 * Once per browser, on a Mac:
 * Download or Not now both put it away for good; the account menu keeps "Get the Mac app".
 */
function MacAppPrompt({ version }: { version: string }) {
  const [open, setOpen] = useState(
    () => onMac() && !localStorage.getItem(PROMPT_SEEN),
  );
  if (!open) return null;
  const close = () => {
    localStorage.setItem(PROMPT_SEEN, "1");
    setOpen(false);
  };
  return (
    <div
      role="dialog"
      aria-label="Creator Toolset for Mac"
      className="fixed bottom-11 left-2 z-40 w-72 rounded-xl border border-zinc-500/25 bg-zinc-900 p-3 text-zinc-100 shadow-xl"
    >
      <button
        type="button"
        onClick={close}
        aria-label="Close"
        className="absolute right-2 top-2 rounded p-0.5 text-zinc-500 hover:text-zinc-200"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <p className="text-[13px] font-medium">Creator Toolset for Mac</p>
      <p className="mt-1 text-[12px] leading-snug text-zinc-400">
        The site in its own window, with notifications, and your AI running on
        your own Mac.
      </p>
      <div className="mt-2.5 flex items-center gap-2">
        <a
          href="/api/mac-app/download"
          onClick={close}
          className="flex items-center gap-1.5 rounded-md bg-violet-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-violet-500"
        >
          <Download className="h-3.5 w-3.5" /> Download
        </a>
        <button
          type="button"
          onClick={close}
          className="rounded-md px-2 py-1 text-[12px] text-zinc-400 hover:text-zinc-200"
        >
          Not now
        </button>
        <span className="ml-auto text-[10px] text-zinc-500">{version}</span>
      </div>
    </div>
  );
}
