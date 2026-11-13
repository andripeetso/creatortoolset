import { getScreenRecording, reviewApi, saveScreenLook, type ReviewVersion } from "./review";
import { postToApp, type LocalRecording } from "./mac-record";
import { localFileUrl, localFilesOverlap, readLocalFile } from "./local-files";
import type { FaceTrack, ScreenEvents, ScreenLook } from "./screen-recording";

/** Where the screen recorder editor gets its recording: a Review video version, or a local recording on this Mac. */
export type ScreenSource = {
  /** The screen video (`<video src>` and the export's input). Always used with crossOrigin "anonymous". */
  url: string;
  /** The camera video beside it, when the recording has one. */
  cameraUrl: string | null;
  /** The same two files as copies in the page, when they were read whole first: the export reads these. */
  file?: Blob;
  cameraFile?: Blob;
  name: string;
  /** The pointer log and the saved look (null until the look is first saved). */
  load(): Promise<{ events: ScreenEvents | null; look: ScreenLook | null }>;
  /** Keeps the look. The caller debounces. */
  saveLook(look: ScreenLook): void;
  /** Where the face is in the camera file, when it was found before (a local recording); null when not. */
  faces?(): Promise<FaceTrack | null>;
  /** Has the Mac app find the face in the camera file (a local recording, an app that reports `faces`); `part` hears 0–1. */
  findFaces?(part: (p: number) => void): Promise<FaceTrack | null>;
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
  const faces = () =>
    fetch(file("camera-faces.json"))
      .then((r) => (r.ok ? (r.json() as Promise<FaceTrack>) : null))
      .catch(() => null);
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
    faces,
    findFaces(part) {
      // the app answers with 'mac-faces' events for this recording: "making" with how far, then "done" or "failed"
      return new Promise((resolve, reject) => {
        const on = (e: Event) => {
          const d = (e as CustomEvent<{ id: string; state: string; part: number }>).detail;
          if (d?.id !== rec.id) return;
          if (d.state === "making") return part(d.part);
          window.removeEventListener("mac-faces", on);
          if (d.state === "done") resolve(faces());
          else reject(new Error("The face could not be found in the camera"));
        };
        window.addEventListener("mac-faces", on);
        postToApp(`record-faces:${rec.id}`);
      });
    },
  };
}

/**
 * A local recording made ready for the editor. In an app whose scheme takes requests at once this is `localSource`.
 * In an older app (lib/local-files.ts) the video and the camera are read whole first, one after the other, and the
 * pointer log and the look are read in their turn in `load`. `close` lets the copies go.
 */
export async function openLocalRecording(rec: LocalRecording): Promise<ScreenSource & { close: () => void }> {
  const direct = localSource(rec);
  if (localFilesOverlap()) return { ...direct, close: () => {} };
  const file = (name: string) => `ctlocal://${rec.id}/${name}`;
  const screen = await localFileUrl(file("screen.mp4"));
  const camera = rec.camera ? await localFileUrl(file("camera.mp4")).catch(() => null) : null;
  return {
    ...direct,
    url: screen.url,
    cameraUrl: camera?.url ?? null,
    file: screen.blob ?? undefined,
    cameraFile: camera?.blob ?? undefined,
    async load() {
      const log = await readLocalFile(file("screen-events.json")).catch(() => {
        throw new Error("This recording's pointer log is missing");
      });
      const events = JSON.parse(await log.text()) as ScreenEvents;
      const look = await readLocalFile(file("screen-look.json")).then(
        async (b) => JSON.parse(await b.text()) as ScreenLook,
        () => null,
      );
      return { events, look };
    },
    close: () => {
      screen.release();
      camera?.release();
    },
  };
}
