// Small pictures of a video file at whole seconds, for the clips on the editor's timeline: one seek at a time across the
// page (after the player's own work), each picture kept for the page's life. One hidden <video> at a time, let go when
// another file's turn comes and when nothing is left to draw: an open one goes on loading its file, and one per file
// (30 camera files on a timeline) kept loading under Play until the Mac app's file serving and the page froze.

const HEIGHT = 44;
const kept = new Map<string, Promise<ImageBitmap | null>>();
let open: { url: string; el: HTMLVideoElement } | null = null;
let waiting = 0;
let line: Promise<unknown> = Promise.resolve();

const shut = () => {
  open?.el.removeAttribute("src");
  open?.el.load();
  open = null;
};

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
    waiting++;
    const job = line.then(async () => {
      if (open?.url !== url) {
        shut();
        open = { url, el: Object.assign(document.createElement("video"), { muted: true, playsInline: true, preload: "auto", src: url }) };
        if (!(await ready(open.el, "loadeddata"))) return null;
      }
      const el = open.el;
      if (el.error) return null;
      el.currentTime = Math.min(sec, Math.max(0, (el.duration || sec) - 0.05));
      if (!(await ready(el, "seeked")) || !el.videoWidth) return null;
      return createImageBitmap(el, { resizeHeight: height, resizeQuality: height > HEIGHT ? "medium" : "low" }).catch(() => null);
    });
    line = got = job.catch(() => null);
    void got.then(() => void (--waiting || shut()));
    kept.set(key, got);
  }
  return got;
}
