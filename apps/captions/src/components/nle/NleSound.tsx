import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { DUCK, lowerUnderVoice, measured, normalize, normTarget, soundKeys, speechSpans, spoken, type Duck } from "@/lib/nle/loudness";
import { find, type NleTimeline } from "@/lib/nle/model";

// Normalize Audio Levels… (a clip's menu) and Lower Under Voice… (a sound track's menu): each asks for its sources'
// sound first (nleSound.ask), which is measured on the computer that has the files (api/editor/sound.ts), then writes
// on the timeline as one edit (lib/nle/loudness.ts).

/** One source's sound as the server answers (api/editor/sound.ts SourceSound). */
export interface SourceSound {
  blocks?: string;
  words?: [number, number][];
  line?: string;
  error?: string;
}

/** How the editor asks for its sources' sound: the server's route by default; a page whose sources are not library clips sets its own. */
export const nleSound = {
  ask: async (srcs: string[]): Promise<Record<string, SourceSound>> => {
    const r = await fetch("/api/editor/sound", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sources: srcs }) });
    if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `The server said ${r.status}`);
    return (await r.json()) as Record<string, SourceSound>;
  },
};

const blocksOf = (b64: string) => {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new Float32Array(bytes.buffer);
};

/**
 * Asks until every source in `srcs` is measured (or can't be), filling `measured` and `spoken`; `onLine` says what it
 * waits for. Returns the sources that could not be measured, with why.
 */
export async function measure(srcs: string[], onLine: (l: string) => void, signal: AbortSignal): Promise<Record<string, string>> {
  const left = new Set(srcs.filter((s) => !measured.has(s)));
  const failed: Record<string, string> = {};
  while (left.size && !signal.aborted) {
    const got = await nleSound.ask([...left]);
    const lines: string[] = [];
    for (const s of [...left]) {
      const g = got[s];
      if (g?.words) spoken.set(s, g.words);
      if (g?.blocks) measured.set(s, { blocks: blocksOf(g.blocks) });
      if (g?.blocks || g?.error || !g) left.delete(s);
      if (g?.error || !g) failed[s] = g?.error ?? "Not found";
      if (g?.line) lines.push(g.line);
    }
    if (!left.size) break;
    onLine(lines[0] ?? "Measuring the sound");
    await new Promise((r) => setTimeout(r, 2000));
  }
  return failed;
}

/** Runs `go` once the sources are measured; the dialog's line and its Cancel. */
function useMeasure() {
  const [line, setLine] = useState<string | null>(null);
  const ac = useRef<AbortController | null>(null);
  useEffect(() => () => ac.current?.abort(), []);
  const run = async (srcs: string[], go: (failed: Record<string, string>) => void) => {
    ac.current?.abort();
    const a = (ac.current = new AbortController());
    setLine("Measuring the sound");
    try {
      const failed = await measure(srcs, setLine, a.signal);
      if (!a.signal.aborted) go(failed);
    } catch (e) {
      if (!a.signal.aborted) setLine((e as Error).message);
      return;
    }
    setLine(null);
  };
  return { line, run, busy: line !== null };
}

const num = (v: string, d: number) => (Number.isFinite(Number.parseFloat(v)) ? Number.parseFloat(v) : d);

/** Normalize Audio Levels: a target by the first clip's track, Independent or Relative. */
export function NormalizeDialog({ tl, keys, onCommit, onClose }: { tl: NleTimeline; keys: string[]; onCommit: (tl: NleTimeline) => void; onClose: () => void }) {
  const ks = soundKeys(tl, keys);
  const first = ks[0] ? find(tl, ks[0])?.track : undefined;
  const [target, setTarget] = useState(String(normTarget(first ?? "")));
  const [mode, setMode] = useState<"independent" | "relative">("independent");
  const [note, setNote] = useState<string | null>(null);
  const now = useRef(tl);
  now.current = tl;
  const m = useMeasure();
  const go = () =>
    m.run([...new Set(ks.map((k) => find(tl, k)!.item.src))], (failed) => {
      const next = normalize(now.current, ks, num(target, normTarget(first ?? "")), mode === "relative");
      const n = Object.keys(failed).length;
      if (next !== now.current) onCommit(next);
      if (n) setNote(`${n} clip${n === 1 ? "" : "s"} could not be measured: ${Object.values(failed)[0]}`);
      else onClose();
    });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Normalize Audio Levels</DialogTitle></DialogHeader>
        <div className="grid gap-4 text-sm">
          <div className="grid gap-1.5">
            <Label htmlFor="nle-norm-target">Target loudness (LUFS)</Label>
            <Input id="nle-norm-target" type="number" step="0.5" value={target} onChange={(e) => setTarget(e.target.value)} />
          </div>
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as typeof mode)} aria-label="Set level">
            <Label className="flex items-center gap-2 font-normal"><RadioGroupItem value="independent" />Independent: each clip to the target</Label>
            <Label className="flex items-center gap-2 font-normal"><RadioGroupItem value="relative" />Relative: the clips together, kept level with each other</Label>
          </RadioGroup>
          {(m.line || note) && <p className="text-muted-foreground">{m.line ?? note}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={go} disabled={m.busy || !ks.length}>Normalize</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Lower Under Voice: the track's clips come down where A1 speaks, as volume keys. */
export function LowerUnderVoiceDialog({ tl, track, onCommit, onClose }: { tl: NleTimeline; track: string; onCommit: (tl: NleTimeline) => void; onClose: () => void }) {
  const [d, setD] = useState({ amount: String(DUCK.amount), attack: String(DUCK.attackMs), release: String(DUCK.releaseMs) });
  const [note, setNote] = useState<string | null>(null);
  const now = useRef(tl);
  now.current = tl;
  const m = useMeasure();
  const voice = [...new Set((tl.tracks.A1?.items ?? []).map((i) => i.src))];
  const go = () =>
    m.run(voice, () => {
      const spans = speechSpans(now.current);
      if (!spans.length) return setNote("No speech found on A1");
      const duck: Duck = { amount: -Math.abs(num(d.amount, DUCK.amount)), attackMs: Math.max(0, num(d.attack, DUCK.attackMs)), releaseMs: Math.max(0, num(d.release, DUCK.releaseMs)) };
      onCommit(lowerUnderVoice(now.current, track, spans, duck));
      onClose();
    });
  const field = (k: keyof typeof d, label: string, step: string) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`nle-duck-${k}`}>{label}</Label>
      <Input id={`nle-duck-${k}`} type="number" step={step} value={d[k]} onChange={(e) => setD({ ...d, [k]: e.target.value })} />
    </div>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Lower Under Voice</DialogTitle></DialogHeader>
        <div className="grid grid-cols-3 gap-3 text-sm">
          {field("amount", "Amount (dB)", "1")}
          {field("attack", "Attack (ms)", "10")}
          {field("release", "Release (ms)", "10")}
        </div>
        {(m.line || note) && <p className="text-sm text-muted-foreground">{m.line ?? note}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={go} disabled={m.busy || !voice.length || !tl.tracks[track]?.items.length}>Lower</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
