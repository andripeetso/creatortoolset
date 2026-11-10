import { expect, it } from "vitest";
import { hasSoundTrack } from "./audio-decode";

/** A tenth of a second of silence as a WAV file: the smallest real file with a sound track. */
function wav(): Blob {
  const n = 1600;
  const b = new DataView(new ArrayBuffer(44 + n * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => b.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  b.setUint32(4, 36 + n * 2, true);
  text(8, "WAVEfmt ");
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true);
  b.setUint16(22, 1, true);
  b.setUint32(24, 16000, true);
  b.setUint32(28, 32000, true);
  b.setUint16(32, 2, true);
  b.setUint16(34, 16, true);
  text(36, "data");
  b.setUint32(40, n * 2, true);
  return new Blob([b.buffer]);
}

it("says yes to a file with a sound track and no to one that only has a video's name", async () => {
  expect(await hasSoundTrack(wav())).toBe(true);
  expect(await hasSoundTrack(new File(["just some notes"], "notes.mp4", { type: "video/mp4" }))).toBe(false);
});
