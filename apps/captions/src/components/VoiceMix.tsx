import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AudioLines, Loader2 } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import type { StemSet } from "@/lib/review";

/** The version's sound parts on the video's clock (Web Audio): each part a
 *  buffer through its own gain, restarted at the video's time on play, seek,
 *  a stall or a speed change, and when it drifts more than DRIFT_S. */
const DRIFT_S = 0.08;
const EVENTS = ["play", "playing", "pause", "waiting", "seeked", "ratechange", "ended"] as const;

class Engine {
  ctx = new AudioContext();
  master = this.ctx.createGain();
  parts = new Map<string, { buf: AudioBuffer; gain: GainNode }>();
  playing: AudioBufferSourceNode[] = [];
  from = 0;
  t0 = 0;
  rate = 1;
  timer = 0;
  /** Play, pause, a seek, a stall, a speed change: restart only when out of step. */
  follow = () => {
    if (this.el.paused || this.el.ended || this.el.readyState < 3) this.stop();
    else if (!this.playing.length || this.rate !== this.el.playbackRate || Math.abs(this.drift()) > DRIFT_S) this.start();
  };

  private el: HTMLVideoElement;

  constructor(el: HTMLVideoElement) {
    this.el = el;
    this.master.connect(this.ctx.destination);
    void this.ctx.resume();   // made in a click: browsers let sound start from a gesture
  }

  async load(files: string[], url: (f: string) => string) {
    await Promise.all(files.map(async (f) => {
      const res = await fetch(url(f));
      if (!res.ok) throw new Error(`${f} (${res.status})`);
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      const gain = this.ctx.createGain();
      gain.connect(this.master);
      this.parts.set(f, { buf, gain });
    }));
  }

  run() {
    for (const e of EVENTS) this.el.addEventListener(e, this.follow);
    this.timer = window.setInterval(this.follow, 250);
    this.follow();
  }

  // what's heard now left the graph outputLatency ago (Bluetooth: ~0.2 s), so the parts run that far ahead
  latency = () => this.ctx.outputLatency || this.ctx.baseLatency || 0;
  drift = () => this.from + (this.ctx.currentTime - this.t0) * this.rate - this.el.currentTime - this.latency();

  start() {
    this.stop();
    void this.ctx.resume();
    this.rate = this.el.playbackRate;
    this.from = this.el.currentTime + this.latency();
    this.t0 = this.ctx.currentTime;
    for (const { buf, gain } of this.parts.values()) {
      if (this.from >= buf.duration) continue;
      const s = this.ctx.createBufferSource();
      s.buffer = buf;
      s.playbackRate.value = this.rate;
      s.connect(gain);
      s.start(0, this.from);
      this.playing.push(s);
    }
  }

  stop() {
    for (const s of this.playing) {
      s.stop();
      s.disconnect();
    }
    this.playing = [];
  }

  level(file: string, v: number) {
    this.parts.get(file)?.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  }

  close() {
    window.clearInterval(this.timer);
    for (const e of EVENTS) this.el.removeEventListener(e, this.follow);
    this.stop();
    void this.ctx.close();
  }
}

/**
 * Review's voice controls: the edit's enhancer, and per recording how much of it
 * against the original voice. Until one is touched the video plays its own
 * sound (the cut's mix); then the parts play and the video is muted (`onLive`).
 * `save` keeps the choice for the edit (only for an AI Editor version).
 */
/** The choices a version's sound offers: Off, then each enhanced voice its stems list (keys set by the editor that made them). */
const label = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);

export function VoiceMix({ video, stems: given, url, muted, onLive, save }: {
  video: RefObject<HTMLVideoElement | null>;
  stems: StemSet;
  url: (file: string) => string;
  muted: boolean;
  onLive: (live: boolean) => void;
  save?: (mix: Record<string, number>, voice: string) => Promise<string>;
}) {
  // a version filed without `fx` or `voice` (an older set) offers its one enhanced voice, instead of failing on `stems.fx`
  const stems = useMemo(() => (Array.isArray(given.fx) ? given : { ...given, fx: ["enhanced"], voice: "enhanced" }),
    [given]) as StemSet & { fx: string[]; voice: string };
  const choices = [{ key: "off", label: "Off", hint: "the recording as it is, levelled" },
    ...stems.fx.map((k) => ({ key: k, label: label(k), hint: `${label(k)} voice` }))];
  // what the cut plays, when it's one of the choices
  const cut = choices.some((o) => o.key === stems.voice) ? stems.voice : "off";
  const [voice, setVoice] = useState(cut);
  const [mix, setMix] = useState<Record<string, number>>(() => Object.fromEntries(stems.groups.map((g) => [g.key, g.mix || 1])));
  const [state, setState] = useState<"off" | "loading" | "live">("off");
  const [note, setNote] = useState("");
  const engine = useRef<Engine | null>(null);
  const files = useMemo(() => ["rest.m4a", ...stems.groups.flatMap((g) => ["original", ...stems.fx].map((f) => `${g.key}.${f}.m4a`))], [stems]);
  const live = useRef({ mix, voice, muted, onLive });

  const levels = useCallback((e: Engine) => {
    const { mix: m, voice: fx, muted: off } = live.current;
    e.master.gain.setTargetAtTime(off ? 0 : 1, e.ctx.currentTime, 0.015);
    for (const g of stems.groups) {
      const share = fx === "off" ? 0 : m[g.key];
      e.level(`${g.key}.original.m4a`, 1 - share);
      for (const f of stems.fx) e.level(`${g.key}.${f}.m4a`, f === fx ? share : 0);
    }
  }, [stems]);
  useEffect(() => {
    live.current = { mix, voice, muted, onLive };
  });
  useEffect(() => {   // only when the choice changes (the page re-renders every frame while playing)
    if (engine.current && state === "live") levels(engine.current);
  }, [levels, mix, voice, muted, state]);
  useEffect(() => () => {
    engine.current?.close();
    engine.current = null;
    live.current.onLive(false);
  }, []);

  // the first touch loads the parts (in the click: browsers only start sound from a gesture)
  const start = () => {
    if (engine.current || !video.current) return;
    const e = new Engine(video.current);
    engine.current = e;
    setState("loading");
    setNote("");
    e.load(files, url).then(
      () => {
        if (engine.current !== e) return;
        levels(e);
        e.run();
        setState("live");
        live.current.onLive(true);
      },
      (err: Error) => {
        if (engine.current !== e) return;
        e.close();
        engine.current = null;
        setState("off");
        setNote(`The voices didn't load: ${err.message}`);
      },
    );
  };

  const cutMix = (k: string) => stems.groups.find((g) => g.key === k)!.mix || 1;
  const changed = voice !== cut || (voice !== "off" && stems.groups.some((g) => mix[g.key] !== cutMix(g.key)));
  const pct = (v: number) => Math.round(v * 100);
  const name = choices.find((o) => o.key === voice)?.label ?? voice;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-zinc-900 px-3 py-2 text-xs text-zinc-400">
      <span className="flex items-center gap-1.5 text-zinc-300" title="Every voice at the same loudness">
        <AudioLines className="h-4 w-4" /> Voice
        {state === "loading" && <Loader2 className="h-3 w-3 animate-spin" />}
      </span>
      <div className="flex shrink-0 overflow-hidden rounded-md border border-zinc-800">
        {choices.map((o) => (
          <button
            key={o.key}
            title={o.hint}
            onClick={() => {
              setVoice(o.key);
              start();
            }}
            className={cn("px-2 py-1", voice === o.key ? "bg-zinc-800 text-zinc-100" : "hover:text-zinc-200")}
          >
            {o.label}
          </button>
        ))}
      </div>
      {voice !== "off" && stems.groups.map((g) => (
        <div key={g.key} className="flex min-w-0 flex-1 basis-[200px] items-center gap-2">
          {stems.groups.length > 1 && <span className="max-w-32 truncate text-zinc-300" title={g.label}>{g.label}</span>}
          <span className="shrink-0 text-zinc-500">Original</span>
          <Slider
            className="min-w-16 flex-1"
            min={0}
            max={100}
            step={5}
            value={[pct(mix[g.key])]}
            onValueChange={([v]) => {
              setMix((m) => ({ ...m, [g.key]: v / 100 }));
              start();
            }}
            aria-label={`${g.label}: how much is ${name}`}
          />
          <span className="w-9 shrink-0 text-right tabular-nums" title={`${pct(mix[g.key])}% ${name}`}>{pct(mix[g.key])}%</span>
        </div>
      ))}
      {save && changed && (
        <button
          onClick={() => {
            setNote("Saving…");
            save(mix, voice).then(setNote, (e: Error) => setNote(e.message));
          }}
          className="rounded-md bg-violet-600 px-2.5 py-1 font-medium text-white hover:bg-violet-500"
        >
          Use this voice
        </button>
      )}
      {note && <span className="w-full text-zinc-500">{note}</span>}
    </div>
  );
}
