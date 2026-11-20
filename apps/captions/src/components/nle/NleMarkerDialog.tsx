import { useState } from "react";
import { MARKER_COLORS, type EdjMarker, type MarkerColor } from "@contracts/editor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { timecode } from "@/lib/nle/model";
import { cn } from "@/lib/utils";

/** How Resolve draws each marker colour. */
export const MARKER_HEX: Record<MarkerColor, string> = {
  Red: "#e2463d", Yellow: "#e8c43c", Green: "#4fb05c", Cyan: "#3ec1d3", Blue: "#3d7be0", Purple: "#8f4fd6", Pink: "#e25aa5", Lavender: "#b49ae8",
};

const field = "w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[13px] text-zinc-100 outline-none focus:border-zinc-500";

/** A marker's name, colour, note and duration (M on a marker, or a double click on it). */
export function NleMarkerDialog({ marker, fps, onDone, onDelete, onClose }: {
  marker: EdjMarker;
  fps: number;
  onDone: (patch: Partial<EdjMarker>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(marker.name ?? "");
  const [color, setColor] = useState<MarkerColor>(marker.color in MARKER_HEX ? marker.color : "Blue");
  const [note, setNote] = useState(marker.note ?? "");
  const [dur, setDur] = useState(String(marker.dur ?? 1));
  const done = () => onDone({ name, color, note, dur: Math.max(1, Math.round(Number(dur) || 1)) });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogTitle>Marker</DialogTitle>
        <DialogDescription className="font-mono tabular-nums">{timecode(marker.frame, fps)}</DialogDescription>
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); done(); }}>
          <label className="grid gap-1 text-[12px] text-zinc-400">Name
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={field} />
          </label>
          <div role="radiogroup" aria-label="Colour" className="flex gap-1.5">
            {(Object.keys(MARKER_COLORS) as MarkerColor[]).map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} title={c} onClick={() => setColor(c)}
                className={cn("size-6 rounded-full border-2", color === c ? "border-white" : "border-transparent")} style={{ background: MARKER_HEX[c] }} />
            ))}
          </div>
          <label className="grid gap-1 text-[12px] text-zinc-400">Note
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className={field} />
          </label>
          <label className="grid gap-1 text-[12px] text-zinc-400">Duration in frames
            <input type="number" min={1} step={1} value={dur} onChange={(e) => setDur(e.target.value)} className={cn(field, "w-28")} />
          </label>
          <DialogFooter className="sm:justify-between">
            <Button type="button" variant="ghost" onClick={onDelete}>Delete</Button>
            <Button type="submit">Done</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
