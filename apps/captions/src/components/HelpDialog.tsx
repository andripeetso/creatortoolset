import { useEffect } from "react";
import {
  CircleHelp,
  Clapperboard,
  Clock,
  FileText,
  MousePointer2,
  X,
} from "lucide-react";

const isMac =
  typeof navigator !== "undefined" && /Mac|iP/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl";

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-zinc-700 bg-zinc-800/80 px-1.5 font-sans text-[10px] font-medium text-zinc-300">
      {children}
    </kbd>
  );
}

function Row({ keys, children }: { keys: React.ReactNode[]; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-xs text-zinc-400">{children}</span>
      <span className="flex shrink-0 items-center gap-1">
        {keys.map((k, i) => (
          <Key key={i}>{k}</Key>
        ))}
      </span>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {icon} {title}
      </h3>
      <div className="divide-y divide-zinc-800/60">{children}</div>
    </section>
  );
}

export function HelpDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    // capture so Escape closes the dialog instead of deselecting things behind it
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[88vh] w-[620px] max-w-[94vw] overflow-y-auto rounded-2xl border border-zinc-700 bg-[#141419] p-5 text-zinc-200 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <CircleHelp className="h-4 w-4 text-violet-400" /> Shortcuts &amp; tips
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
          <Section icon={<Clapperboard className="h-3 w-3" />} title="Playback">
            <Row keys={["Space"]}>Play / pause</Row>
            <Row keys={["←", "→"]}>One frame back / forward</Row>
            <Row keys={["⇧ ←", "⇧ →"]}>One second back / forward</Row>
            <Row keys={["J", "K", "L"]}>Rewind / stop / fast-forward (again: 4×, 8×)</Row>
            <Row keys={[`${mod} Z`]}>Undo</Row>
            <Row keys={[`${mod} ⇧ Z`]}>Redo</Row>
          </Section>

          <Section icon={<MousePointer2 className="h-3 w-3" />} title="Captions on video">
            <Row keys={["Click"]}>Select the caption box — drag to move, handles resize</Row>
            <Row keys={["←", "↑", "↓", "→"]}>Nudge the selected box</Row>
            <Row keys={["⇧", "Arrows"]}>Nudge in bigger steps</Row>
            <Row keys={["Esc"]}>Deselect box / text, timeline section and range</Row>
          </Section>

          <Section icon={<FileText className="h-3 w-3" />} title="Transcript">
            <Row keys={["Click"]}>Select a word — the video jumps to it</Row>
            <Row keys={["C"]}>Re-spell the selected word (or double-click it)</Row>
            <Row keys={["⌫"]}>Delete the word before the cursor</Row>
            <Row keys={["⏎"]}>Split the caption at the cursor</Row>
            <Row keys={["⌫", "at line start"]}>Merge with the caption above</Row>
            <Row keys={["Esc"]}>Leave the editor</Row>
          </Section>

          <Section icon={<Clock className="h-3 w-3" />} title="Timeline">
            <Row keys={["Drag edge"]}>Retime a caption's in / out point</Row>
            <Row keys={["Drag middle"]}>Move a caption-position or text clip</Row>
            <Row keys={["↑", "↓"]}>Previous / next caption (a picked clip: its layers)</Row>
            <Row keys={["⌥ scroll", "Pinch"]}>Zoom about the playhead</Row>
            <Row keys={["=", "-", "\\"]}>Zoom in / out / fit</Row>
            <Row keys={[`${mod} scroll`]}>Scroll sideways</Row>
            <Row keys={["⌫"]}>Delete the selected clip</Row>
            <Row keys={["Double-click"]}>Edit a text overlay in place</Row>
          </Section>
        </div>

        <div className="mt-5 space-y-1.5 border-t border-zinc-800 pt-3 text-[11px] leading-4 text-zinc-500">
          <p>
            In the transcript, words act as single letters so timings stay glued to the
            audio — punctuation and spaces edit freely. Use <Key>C</Key> to fix a
            spelling, or the <span className="text-zinc-400">Edit text</span> button for
            free-form editing.
          </p>
          <p>
            Press <Key>?</Key> anytime to reopen this guide.
          </p>
        </div>
      </div>
    </div>
  );
}
