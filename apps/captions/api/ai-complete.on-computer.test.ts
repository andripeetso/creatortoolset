import { expect, it } from "vitest";
import { completeWithFallback } from "./ai-complete";
import { turnOff, turnOn } from "./work/on-computer";

// On a computer, an AI call is the server's to answer: a Stop ends the wait at once, not when the server's answer comes.
it("an aborted call on a computer rejects as stopped while the server has not answered", async () => {
  turnOn({ ai: { analyzer: null, editor: null } } as never, {}, { ai: () => new Promise(() => {}) } as never);
  try {
    const stop = new AbortController();
    const call = completeWithFallback("system", "user", stop.signal, (t) => t);
    setTimeout(() => stop.abort(), 10);
    await expect(call).rejects.toMatchObject({ code: "ABORTED" });
  } finally {
    turnOff();
  }
});
