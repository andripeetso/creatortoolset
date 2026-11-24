// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLocalCache } from "@/lib/local-cache";
import { RETRY_MS, RootBoundary } from "./StaleBuild";

vi.mock("@/lib/local-cache", () => ({ clearLocalCache: vi.fn(() => Promise.resolve()) }));

// a screen that breaks while its data is bad (a reply cut off by the network) and draws once the data is good again
let bad = false;
function Screen() {
  if (bad) throw new TypeError("undefined is not an object (evaluating 'first.data?.items.map')");
  return <p>Clips</p>;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const draw = () => act(() => root.render(<RootBoundary><Screen /></RootBoundary>));

describe("RootBoundary", () => {
  it("draws the screen again by itself once its data is good, and on focus when the retry broke too", () => {
    bad = true;
    draw();
    expect(host.textContent).toContain("This screen stopped working");

    // the next refetch brings the good copy: the retry a few seconds later draws the screen
    bad = false;
    act(() => vi.advanceTimersByTime(RETRY_MS));
    expect(host.textContent).toBe("Clips");

    // broken again within the minute: no second timed retry, the Reload screen stays
    bad = true;
    draw();
    expect(host.textContent).toContain("This screen stopped working");
    bad = false;
    act(() => vi.advanceTimersByTime(RETRY_MS * 3));
    expect(host.textContent).toContain("This screen stopped working");

    // the person comes back to the window: it draws again
    act(() => window.dispatchEvent(new Event("focus")));
    expect(host.textContent).toBe("Clips");
  });

  it("Reload clears the saved lists first, so a bad saved copy can't break the screen again", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload, pathname: "/library" });
    bad = true;
    draw();
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Reload")!;
    await act(async () => button.click());
    expect(clearLocalCache).toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
