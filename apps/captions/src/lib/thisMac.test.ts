import { afterEach, expect, it, vi } from "vitest";
import { allowOtherDevices } from "./thisMac";

const bridgeWith = (postMessage: (m: string) => Promise<unknown>) => vi.stubGlobal("window", { webkit: { messageHandlers: { thisMac: { postMessage } } } });

afterEach(() => vi.unstubAllGlobals());

it("asks the Mac app for access and shows what it answers, nothing when it is on", async () => {
  const asked: string[] = [];
  bridgeWith(async (m) => (asked.push(m), { aiOn: true, paired: true, problem: "Choose this computer's password to turn it on." }));
  expect(await allowOtherDevices()).toBe("Choose this computer's password to turn it on.");
  expect(asked).toEqual(["access"]);
  bridgeWith(async () => ({ aiOn: true, paired: true, problem: null }));
  expect(await allowOtherDevices()).toBeNull();
});

it("says what to do in a browser, where there is no Mac app", async () => {
  vi.stubGlobal("window", {});
  expect(await allowOtherDevices()).toContain("Creator Toolset Mac app");
});

it("says the app did not answer when the bridge fails", async () => {
  bridgeWith(async () => {
    throw new Error("gone");
  });
  expect(await allowOtherDevices()).toContain("did not answer");
});
