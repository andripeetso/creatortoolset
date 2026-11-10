import { describe, expect, it } from "vitest";
import { historyOf, recordResult } from "./automations";
import type { Automation, AutomationResult } from "../contracts/automations";

const base: Automation = {
  id: "a",
  name: "Check",
  prompt: "List things.",
  schedule: { kind: "daily", at: "09:00" },
  enabled: true,
  timezone: "UTC",
  createdAt: 0,
};
const result = (at: number): AutomationResult => ({ at, status: "done", text: `run ${at}` });

describe("Earlier runs", () => {
  it("keeps the newest five, newest first, and the newest is lastResult", () => {
    const a = { ...base };
    for (let n = 1; n <= 7; n++) recordResult(a, result(n));
    expect(historyOf(a).map((r) => r.at)).toEqual([7, 6, 5, 4, 3]);
    expect(a.lastResult?.at).toBe(7);
  });

  it("the first run is the only entry", () => {
    const a = { ...base };
    recordResult(a, result(1));
    expect(historyOf(a)).toEqual([result(1)]);
  });

  it("a task saved before history keeps its old result under the new one", () => {
    const a = { ...base, lastResult: result(1) };
    recordResult(a, result(2));
    expect(historyOf(a).map((r) => r.at)).toEqual([2, 1]);
  });

  it("a task saved before history existed shows its lastResult, and none when it never ran", () => {
    expect(historyOf({ ...base, lastResult: result(2) })).toEqual([result(2)]);
    expect(historyOf({ ...base })).toEqual([]);
  });
});
