import { getScreenRecording, reviewApi, saveScreenLook, type ReviewVersion } from "./review";
import { postToApp, type LocalRecording } from "./mac-record";
import type { ScreenEvents, ScreenLook } from "./screen-recording";

/** Where the screen recorder editor gets its recording: a Review video version, or a local recording on this Mac. */
export type ScreenSource = {
  /** The screen video (`<video src>` and the export's input). Always used with crossOrigin "anonymous". */
  url: string;
  /** The camera video beside it, when the recording has one. */
  cameraUrl: string | null;
  name: string;
  /** The pointer log and the saved look (null until the look is first saved). */
  load(): Promise<{ events: ScreenEvents | null; look: ScreenLook | null }>;
  /** Keeps the look. The caller debounces. */
  saveLook(look: ScreenLook): void;
};

/** A Review video version: the play URL, the pointer log and look kept on the server. */
export function reviewSource(assetId: string, version: ReviewVersion): ScreenSource {
  return {
    url: reviewApi(`/api/review/assets/${assetId}`).media(version, "play"),
    cameraUrl: null,
    name: version.name,
    load: () => getScreenRecording(assetId, version.n),
    saveLook: (look) => void saveScreenLook(assetId, version.n, look).catch(() => {}),
  };
}

/** A local recording on this Mac, read from the app's ctlocal:// scheme; the look goes back to the app. */
export function localSource(rec: LocalRecording): ScreenSource {
  const file = (name: string) => `ctlocal://${rec.id}/${name}`;
  return {
    url: file("screen.mp4"),
    cameraUrl: rec.camera ? file("camera.mp4") : null,
    name: rec.name,
    async load() {
      const events = await fetch(file("screen-events.json")).then((r) => {
        if (!r.ok) throw new Error("This recording's pointer log is missing");
        return r.json() as Promise<ScreenEvents>;
      });
      const look = await fetch(file("screen-look.json"))
        .then((r) => (r.ok ? (r.json() as Promise<ScreenLook>) : null))
        .catch(() => null);
      return { events, look };
    },
    saveLook: (look) => postToApp(`record-look:${rec.id}:${JSON.stringify(look)}`),
  };
}
