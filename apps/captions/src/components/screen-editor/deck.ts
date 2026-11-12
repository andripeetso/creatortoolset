// One video file on two <video> elements that take turns.
//
// Why two: in the Mac app's web view a video that has played and is then moved (a jump on the timeline, a loop's turn,
// the element's own `loop`) runs for about 0.34 s after it starts again, stands still for 0.24 s, and goes on. That is
// the web view's own doing: a bare <video> does it with any file, whatever the order of pause, move and play. A video
// that has not played since it was loaded starts cleanly, also from a place it was moved to first. So the one that is
// not showing is kept loaded and unplayed, and takes over whenever playing has to start somewhere else; the one that
// played is then loaded again and becomes the spare. Measured in the Mac's own WebKit on the videos' clocks: the
// longest standstill after a turn is 0 to 72 ms this way, 240 ms with one element.

type Slot = { el: HTMLVideoElement; loaded: Promise<void>; played: boolean; jumped: boolean };

const once = (el: HTMLVideoElement, event: string) => new Promise<void>((done) => el.addEventListener(event, () => done(), { once: true }));

export type DeckEvents = {
  /** The showing video began to play, stopped, landed after a move, or has its first frame. */
  play: () => void;
  pause: () => void;
  seeked: () => void;
  loaded: () => void;
  ended: () => void;
  /** The file's own length, once known. */
  duration: (seconds: number) => void;
  error: () => void;
};

export class Deck {
  private slots: Slot[];
  private on = 0;
  /** Every play, pause and takeover takes a number; an older one that wakes up late gives way to the newer. */
  private turn = 0;
  /** The spare has been started for a loop's turn and has not taken over yet. */
  private handing = false;
  /** Where the spare waits (the start of the kept part while it plays; where the showing one stands while it does not). */
  private parkAt = 0;
  private follow = 0;
  private renewing = 0;
  private muted: boolean;
  private gone = false;
  private url: string;
  private sound: boolean;
  private events: DeckEvents;

  constructor(holder: HTMLElement, url: string, sound: boolean, muted: boolean, events: DeckEvents) {
    this.url = url;
    this.sound = sound;
    this.events = events;
    this.muted = muted;
    this.slots = [this.make(holder), this.make(holder)];
    this.applySound();
  }

  /** The video whose picture and sound are on. */
  get el(): HTMLVideoElement {
    return this.slots[this.on].el;
  }

  private get showing(): Slot {
    return this.slots[this.on];
  }

  private get spare(): Slot {
    return this.slots[1 - this.on];
  }

  private make(holder: HTMLElement): Slot {
    const el = document.createElement("video");
    el.crossOrigin = "anonymous";
    el.playsInline = true;
    el.preload = "auto";
    el.muted = true;
    // never display: none, which stops the web view decoding it
    el.className = "pointer-events-none absolute left-0 top-0 h-px w-px opacity-0";
    const slot: Slot = { el, loaded: Promise.resolve(), played: false, jumped: false };
    const shows = () => !this.gone && this.showing === slot;
    el.addEventListener("playing", () => (slot.played = true));
    el.addEventListener("play", () => shows() && this.events.play());
    el.addEventListener("pause", () => shows() && this.events.pause());
    el.addEventListener("seeked", () => shows() && this.events.seeked());
    el.addEventListener("loadeddata", () => shows() && this.events.loaded());
    el.addEventListener("ended", () => shows() && this.events.ended());
    el.addEventListener("error", () => shows() && this.events.error());
    el.addEventListener("loadedmetadata", () => Number.isFinite(el.duration) && el.duration > 0 && this.events.duration(el.duration));
    holder.appendChild(el);
    this.load(slot);
    return slot;
  }

  /** Loads the slot's video (again): it has not played, and has not been moved, until it does. */
  private load(slot: Slot) {
    slot.played = false;
    slot.jumped = false;
    slot.loaded = new Promise<void>((done) => {
      const ok = () => {
        slot.el.removeEventListener("loadeddata", ok);
        slot.el.removeEventListener("error", ok);
        done();
      };
      slot.el.addEventListener("loadeddata", ok);
      slot.el.addEventListener("error", ok);
    });
    if (slot.el.getAttribute("src") !== this.url) slot.el.src = this.url;
    else slot.el.load();
  }

  private applySound() {
    this.showing.el.muted = !this.sound || this.muted;
    this.spare.el.muted = true;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.applySound();
  }

  /** Whether the showing video plays its own sound (off while the editor plays the sound itself: sound.ts). */
  setSound(on: boolean) {
    this.sound = on;
    this.applySound();
  }

  /** Moves the showing video while it is not playing (the picture follows a drag at once). */
  seek(t: number) {
    const a = this.showing;
    a.el.currentTime = t;
    if (a.played) a.jumped = true;
    // the spare is brought to the same place a moment later, ready to take over when Play is pressed
    this.park(t, 150);
  }

  /** Where the spare should wait. It goes there once it is loaded and unplayed (after `wait` ms without a newer place). */
  park(t: number, wait = 0) {
    if (wait === 0 && t === this.parkAt) return; // asked on every frame while it plays: nothing new
    this.parkAt = t;
    window.clearTimeout(this.follow);
    this.follow = window.setTimeout(() => void this.settle(), wait);
  }

  private async settle() {
    const s = this.spare;
    if (this.handing || this.gone) return;
    if (s.played) this.load(s);
    await s.loaded;
    if (this.gone || this.handing || this.spare !== s || s.played) return;
    if (Math.abs(s.el.currentTime - this.parkAt) > 0.02 && !s.el.seeking) s.el.currentTime = this.parkAt;
  }

  /**
   * Starts playing where the showing video stands. If that one has played and been moved since, the spare takes
   * over at the same place (a moment's wait while it gets there). Resolves false when a newer play or pause came.
   */
  async play(): Promise<boolean> {
    const mine = ++this.turn;
    window.clearTimeout(this.follow);
    const a = this.showing;
    if (!(a.played && a.jumped)) {
      await a.el.play();
      return mine === this.turn;
    }
    const at = a.el.currentTime;
    const s = this.spare;
    if (s.played) this.load(s);
    await s.loaded;
    if (mine !== this.turn || this.gone) return false;
    // A move already under way (the spare following the showing one) is waited for, never doubled: a second move
    // made on top of it lets Play start on the first one's landing, and the video then stands still when the second
    // lands (0.3 to 0.6 s, measured).
    while (s.el.seeking) {
      await once(s.el, "seeked");
      if (mine !== this.turn || this.gone) return false;
    }
    if (Math.abs(s.el.currentTime - at) > 0.02) {
      s.el.currentTime = at;
      await once(s.el, "seeked");
      if (mine !== this.turn || this.gone) return false;
    }
    this.on = 1 - this.on;
    this.applySound();
    await s.el.play();
    this.renew(a); // the one that played becomes the spare, unplayed again
    return mine === this.turn;
  }

  pause() {
    this.turn++;
    if (this.handing) {
      // a turn in the making is called off: its spare has begun to play, so it is loaded again
      this.handing = false;
      this.spare.el.pause();
      this.load(this.spare);
    }
    this.showing.el.pause();
  }

  /** The spare stands loaded, unplayed and at its place: a loop's turn can be handed to it. Moves it there if it is not. */
  canTurn(): boolean {
    const s = this.spare;
    if (this.handing || s.played || s.el.readyState < 2 || s.el.seeking) return false;
    if (Math.abs(s.el.currentTime - this.parkAt) > 0.02) {
      s.el.currentTime = this.parkAt;
      return false;
    }
    return true;
  }

  /** Starts the spare a little before the showing video ends (a video takes 0.1 to 0.4 s to get going). */
  beginTurn() {
    this.handing = true;
    void this.spare.el.play().catch(() => {});
  }

  get turning(): boolean {
    return this.handing;
  }

  /** The spare takes over: the loop has turned. */
  finishTurn() {
    if (!this.handing) return;
    this.handing = false;
    const old = this.showing;
    this.on = 1 - this.on;
    this.applySound();
    old.el.pause();
    this.renew(old);
  }

  /**
   * The slot that played is loaded again, a little later: loading it at the moment the other one starts made that
   * one stand still about 0.3 s in, one start in four (measured); a second later it does not.
   */
  private renew(slot: Slot) {
    window.clearTimeout(this.renewing);
    this.renewing = window.setTimeout(() => {
      if (this.gone || this.showing === slot) return;
      this.load(slot);
      void this.settle();
    }, 1200);
  }

  dispose() {
    this.gone = true;
    window.clearTimeout(this.follow);
    window.clearTimeout(this.renewing);
    for (const { el } of this.slots) {
      el.pause();
      el.removeAttribute("src");
      el.load();
      el.remove();
    }
  }
}
