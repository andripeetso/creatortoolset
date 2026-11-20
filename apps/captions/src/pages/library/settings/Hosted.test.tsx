// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { LIBRARY_WORDS, type HostedMix } from "@contracts/library";
import { HostedSwitches } from "./Hosted";

// Blur faces in Hosted media (BA PRD P2.1): the owner's switch; on, Proxies reads Blurred and Originals is not offered.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ALL: HostedMix = { finals: true, proxies: true, originals: true };
function draw(blurFaces: boolean | undefined, onBlurFaces?: (on: boolean, m: HostedMix) => void) {
  const el = document.createElement("div");
  document.body.append(el);
  act(() => createRoot(el).render(<HostedSwitches value={ALL} onChange={() => {}} blurFaces={blurFaces} onBlurFaces={onBlurFaces} />));
  return el;
}

describe("HostedSwitches and Blur faces", () => {
  it("shows the switch only to whoever may change it, and Originals only while it is off", () => {
    const off = draw(false, () => {});
    expect(off.textContent).toContain(LIBRARY_WORDS.blurFaces.label);
    expect(off.textContent).toContain(LIBRARY_WORDS.originals);
    expect(draw(false).textContent).not.toContain(LIBRARY_WORDS.blurFaces.label);
    const on = draw(true, () => {});
    expect(on.textContent).toContain(LIBRARY_WORDS.blurred);
    expect(on.textContent).not.toContain(LIBRARY_WORDS.originals);
  });

  it("turning it on turns Originals off with it", () => {
    const flip = vi.fn();
    const el = draw(false, flip);
    act(() => el.querySelector<HTMLElement>(`[aria-label="${LIBRARY_WORDS.blurFaces.label}"]`)!.click());
    expect(flip).toHaveBeenCalledWith(true, { finals: true, proxies: true, originals: false });
  });
});
