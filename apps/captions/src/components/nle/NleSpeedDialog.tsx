import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { find, setSpeed, type NleTimeline } from "@/lib/nle/model";

/** Change Clip Speed… (a clip's menu): the picked clips' speed in % (a right-click picks the linked voice too, so they stay together). */
export function SpeedDialog({ tl, keys, onCommit, onClose }: { tl: NleTimeline; keys: string[]; onCommit: (tl: NleTimeline) => void; onClose: () => void }) {
  return <SpeedBox speed={find(tl, keys[0])?.item.speed ?? 1} min={10} max={1600} hint="10 to 1600. 200 plays twice as fast, 50 half as fast."
    onPick={(s) => onCommit(setSpeed(tl, keys, s))} onClose={onClose} />;
}

/** The box itself, for the editor and Review: a speed in % between `min` and `max`, picked as a rate (1.5 = 150 %). */
export function SpeedBox({ speed, min, max, hint, onPick, onClose }: { speed: number; min: number; max: number; hint: string; onPick: (speed: number) => void; onClose: () => void }) {
  const [pct, setPct] = useState(String(Math.round(speed * 10000) / 100));
  const n = Number(pct);
  const ok = pct.trim() !== "" && Number.isFinite(n) && n >= min && n <= max;
  const go = () => {
    if (!ok) return;
    onPick(n / 100);
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xs">
        <DialogHeader><DialogTitle>Change Clip Speed</DialogTitle></DialogHeader>
        <form className="grid gap-1.5 text-sm" onSubmit={(e) => { e.preventDefault(); go(); }}>
          <Label htmlFor="nle-speed">Speed (%)</Label>
          <Input id="nle-speed" type="number" step="any" min={min} max={max} autoFocus value={pct} onChange={(e) => setPct(e.target.value)} />
          <p className="text-muted-foreground">{hint}</p>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={go} disabled={!ok}>Change</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
