import { describe, expect, it } from "vitest";
import { fadePoints, isSoundFile, NleClock, PREROLL_S } from "./audio";

describe("nle sound fades", () => {
  it("ramps a clip up from silence and down to it, from where it starts playing", () => {
    const p = { dur: 10, gain: 0.5, fadeIn: 2, fadeOut: 4 };
    expect(fadePoints(p, 100, 0, 1)).toEqual([[100, 0], [102, 0.5], [106, 0.5], [110, 0]]);
    // started 1 s in, at double speed: half way up, the clock runs twice as fast
    expect(fadePoints(p, 100, 1, 2)).toEqual([[100.5, 0.25], [101, 0.5], [103, 0.5], [105, 0]]);
    // no fades: one point at its loudness
    expect(fadePoints({ dur: 10, gain: 1 }, 0, 3, 1)).toEqual([[3, 1]]);
  });
});

describe("the playhead's one clock", () => {
  const rig = () => {
    const w = { now: 100 };
    const engine = { state: "running", currentTime: 50, outputLatency: 0, baseLatency: 0 } as unknown as AudioContext & { currentTime: number; state: string };
    const clock = new NleClock(() => w.now, () => engine);
    return { w, engine, clock };
  };

  it("runs on the sound engine's time while there is sound: the pictures follow it, not the page's clock", () => {
    const { w, engine, clock } = rig();
    clock.sound = true;
    clock.seek(10);
    clock.play(1);
    clock.ready();
    expect(clock.leader).toBe(engine);
    // the page's clock runs on, the engine's doesn't: the playhead holds with the sound
    w.now += 1;
    expect(clock.now()).toBe(10);
    // the engine moves 1 s past its start lead: the playhead moves 1 s
    (engine as { currentTime: number }).currentTime += 0.03 + 1;
    expect(clock.now()).toBeCloseTo(11, 6);
    // sound for timeline second 12 is laid where the engine will be then
    expect(clock.engineTimeOf(12)).toBeCloseTo(50 + 0.03 + 2, 6);
  });

  it("runs on the page's clock with no sound, and moves to the engine's once it runs, without a jump", () => {
    const { w, engine, clock } = rig();
    (engine as { state: string }).state = "suspended";
    clock.sound = true;
    clock.play(1);
    clock.ready();
    expect(clock.leader).toBeNull();
    w.now += 2;
    expect(clock.now()).toBeCloseTo(2, 6);
    (engine as { state: string }).state = "running";
    let anchored = 0;
    clock.onAnchor(() => anchored++);
    expect(clock.tick()).toBeCloseTo(2, 6);
    expect(clock.leader).toBe(engine);
    expect(anchored).toBe(1);
  });

  it("Play waits for the pictures at the playhead, at most half a second", () => {
    const { w, clock } = rig();
    clock.seek(4);
    clock.play(1);
    expect(clock.state).toBe("waiting");
    w.now += 0.3;
    expect(clock.tick()).toBe(4);
    expect(clock.state).toBe("waiting");
    // the pictures are ready: it starts from where it waited
    clock.ready();
    expect(clock.state).toBe("running");
    w.now += 1;
    expect(clock.now()).toBeCloseTo(5, 6);
    // never ready: it starts anyway once half a second has gone
    clock.stop();
    clock.play(1);
    w.now += PREROLL_S - 0.01;
    clock.tick();
    expect(clock.state).toBe("waiting");
    w.now += 0.02;
    clock.tick();
    expect(clock.state).toBe("running");
  });

  it("tells a video file from a sound file", () => {
    expect(isSoundFile("ctlocal://media/Tiny/voice.m4a")).toBe(true);
    expect(isSoundFile("/m/song.WAV?x=1")).toBe(true);
    expect(isSoundFile("ctlocal://media/Tiny/IMG_0001.MOV")).toBe(false);
    expect(isSoundFile("/proxy/IMG_0001.mp4")).toBe(false);
  });
});
