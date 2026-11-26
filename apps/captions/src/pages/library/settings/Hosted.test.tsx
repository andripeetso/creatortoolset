// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { LIBRARY_WORDS, type HostedMix } from "@contracts/library";
import { HostedSwitches } from "./Hosted";

// Blur faces in Hosted media (BA PRD P2.1): the owner's switch; on, Proxies reads Blurred and Originals is not offered.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ALL: HostedMix = { finals: true, proxies: true, originals: true };
function draw(blurFaces: boolean | undefined, onBlurFaces?: (on: boolean, m: HostedMix) => void, proxies?: boolean, value = ALL) {
  const el = document.createElement("div");
  document.body.append(el);
  act(() => createRoot(el).render(<HostedSwitches value={value} onChange={() => {}} blurFaces={blurFaces} onBlurFaces={onBlurFaces} proxies={proxies} />));
  return el;
}
const rows = (el: HTMLElement) => [...el.querySelectorAll('[role="switch"]')].map((s) => s.getAttribute("aria-label"));

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

  it("Proxies shows only while Generate proxies is on, with Blur faces or without", () => {
    expect(rows(draw(false, undefined, true))).toEqual(["Upload to server", "Final exports", "Proxies", "Originals"]);
    const noProxies = { ...ALL, proxies: false };
    expect(rows(draw(false, undefined, false, noProxies))).toEqual(["Upload to server", "Final exports", "Originals"]);
    expect(rows(draw(true, undefined, true))).toEqual(["Upload to server", "Final exports", "Blurred", "Proxies"]);
    expect(rows(draw(true, undefined, false, noProxies))).toEqual(["Upload to server", "Final exports", "Blurred"]);
    // a library from before, its Proxies part stored on with Generate proxies off: the row stays, so it can be turned off
    expect(rows(draw(false, undefined, false))).toEqual(["Upload to server", "Final exports", "Proxies", "Originals"]);
  });

  it("the master on again brings back the mix without Proxies, where Generate proxies went off meanwhile", () => {
    const seen: HostedMix[] = [];
    function Held({ proxies }: { proxies: boolean }) {
      const [m, setM] = useState(ALL);
      return <HostedSwitches value={m} onChange={(x) => (seen.push(x), setM(x))} proxies={proxies} />;
    }
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    const master = () => act(() => el.querySelector<HTMLElement>('[aria-label="Upload to server"]')!.click());
    act(() => root.render(<Held proxies />));
    master();
    act(() => root.render(<Held proxies={false} />));
    master();
    expect(seen.at(-1)).toEqual({ finals: true, proxies: false, originals: true });
  });

  it("the master on again never brings back Originals over a Blur faces switch: the part means another thing then", () => {
    const seen: HostedMix[] = [];
    function Held({ blurFaces }: { blurFaces: boolean }) {
      const [m, setM] = useState(ALL);
      return <HostedSwitches value={m} onChange={(x) => (seen.push(x), setM(x))} blurFaces={blurFaces} />;
    }
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    const master = () => act(() => el.querySelector<HTMLElement>('[aria-label="Upload to server"]')!.click());
    act(() => root.render(<Held blurFaces />)); // Blurred on (the Originals part)
    master(); // off
    act(() => root.render(<Held blurFaces={false} />)); // Blur faces off meanwhile
    master(); // on again
    expect(seen.at(-1)).toEqual({ finals: true, proxies: true, originals: false });
  });

  it("turning it on turns Originals off with it", () => {
    const flip = vi.fn();
    const el = draw(false, flip);
    act(() => el.querySelector<HTMLElement>(`[aria-label="${LIBRARY_WORDS.blurFaces.label}"]`)!.click());
    expect(flip).toHaveBeenCalledWith(true, { finals: true, proxies: true, originals: false });
  });
});
