import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { find, framesOfTimecode, longestOf, setDuration, timecode, type NleTimeline } from "@/lib/nle/model";

/** Change Clip Duration: the picked clips' new length from where each starts (its end trimmed, nothing after it moves). */
export function DurationDialog({ tl, keys, onCommit, onClose }: { tl: NleTimeline; keys: string[]; onCommit: (tl: NleTimeline) => void; onClose: () => void }) {
  const fps = tl.timeline.fps;
  const [text, setText] = useState(timecode(find(tl, keys[0])?.item.len ?? 0, fps));
  const len = framesOfTimecode(text, fps);
  // the shortest source decides: a clip at 200 % uses two source frames for each frame it plays
  const most = Math.min(...keys.map((k) => { const h = find(tl, k); return h ? longestOf(tl, h.item) : Infinity; }));
  const why = len === null || len < 1 ? "A length in frames or as a timecode" : len > most ? `Longer than the source: ${timecode(most, fps)} at most` : null;
  const go = () => {
    if (why) return;
    onCommit(setDuration(tl, keys, len!));
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle>Change Clip Duration</DialogTitle>
          <DialogDescription>Trims each clip’s end, up to the next clip.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-1.5 text-sm" onSubmit={(e) => { e.preventDefault(); go(); }}>
          <Label htmlFor="nle-duration">Duration</Label>
          <Input id="nle-duration" autoFocus value={text} onChange={(e) => setText(e.target.value)} aria-invalid={!!why} />
          <p className={why ? "text-destructive" : "text-muted-foreground"}>{why ?? `${len} frames at ${fps} fps`}</p>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={go} disabled={!!why}>Change</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
