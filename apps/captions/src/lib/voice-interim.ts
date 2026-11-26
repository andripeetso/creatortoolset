/**
 * Words while the mic records: `run` writes down the audio so far, `show` gets its words. One pass is in flight at a
 * time (a pass still running when the next tick comes is skipped, so the person's computer is never queued up), and
 * stop() aborts the pass in flight and drops whatever it answers late. `run` returning null shows nothing this tick.
 */
export function interimWords(
  run: (signal: AbortSignal) => Promise<string | null>,
  show: (text: string) => void,
  every = 2000,
) {
  const ctl = new AbortController();
  let busy = false;
  const tick = async () => {
    if (busy || ctl.signal.aborted) return;
    busy = true;
    try {
      const text = await run(ctl.signal);
      if (text !== null && !ctl.signal.aborted) show(text);
    } catch {
      // an interim pass that fails shows nothing; the final pass says why
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), every);
  return {
    stop() {
      ctl.abort();
      clearInterval(timer);
    },
  };
}
