import {
  ALL_FORMATS,
  BlobSource,
  Conversion,
  Input,
  NullTarget,
  Output,
  WavOutputFormat,
  type AudioSample,
} from "mediabunny";

import { waveformPeaks } from "./waveform-peaks";

const TRANSCRIPTION_SAMPLE_RATE = 16_000;
const MEDIA_READ_CACHE_BYTES = 16 * 1024 * 1024;

export interface DecodedAudio {
  pcm: Float32Array;
  peaks: Float32Array;
  duration: number;
}

/**
 * Whether the file opens as media with a sound track. It reads the file's headers only, so it is quick and fine on
 * the page. A file that only has a video's name, or a clip with no sound, is false: neither can be captioned.
 */
export async function hasSoundTrack(file: Blob): Promise<boolean> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    return !!(await input.getPrimaryAudioTrack());
  } catch {
    return false;
  } finally {
    input.dispose();
  }
}

/** Worker-only implementation; never call this from the renderer thread. */
export async function decodeAudioFile(
  file: File,
  onProgress?: (progress: number, detail: string) => void,
): Promise<DecodedAudio> {
  const startedAt = Date.now();
  const log = (message: string) =>
    console.log(`[cap-audio:worker] +${Date.now() - startedAt}ms ${message}`);
  log(`decode start file="${file.name}" bytes=${file.size}`);
  onProgress?.(0, "Reading audio track");
  const input = new Input({
    source: new BlobSource(file, { maxCacheSize: MEDIA_READ_CACHE_BYTES }),
    formats: ALL_FORMATS,
  });
  let pcmBuffer = new Float32Array(TRANSCRIPTION_SAMPLE_RATE);
  let sampleCount = 0;

  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error("This file has no audio track");
    log(
      `audio track found codec=${track.codec} channels=${track.numberOfChannels} rate=${track.sampleRate}`,
    );

    const metadataDuration = await input
      .getDurationFromMetadata([track])
      .catch(() => null);
    log(`metadata duration=${metadataDuration ?? "unknown"}`);
    if (metadataDuration && Number.isFinite(metadataDuration)) {
      pcmBuffer = new Float32Array(
        Math.ceil(metadataDuration * TRANSCRIPTION_SAMPLE_RATE) +
          TRANSCRIPTION_SAMPLE_RATE,
      );
    }
    const output = new Output({
      format: new WavOutputFormat(),
      target: new NullTarget(),
    });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      video: { discard: true },
      audio: {
        numberOfChannels: 1,
        sampleRate: TRANSCRIPTION_SAMPLE_RATE,
        sampleFormat: "f32",
        codec: "pcm-f32",
        forceTranscode: true,
        process: (sample: AudioSample) => {
          const required = sampleCount + sample.numberOfFrames;
          if (required > pcmBuffer.length) {
            const grown = new Float32Array(
              Math.max(required, pcmBuffer.length * 2),
            );
            grown.set(pcmBuffer.subarray(0, sampleCount));
            pcmBuffer = grown;
          }
          sample.copyTo(pcmBuffer.subarray(sampleCount, required), {
            planeIndex: 0,
            format: "f32",
          });
          sampleCount = required;
          return sample;
        },
      },
      showWarnings: false,
    });
    if (!conversion.isValid) {
      throw new Error("The browser cannot decode this file's audio track");
    }
    log("conversion initialized — decoding");
    let lastLoggedPct = -10;
    conversion.onProgress = (progress) => {
      const pct = Math.floor(Math.max(0, Math.min(1, progress)) * 100);
      if (pct >= lastLoggedPct + 10) {
        lastLoggedPct = pct;
        log(`decode progress ${pct}% samples=${sampleCount}`);
      }
      onProgress?.(Math.max(0, Math.min(1, progress)), "Preparing audio");
    };

    await conversion.execute();
    if (!sampleCount) throw new Error("The audio track was empty");
    log(`execute complete samples=${sampleCount}`);

    // slice creates an exactly-sized transferable buffer. This allocation is
    // inside the worker, so it cannot stall the editor's event loop.
    const pcm = pcmBuffer.slice(0, sampleCount);
    const duration =
      metadataDuration && Number.isFinite(metadataDuration)
        ? metadataDuration
        : pcm.length / TRANSCRIPTION_SAMPLE_RATE;
    const peaks = waveformPeaks(pcm, duration);
    log(`done pcmBytes=${pcm.byteLength} duration=${duration}`);
    return { pcm, peaks, duration };
  } finally {
    input.dispose();
  }
}
