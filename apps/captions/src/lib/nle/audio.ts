let shared: AudioContext | null = null;

/** The editor's one sound engine, woken: call it from a click or a key so the browser lets it play. */
export function nleAudio(): AudioContext | null {
  try {
    shared ??= new AudioContext();
    void shared.resume();
    return shared;
  } catch {
    return null;
  }
}

/** The sound engine if one was made. */
export const runningAudio = () => shared;
