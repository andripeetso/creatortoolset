import { expect, it } from "vitest";
import { cpuProfile } from "./cpu-profile";

it("names the function that keeps the thread busy, and an idle thread as idle", async () => {
  // busy for the whole window: a timer that spins 20 ms of every 25
  const spin = () => {
    const end = Date.now() + 20;
    while (Date.now() < end);
  };
  const t = setInterval(function busyLoopForTheTest() {
    spin();
  }, 25);
  const busy = await cpuProfile(400).finally(() => clearInterval(t));
  expect(busy.top.some((p) => p.path.some((f) => f.startsWith("busyLoopForTheTest") || f.startsWith("spin")))).toBe(true);
  expect(busy.idle).toBeLessThan(60);

  const quiet = await cpuProfile(300);
  expect(quiet.idle).toBeGreaterThan(50);
});
