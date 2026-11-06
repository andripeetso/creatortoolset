/// <reference lib="webworker" />
import { decodeAudioFile } from "../lib/audio-decode";

type InMessage = { type: "decode"; file: File };

const post = (message: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

self.onmessage = async (event: MessageEvent<InMessage>) => {
  if (event.data.type !== "decode") return;
  try {
    const result = await decodeAudioFile(event.data.file, (progress, detail) =>
      post({ type: "progress", progress, detail }),
    );
    post(
      {
        type: "done",
        pcm: result.pcm,
        peaks: result.peaks,
        duration: result.duration,
      },
      [result.pcm.buffer, result.peaks.buffer],
    );
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
