import { describe, expect, it } from "vitest";
import { SAVED_SESSION_CHARS, fitSavedSession, type SavedSession } from "./workshop";

const message = (i: number) => ({ id: `m${i}`, role: "user", text: "x".repeat(2000), at: i, docId: "d" });
const snap = (messages: unknown[], blockText = "hook"): SavedSession =>
  ({
    session: { id: "s", title: "Tiny Acrobatics session" },
    docs: [{ id: "d", kind: "reel", blocks: [{ id: "b1", text: blockText }], versions: [] }],
    messages,
    activeDocId: "d",
  }) as unknown as SavedSession;

describe("fitSavedSession", () => {
  it("cuts a long chat to its newest messages that fit the cap", () => {
    const long = snap(Array.from({ length: 200 }, (_, i) => message(i)));
    const fit = fitSavedSession(long);
    expect(fit).not.toBeNull();
    expect(JSON.stringify(fit).length).toBeLessThanOrEqual(SAVED_SESSION_CHARS);
    expect(fit!.messages.at(-1)).toEqual(long.messages.at(-1));
    expect(fit!.messages.length).toBe(60);
  });

  it("keeps a short session whole", () => {
    const short = snap([message(1), message(2)]);
    expect(fitSavedSession(short)).toEqual(short);
  });

  it("gives up when the piece alone is over the cap", () => {
    expect(fitSavedSession(snap([], "y".repeat(SAVED_SESSION_CHARS + 1)))).toBeNull();
  });
});
