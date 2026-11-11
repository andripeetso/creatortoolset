import { useEffect, useState, type CSSProperties } from "react";
import { navListFor } from "@/components/settings/nav";
import { useAuth, useMe } from "@/lib/auth";
import { playIntroBeat, stopIntroSound } from "@/lib/intro-sound";
import { endIntro, useIntro } from "@/lib/setup";
import { cn } from "@/lib/utils";

/**
 * Home's welcome, played once after setup (lib/setup.ts useIntro). It is Home itself arriving: the name, letter by
 * letter; "Your content pipeline" alone, then Plan, Make and Distribute popping up as stages with a line drawn between
 * them; each stage opening into its box and the tools popping in, then the Extras; what you can connect; all of it
 * together. Colour drifts round behind it, and it has its own sound (lib/intro-sound.ts): a quiet bed of notes and a
 * small sound on each move. Nothing of the app is in the picture while it plays: no top bar, no
 * assistant, and Skip only while the pointer moves. Home carries the beat as `data-intro`; the moves are in index.css
 * (.intro-*), and each ends on the page's own look, so when the attribute goes (the end, Skip, Escape) Home is
 * exactly as it always is.
 */

/** The beats in order, how long each stays (ms) and the line it shows. About 15 s in all: tune it here. */
export const BEATS: ReadonlyArray<{ id: "hello" | "pipeline" | "stages" | "tools" | "connect" | "all"; ms: number; say?: string }> = [
  { id: "hello", ms: 3400 },
  { id: "pipeline", ms: 1300, say: "Your content pipeline" },
  { id: "stages", ms: 2500, say: "Your content pipeline" },
  { id: "tools", ms: 3000, say: "A tool for every step" },
  { id: "connect", ms: 3000, say: "Connect what you already use" },
  { id: "all", ms: 2200, say: "Every tool included, free. All in one place." },
];
export type Beat = (typeof BEATS)[number]["id"];

/** What you do at each stage, shown under its name until it opens into its box. */
export const STAGE_SAYS: Record<string, string> = { plan: "Research and write", make: "Edit and review", distribute: "Finish and post" };

/** What the connect beat shows: these Settings pages, by the names and icons Settings gives them, and only the ones this install has. */
const CONNECT = ["connectors", "devices", "folders", "servers", "team"];

/** Pointer movement is ignored this long after it starts (ms): then moving the pointer shows Skip. */
const SKIP_AFTER_MS = 1500;

const at = (beat: Beat) => BEATS.find((b) => b.id === beat)!;

// the sound stops when the welcome does, however it ends (the last beat, Skip, Escape, leaving Home)
useIntro.subscribe((s, was) => {
  if (was.on && !s.on) stopIntroSound();
});
/** A scene's timing: it comes, stays and goes within `ms`, starting `wait` ms in. */
const lasts = (ms: number, wait = 0) => ({ animationDelay: `${wait}ms`, animationDuration: `${ms - wait}ms` });

/** The beat the welcome is on, moving through BEATS by itself; null when it is not playing. Escape skips it. */
export function useIntroBeat(): Beat | null {
  const on = useIntro((s) => s.on);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return setN(0);
    const t = window.setTimeout(() => (n + 1 < BEATS.length ? setN(n + 1) : endIntro()), BEATS[n]!.ms);
    return () => window.clearTimeout(t);
  }, [on, n]);
  useEffect(() => {
    if (!on) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && endIntro();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [on]);
  return on ? BEATS[n]!.id : null;
}

/** A word of the name as letters, each in its own slot so it can rise into it; `from` = how many letters came before (--i), --k = its place in its word. */
const letters = (word: string, from: number) =>
  [...word].map((ch, i) => (
    <span key={i} className="intro-letter" style={{ "--i": from + i, "--k": i } as CSSProperties}>
      <span>{ch}</span>
    </span>
  ));

/** Over and behind Home while it plays: the drifting colour, the two beats that take the middle of the window, and Skip. */
export function HomeIntro({ beat }: { beat: Beat }) {
  const hosted = useAuth((s) => s.hosted);
  const me = useMe();
  // the Mac app's own mark on <html> (settings/ThisMacSection hasThisMac), read here so Home loads no Settings page for it
  const pages = navListFor({ hosted, admin: me?.role === "admin", mac: document.documentElement.dataset.macThisMac === "1" });
  const chips = CONNECT.flatMap((id) => pages.filter((p) => p.id === id));
  // each beat's sounds as it starts: one note for each tool and tile on the page
  const chipCount = chips.length;
  useEffect(() => {
    const count = (sel: string) => document.querySelectorAll(sel).length;
    playIntroBeat(beat, { stages: count(".intro-box"), tiles: count(".intro-tile"), extras: count(".intro-extra"), chips: chipCount }, { len: at(beat).ms / 1000, last: beat === BEATS[BEATS.length - 1]!.id });
  }, [beat, chipCount]);
  // Skip belongs to the app, not to the picture: it shows while the pointer moves, as a player's controls do. Not in the
  // first moments (the hand leaving Done would bring it up under the name), and not for a move with no distance (the
  // setup window closing under a still pointer)
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    let t = 0;
    const from = performance.now();
    // where the pointer last was: the distance is worked out here (WebKit gives these events no movementX/Y)
    let last: { x: number; y: number } | null = null;
    const move = (e: PointerEvent) => {
      const went = !!last && (last.x !== e.clientX || last.y !== e.clientY);
      last = { x: e.clientX, y: e.clientY };
      if (performance.now() - from < SKIP_AFTER_MS || !went) return;
      setMoved(true);
      window.clearTimeout(t);
      t = window.setTimeout(() => setMoved(false), 2200);
    };
    window.addEventListener("pointermove", move);
    return () => (window.removeEventListener("pointermove", move), window.clearTimeout(t));
  }, []);
  return (
    <>
      <div
        aria-hidden
        className="intro-aurora pointer-events-none absolute inset-0 -z-10 overflow-hidden"
        // it fades in and out with the whole welcome
        style={{ animationDuration: `${BEATS.reduce((a, b) => a + b.ms, 0)}ms` }}
      >
        <i />
        <i />
        <i />
      </div>
      <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-6 text-center">
        {beat === "hello" && (
          <div key="hello" className="intro-scene" style={lasts(at(beat).ms)}>
            <p className="intro-pre text-xl text-zinc-400">Welcome to</p>
            <h1 className="intro-title mt-2 text-zinc-50" aria-label="Creator Toolset">
              <span aria-hidden>{letters("Creator", 0)}</span>
              <span aria-hidden className="intro-marked">
                {letters("Toolset", 7)}
              </span>
            </h1>
          </div>
        )}
        {beat === "connect" && (
          // a moment late: Home dims behind it first
          <div key="connect" className="intro-scene flex flex-col items-center gap-8" style={lasts(at(beat).ms, 250)}>
            <p className="text-2xl font-semibold tracking-tight text-zinc-50">{at(beat).say}</p>
            <ul className="flex flex-wrap justify-center gap-x-2 gap-y-4">
              {chips.map((c, i) => (
                <li key={c.id} className="intro-chip flex w-28 flex-col items-center gap-2" style={{ "--i": i } as CSSProperties}>
                  <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--tint)_90%,transparent)]">
                    <c.icon className="h-6 w-6 text-white" />
                  </span>
                  <span className="text-xs text-zinc-300">{c.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={endIntro}
        className={cn(
          "absolute bottom-8 left-1/2 z-30 [translate:-50%_0] rounded-full border border-zinc-800 bg-zinc-900/60 px-4 py-1.5 text-xs text-zinc-400 backdrop-blur transition-[opacity,color] duration-300 hover:text-zinc-100 focus-visible:pointer-events-auto focus-visible:opacity-100",
          !moved && "pointer-events-none opacity-0",
        )}
      >
        Skip
      </button>
    </>
  );
}

/**
 * The beat's line over the boxes (the connect beat says its own, in the middle). Sits in Home's column. Beats that say
 * the same keep one line between them (its key is the words): "Your content pipeline" stands alone first, then glides
 * up as the stages come.
 */
export function IntroCaption({ beat }: { beat: Beat }) {
  const say = at(beat).say;
  if (!say || beat === "connect") return null;
  const ms = BEATS.filter((b) => b.say === say).reduce((a, b) => a + b.ms, 0);
  return (
    <p key={say} className="intro-caption">
      <span className="intro-scene inline-block text-2xl font-semibold tracking-tight text-zinc-50" style={lasts(ms)}>
        {say}
      </span>
    </p>
  );
}
