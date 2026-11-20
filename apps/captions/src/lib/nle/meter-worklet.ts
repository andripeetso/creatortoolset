// The loudness meter's AudioWorklet (audio.ts nleMeter): it runs on the editor's master bus at the AudioContext's own
// sample rate and posts { m, s, i, tp } (LUFS, LUFS, LUFS, dBTP) and the channels' sample peaks (`pk`, linear) every
// 100 ms. A "reset" message starts the integrated value and true peak over (Play from a new place).
import { LoudnessMeter } from "./loudness";

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class NleMeter extends AudioWorkletProcessor {
  private meter: LoudnessMeter | null = null;
  private pk = [0, 0];
  private n = 0;

  constructor() {
    super();
    this.port.onmessage = (e) => {
      if (e.data === "reset") this.meter?.reset();
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const chs = inputs[0];
    if (!chs?.length) return true;
    this.meter ??= new LoudnessMeter(sampleRate, Math.max(2, chs.length));
    this.meter.process(chs);
    for (let c = 0; c < 2; c++) {
      const x = chs[Math.min(c, chs.length - 1)]!;
      for (let i = 0; i < x.length; i++) if (Math.abs(x[i]!) > this.pk[c]!) this.pk[c] = Math.abs(x[i]!);
    }
    // a quantum is 128 frames: about every 100 ms
    if ((this.n += chs[0]!.length) >= sampleRate / 10) {
      const m = this.meter;
      this.port.postMessage({ m: m.momentary, s: m.shortTerm, i: m.integrated, tp: m.truePeakDb, pk: this.pk });
      this.pk = [0, 0];
      this.n = 0;
    }
    return true;
  }
}

registerProcessor("nle-meter", NleMeter);
