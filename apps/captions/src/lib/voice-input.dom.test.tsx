// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useVoiceInput } from "./voice-input";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.unstubAllGlobals());

it("a second tap while the browser asks for the mic starts no second recording, and leaving then lets go of the mic", async () => {
  let give: (s: MediaStream) => void = () => {};
  const getUserMedia = vi.fn(() => new Promise<MediaStream>((r) => (give = r)));
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  const recorder = vi.fn();
  vi.stubGlobal("MediaRecorder", recorder);
  let voice!: ReturnType<typeof useVoiceInput>;
  const Mic = ({ got }: { got: (v: ReturnType<typeof useVoiceInput>) => void }) => (got(useVoiceInput(() => {})), null);
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Mic, { got: (v) => (voice = v) })));
  await act(async () => {
    voice.toggle();
    voice.toggle();
  });
  expect(getUserMedia).toHaveBeenCalledTimes(1);

  await act(async () => root.unmount());
  const stop = vi.fn();
  await act(async () => give({ getTracks: () => [{ stop }] } as unknown as MediaStream));
  expect(stop).toHaveBeenCalled();
  expect(recorder).not.toHaveBeenCalled();
});
