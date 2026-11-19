// Small pictures of a video file at whole seconds, for the clips on the editor's timeline: one hidden <video> per file,
// one seek at a time across the page (after the player's own work), each picture kept for the page's life.

const HEIGHT = 44;
const kept = new Map<string, Promise<ImageBitmap | null>>();
const players = new Map<string, HTMLVideoElement>();
let line: Promise<unknown> = Promise.resolve();

const ready = (el: HTMLVideoElement, ev: "loadeddata" | "seeked") =>
  new Promise<boolean>((res) => {
    const done = (ok: boolean) => {
      el.removeEventListener(ev, yes);
      el.removeEventListener("error", no);
      clearTimeout(timer);
      res(ok);
    };
    const yes = () => done(true);
    const no = () => done(false);
    const timer = setTimeout(no, 8000);
    el.addEventListener(ev, yes);
    el.addEventListener("error", no);
  });

/** The picture of `url` at second `sec`, `height` px tall (null when the file won't play here). */
export function thumbAt(url: string, sec: number, height = HEIGHT): Promise<ImageBitmap | null> {
  const key = `${url}@${sec}@${height}`;
  let got = kept.get(key);
  if (!got) {
    const job = line.then(async () => {
      let el = players.get(url);
      if (!el) {
        el = Object.assign(document.createElement("video"), { muted: true, playsInline: true, preload: "auto", src: url });
        players.set(url, el);
        if (!(await ready(el, "loadeddata"))) return null;
      }
      if (el.error) return null;
      el.currentTime = Math.min(sec, Math.max(0, (el.duration || sec) - 0.05));
      if (!(await ready(el, "seeked")) || !el.videoWidth) return null;
      return createImageBitmap(el, { resizeHeight: height, resizeQuality: height > HEIGHT ? "medium" : "low" }).catch(() => null);
    });
    line = got = job.catch(() => null);
    kept.set(key, got);
  }
  return got;
}
