/**
 * Words while the mic records: `run` writes down the audio so far, `show` gets its words. One pass is in flight at a
 * time (a pass still running when the next tick comes is skipped, so the person's computer is never queued up), a pass
 * is followed by a rest as long as it took, and stop() drops whatever a pass answers late. `run` returning null shows nothing this tick.
 */
export function interimWords(
  run: (signal: AbortSignal) => Promise<string | null>,
  show: (text: string) => void,
  every = 2000,
) {
  const ctl = new AbortController();
  let stopped = false;
  let running: Promise<void> | null = null;
  // each pass is followed by a rest as long as it took: the person's computer works at most half the time while they talk
  let restUntil = 0;
  const tick = () => {
    if (running || stopped || Date.now() < restUntil) return;
    const began = Date.now();
    running = (async () => {
      try {
        const text = await run(ctl.signal);
        if (text !== null && !stopped) show(text);
      } catch {
        // an interim pass that fails shows nothing; the final pass says why
      } finally {
        running = null;
        restUntil = Date.now() * 2 - began;
      }
    })();
  };
  const timer = setInterval(tick, every);
  return {
    /**
     * Stops the ticks and drops any late words. `finish`: the pass in flight runs to its end (it holds the person's
     * computer, which the final pass needs free), and the promise settles when it has; else it is aborted. The first
     * call decides.
     */
    stop(finish = false): Promise<void> {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
        if (!finish) ctl.abort();
      }
      return running ?? Promise.resolve();
    },
  };
}
