import { useEffect, useRef, useState, type RefObject } from "react";
import type { ReviewPlayPlan } from "./plugin";

// How the Review player follows a plug-in's play plan (ReviewPlayPlan, in frames at plan.fps). Pure: the page applies
// the result to its <video>. A skip is jumped over (the frames before its end are not shown); a hold stops on the frame
// it names, for `frames` frames, then plays on; the old cut plays as the render has it otherwise.

export type FollowAction =
  | { kind: "none" }
  | { kind: "seek"; to: number }
  | { kind: "hold"; to: number; frames: number };

/** `pos` and `was` are the playhead in seconds now and at the last check; the action's `to` is in seconds too. */
export function followPlan(plan: ReviewPlayPlan, pos: number, was: number): FollowAction {
  const fps = plan.fps || 25;
  const pf = pos * fps;
  const lastF = was * fps;
  const skip = plan.skips.find(([a, b]) => pf >= a - 1.01 && pf < b - 0.5);
  if (skip) return { kind: "seek", to: skip[1] / fps };
  const hold = plan.holds.find((h) => lastF < h.at - 0.01 && pf >= h.at - 0.01);
  if (hold) return { kind: "hold", to: (hold.at + 0.5) / fps, frames: hold.frames };
  return { kind: "none" };
}

/** Whether the picture is muted at `pos` seconds (a voice taken out on the timeline). */
export function mutedAt(plan: ReviewPlayPlan | null, pos: number): boolean {
  if (!plan) return false;
  const f = pos * (plan.fps || 25);
  return plan.mutes.some(([a, b]) => f >= a && f < b);
}

/**
 * The page's follower: while it plays, the video skips, holds and follows `plan` as the playhead reaches each span. A hold
 * pauses on its frame, shows `holding` frames to go on the chip, then plays on, but only while the viewer has not moved
 * (paused or sought away); `endHold` ends a hold at once and the page calls it on every control the viewer uses.
 */
export function usePlanFollow(
  video: RefObject<HTMLVideoElement | null>,
  plan: ReviewPlayPlan | null,
  time: number,
  playing: boolean,
): { holding: number; endHold: () => void } {
  const [holding, setHolding] = useState(0);
  const holdTimer = useRef(0);
  const lastT = useRef(0);
  const endHold = () => {
    window.clearTimeout(holdTimer.current);
    setHolding(0);
  };
  useEffect(() => {
    const el = video.current;
    const was = lastT.current;
    lastT.current = time;
    if (!plan || !playing || !el) return;
    const act = followPlan(plan, time, was);
    if (act.kind === "seek") {
      el.currentTime = act.to;
      lastT.current = act.to;
    } else if (act.kind === "hold") { // a longer shot: its frame stays up, silent, as the take would run on
      el.pause();
      el.currentTime = act.to;
      window.clearTimeout(holdTimer.current);
      setHolding(act.frames);
      holdTimer.current = window.setTimeout(() => {
        setHolding(0);
        if (el.paused && Math.abs(el.currentTime - act.to) < 0.05) void el.play();
      }, (act.frames / plan.fps) * 1000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the playhead; the plan is read as it is now
  }, [time]);
  useEffect(() => () => window.clearTimeout(holdTimer.current), []);
  return { holding, endHold };
}
