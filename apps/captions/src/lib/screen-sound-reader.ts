import { AudioBufferSink, type InputAudioTrack } from "mediabunny";
import { TrackReader } from "./screen-sound";

/**
 * A reader of one decoded sound track from `from` (seconds), or null when this browser cannot decode it. `close()`
 * stops the decoder.
 */
export async function openTrackReader(track: InputAudioTrack, from: number): Promise<{ reader: TrackReader; close: () => void } | null> {
  if (!(await track.canDecode())) return null;
  const buffers = new AudioBufferSink(track).buffers(Math.max(0, from));
  const reader = new TrackReader(async () => {
    const got = await buffers.next();
    if (got.done) return null;
    const { buffer, timestamp } = got.value;
    return { at: timestamp, rate: buffer.sampleRate, planes: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)) };
  }, Math.max(1, track.numberOfChannels));
  return { reader, close: () => void buffers.return(undefined) };
}
