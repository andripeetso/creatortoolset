// @vitest-environment happy-dom
import { act, createElement, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewPlayPlan } from "./plugin";
import { usePlanFollow } from "./review-play";

// The player's own follower (the page's hook), mounted in a DOM with a stand-in <video>: a plan's skip, hold and the
// viewer's controls, which is what the page does while a plug-in's preview plays.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FakeVideo = { currentTime: number; paused: boolean; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> };

function fakeVideo(): FakeVideo {
  const v: FakeVideo = { currentTime: 0, paused: true, play: vi.fn(), pause: vi.fn() };
  v.play.mockImplementation(() => {
    v.paused = false;
    return Promise.resolve();
  });
  v.pause.mockImplementation(() => {
    v.paused = true;
  });
  return v;
}

const plan: ReviewPlayPlan = {
  fps: 25,
  skips: [[50, 75]],
  mutes: [],
  holds: [{ at: 200, frames: 10 }],
  cards: [],
  frames: [],
};

let root: Root;
let host: HTMLDivElement;
let video: FakeVideo;
let ref: RefObject<HTMLVideoElement | null>;
let follow: { holding: number; endHold: () => void };

function Player(props: { plan: ReviewPlayPlan | null; time: number; playing: boolean }) {
  follow = usePlanFollow(ref, props.plan, props.time, props.playing);
  return null;
}

const show = (props: { plan: ReviewPlayPlan | null; time: number; playing: boolean }) =>
  act(() => root.render(createElement(Player, props)));

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  video = fakeVideo();
  ref = { current: video as unknown as HTMLVideoElement };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("the page's player follows a plan", () => {
  it("jumps the playhead over a skipped span as it reaches it", () => {
    show({ plan, time: 10 / 25, playing: true });
    expect(video.currentTime).toBe(0);
    show({ plan, time: 51 / 25, playing: true });
    expect(video.currentTime).toBe(75 / 25);
  });

  it("does nothing when the plan is cleared or the video is paused", () => {
    show({ plan: null, time: 10 / 25, playing: true });
    show({ plan: null, time: 51 / 25, playing: true });
    expect(video.currentTime).toBe(0);
    show({ plan, time: 10 / 25, playing: false });
    show({ plan, time: 51 / 25, playing: false });
    expect(video.currentTime).toBe(0);
  });

  it("holds on the named frame, shows the frames to go, then plays on", () => {
    show({ plan, time: 199 / 25, playing: true });
    show({ plan, time: 200 / 25, playing: true });
    expect(video.paused).toBe(true);
    expect(video.currentTime).toBeCloseTo(200.5 / 25);
    expect(follow.holding).toBe(10);
    act(() => vi.advanceTimersByTime(400));
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(follow.holding).toBe(0);
  });

  it("does not resume a hold after the viewer ends it (a pause or seek during the hold)", () => {
    show({ plan, time: 199 / 25, playing: true });
    show({ plan, time: 200 / 25, playing: true });
    act(() => follow.endHold());
    act(() => vi.advanceTimersByTime(1000));
    expect(video.play).not.toHaveBeenCalled();
    expect(follow.holding).toBe(0);
  });

  it("does not resume a hold after the viewer has moved the picture, even if the hold was not ended", () => {
    show({ plan, time: 199 / 25, playing: true });
    show({ plan, time: 200 / 25, playing: true });
    video.currentTime = 3; // a seek the page did not register as a control
    act(() => vi.advanceTimersByTime(1000));
    expect(video.play).not.toHaveBeenCalled();
  });
});
