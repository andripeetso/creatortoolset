// Small pictures of a video file at whole seconds, for the clips on the editor's timeline: one seek at a time across the
// page (after the player's own work), each picture kept for the page's life. One hidden <video> at a time, let go when
// another file's turn comes and when nothing is left to draw: an open one goes on loading its file, and one per file
// (30 camera files on a timeline) kept loading under Play until the Mac app's file serving and the page froze.

const HEIGHT = 44;
const kept = new Map<string, Promise<ImageBitmap | null>>();
let open: { url: string; el: HTMLVideoElement } | null = null;
type Job = { url: string; sec: number; height: number; done: (b: ImageBitmap | null) => void };
const jobs: Job[] = [];
let running = false;
// files that didn't load in this run: their other pictures give up at once instead of waiting 8 s each
const dead = new Set<string>();

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

async function draw({ url, sec, height }: Job): Promise<ImageBitmap | null> {
  if (dead.has(url)) return null;
  if (open?.url !== url) {
    shut();
    open = { url, el: Object.assign(document.createElement("video"), { muted: true, playsInline: true, preload: "auto", src: url }) };
    if (!(await ready(open.el, "loadeddata"))) return (dead.add(url), shut(), null);
  }
  const el = open.el;
  if (el.error) return null;
  el.currentTime = Math.min(sec, Math.max(0, (el.duration || sec) - 0.05));
  if (!(await ready(el, "seeked")) || !el.videoWidth) return null;
  return createImageBitmap(el, { resizeHeight: height, resizeQuality: height > HEIGHT ? "medium" : "low" }).catch(() => null);
}

async function pump() {
  if (running) return;
  running = true;
  while (jobs.length) {
    // the open file's pictures first: a file opens once per run, not again for every clip that cuts back to it
    const [job] = jobs.splice(Math.max(0, jobs.findIndex((j) => j.url === open?.url)), 1);
    job.done(await draw(job).catch(() => null));
  }
  shut();
  dead.clear();   // a file that comes online later gets its pictures on the next run
  running = false;
}

/** The picture of `url` at second `sec`, `height` px tall (null when the file won't play here). */
export function thumbAt(url: string, sec: number, height = HEIGHT): Promise<ImageBitmap | null> {
  const key = `${url}@${sec}@${height}`;
  let got = kept.get(key);
  if (!got) {
    got = new Promise((done) => jobs.push({ url, sec, height, done }));
    kept.set(key, got);
    // only real pictures are kept: a file that didn't load (a share still waking) is asked again on its next draw
    void got.then((b) => b || kept.delete(key));
    // after the caller's own work, one seek at a time across the page
    void Promise.resolve().then(pump);
  }
  return got;
}
