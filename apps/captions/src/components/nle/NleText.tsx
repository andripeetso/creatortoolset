import { useEffect, useRef, useState } from "react";
import type { Design, TextLayer } from "@contracts/design";
import { TextSection } from "@/components/design/Inspector";
import { getDesign, saveDesign } from "@/lib/designs";
import type { NleSource } from "@/lib/nle/model";
import { drawFrame } from "@/lib/nle/text-design";

const SAVE_MS = 500;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A text clip in the Inspector: Design's own text panel on its frame's first text layer. Each change is saved to the
 * design and the frame drawn again (a new PNG, so older drafts keep theirs), a moment after the last one; `onDrawn`
 * gets the source that plays it. `reread` changes when the design was changed elsewhere (Open in Design).
 */
export function NleText({ source, scale, reread, onDrawn, onOpen }: { source: NleSource; scale: number; reread: number; onDrawn: (s: NleSource) => void; onOpen: () => void }) {
  const id = String(source.design);
  const [design, setDesign] = useState<Design | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    let on = true;
    setError(null);
    getDesign(id).then((d) => on && setDesign(d), (e) => on && setError(message(e)));
    return () => void (on = false);
  }, [id, reread]);
  // a change still waiting is saved when the clip is let go
  useEffect(() => () => (clearTimeout(timer.current), pending.current?.()), []);

  const page = design?.pages.find((p) => p.id === source.frame);
  const layer = page?.layers.find((l): l is TextLayer => l.type === "text");
  const change = (next: TextLayer) => {
    if (!design || !page) return;
    const d = { ...design, pages: design.pages.map((p) => (p.id === page.id ? { ...p, layers: p.layers.map((l) => (l.id === next.id ? next : l)) } : p)) };
    setDesign(d);
    clearTimeout(timer.current);
    const done = onDrawn;
    pending.current = () => {
      pending.current = null;
      void saveDesign(d.id, { pages: d.pages }).then((saved) => drawFrame(saved, page.id, scale)).then(done, (e) => setError(message(e)));
    };
    timer.current = setTimeout(() => pending.current?.(), SAVE_MS);
  };

  return (
    <div className="border-b border-black/60 pb-2">
      <div className="flex items-center justify-between px-3 pt-2 pb-1 text-[11px] text-zinc-400">
        <span>Text</span>
        <button type="button" onClick={onOpen} className="rounded px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50">Open in Design</button>
      </div>
      {error && <p className="px-3 pb-1 text-[11px] text-red-300">{error}</p>}
      {layer && design ? <TextSection layer={layer} design={design} onChange={change} />
        : !error && <p className="px-3 pb-1 text-[11px] text-zinc-500">{design ? "No words in this frame: open it in Design" : "Opening the text"}</p>}
    </div>
  );
}
