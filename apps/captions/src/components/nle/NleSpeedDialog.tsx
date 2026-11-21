import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { find, setSpeed, type NleTimeline } from "@/lib/nle/model";

/** Change Clip Speed… (a clip's menu): the picked clips' speed in %, as the Inspector's Speed Change sets it. */
export function SpeedDialog({ tl, keys, onCommit, onClose }: { tl: NleTimeline; keys: string[]; onCommit: (tl: NleTimeline) => void; onClose: () => void }) {
  const [pct, setPct] = useState(String(Math.round((find(tl, keys[0])?.item.speed ?? 1) * 10000) / 100));
  const n = Number(pct);
  const ok = pct.trim() !== "" && Number.isFinite(n) && n >= 10 && n <= 1600;
  const go = () => {
    if (!ok) return;
    onCommit(setSpeed(tl, keys, n / 100));
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xs">
        <DialogHeader><DialogTitle>Change Clip Speed</DialogTitle></DialogHeader>
        <form className="grid gap-1.5 text-sm" onSubmit={(e) => { e.preventDefault(); go(); }}>
          <Label htmlFor="nle-speed">Speed (%)</Label>
          <Input id="nle-speed" type="number" step="1" min={10} max={1600} autoFocus value={pct} onChange={(e) => setPct(e.target.value)} />
          <p className="text-muted-foreground">10 to 1600. 200 plays twice as fast, 50 half as fast.</p>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={go} disabled={!ok}>Change</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
