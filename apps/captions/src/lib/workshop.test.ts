import { describe, expect, it, vi } from "vitest";
import { putCached, readCached } from "./local-cache";
import { SAVED_SESSIONS, keepSession, sessionKeys } from "./workshop";
import { useAuth } from "./auth";

describe("keepSession", () => {
  it("keeps the most recent sessions' copies and drops the rest", () => {
    vi.spyOn(useAuth, "getState").mockReturnValue({ me: { username: "tiny" } } as never);
    const ids = Array.from({ length: SAVED_SESSIONS + 1 }, (_, i) => `s${i}`);
    for (const id of ids) {
      const k = sessionKeys(id);
      putCached("tiny", k.session, { id });
      putCached("tiny", k.docs, []);
      keepSession("tiny", id);
    }
    const oldest = sessionKeys(ids[0]!);
    expect(readCached("tiny", oldest.session)).toBeNull();
    expect(readCached("tiny", oldest.docs)).toBeNull();
    expect(readCached("tiny", sessionKeys(ids[1]!).session)).toEqual({ id: "s1" });
    keepSession("tiny", "s1"); // opened again: first in line, kept
    expect(readCached<string[]>("tiny", "workshop/saved")?.[0]).toBe("s1");
  });
});
