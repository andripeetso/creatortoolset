import { describe, expect, it } from "vitest";
import type { LibraryMade } from "@contracts/library";
import { costWords, engineLine, makeWhat, missingWhy, stateOf } from "./Made";

const m = (o: Partial<LibraryMade>): LibraryMade => ({ kind: "fingerprint", have: 0, missing: 0, queued: 0, cost: "free", ...o });

describe("What's made: a kind's state at a glance", () => {
  it("failed first, then waiting with what for or which computer, then off, missing, done", () => {
    expect(stateOf(m({ have: 3, failed: 2, queued: 1 }), true)).toEqual({ tone: "failed", text: "2 files failed" });
    expect(stateOf(m({ queued: 19, by: "Studio Mac" }), true)).toEqual({ tone: "waiting", text: "19 files queued for Studio Mac" });
    expect(stateOf(m({ queued: 1, why: "Studio Mac is offline" }), true)).toEqual({ tone: "waiting", text: "1 file waiting: Studio Mac is offline" });
    expect(stateOf(m({ queued: 4 }), true).text).toBe("4 files queued");
    expect(stateOf(m({ missing: 5, needs: "Needs a Gemini API key" }), true)).toEqual({ tone: "waiting", text: "Needs a Gemini API key" });
    expect(stateOf(m({ have: 2, missing: 300 }), false)).toEqual({ tone: "off", text: "Off for new files · 300 missing" });
    expect(stateOf(m({ missing: 3, failed: 1, needs: "Needs a Deepgram key" }), false).tone).toBe("off"); // off counts for nothing
    expect(stateOf(m({ have: 2, missing: 3 }), true)).toEqual({ tone: "waiting", text: "Not made for 3 files" });
    expect(stateOf(m({ missing: 1 }), true, true).text).toBe("1 file not sorted yet");
    expect(stateOf(m({ have: 475 }), true)).toEqual({ tone: "done", text: "Done" });
    expect(stateOf(m({}), true)).toEqual({ tone: "off", text: "No files of this kind" });
  });

  it("says what runs it, what the missing cost, why they are missing and what Make does, before anything is pressed", () => {
    expect(engineLine(m({ engine: "Deepgram nova-3", where: "Deepgram" }))).toBe("Deepgram nova-3 on Deepgram");
    expect(costWords(m({ cost: "paid", usd: 1.2, where: "Deepgram" }))).toBe("about $1.20");
    expect(costWords(m({ cost: "tokens", usd: 3, where: "the AI provider sign-in" }))).toBe("about $3.00 of usage at API prices, counted toward the plan's limits");
    expect(costWords(m({ cost: "free", minutes: 12, where: "Studio Mac" }))).toBe("free, about 12 min on Studio Mac");
    expect(costWords(m({ cost: "paid", needs: "Needs a Deepgram key" }))).toBe("Needs a Deepgram key");
    expect(missingWhy(m({ missing: 838, broll: 700, skipped: { n: 120, why: "no sound, or music" } }))).toBe("838 files never made, mostly B-roll · 120 files skipped: no sound, or music");
    expect(missingWhy(m({ missing: 10, broll: 2 }))).toBe("10 files never made");
    expect(makeWhat(m({ missing: 21, where: "Studio Mac" }))).toBe("queues 21 jobs that run on Studio Mac, and Cancel takes off the ones still waiting");
  });
});
