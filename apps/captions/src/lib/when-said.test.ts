import { describe, expect, it } from "vitest";
import { whenSaid } from "./when-said";

describe("whenSaid", () => {
  const now = new Date(2026, 10, 13, 18, 30).getTime();
  const clock = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  it("says the time alone today, with yesterday the day before, and the day further back", () => {
    const today = new Date(2026, 10, 13, 0, 5);
    expect(whenSaid(today.getTime(), now)).toBe(clock(today));
    const yesterday = new Date(2026, 10, 12, 23, 55);
    expect(whenSaid(yesterday.getTime(), now)).toBe(`yesterday at ${clock(yesterday)}`);
    const before = new Date(2026, 10, 3, 9, 0);
    expect(whenSaid(before.getTime(), now)).toMatch(new RegExp(`3.*${clock(before)}$`));
    expect(whenSaid(before.getTime(), now)).not.toMatch(/2026/);
  });

  it("names the year of a message from another year", () => {
    expect(whenSaid(new Date(2025, 11, 31, 12, 0).getTime(), now)).toMatch(/2025/);
  });
});
