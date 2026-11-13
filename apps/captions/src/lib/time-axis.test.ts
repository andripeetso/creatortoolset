import { describe, expect, it } from "vitest";
import { clampZoom, fitPps, maxZoomOf, rulerMarks, scrollForZoom, scrollToFollow, sliderToZoom, zoomToSlider } from "./time-axis";

describe("the timelines' time axis", () => {
  it("fits the whole length into the scroller, less what stands before 0:00 and after the end", () => {
    expect(fitPps(680, 10, 72, 8)).toBe(60);
    expect(fitPps(100, 1000)).toBe(1); // a second never gets under a px
    expect(fitPps(600, 0)).toBe(6000); // no length yet: a tenth of a second
  });

  it("zooms from the whole length to the widest a second gets, and no further", () => {
    expect(maxZoomOf(60, 480)).toBe(8);
    expect(maxZoomOf(600, 480)).toBe(1); // already wider than that: it stays as it fits
    expect(clampZoom(0.4, 60, 480)).toBe(1);
    expect(clampZoom(3, 60, 480)).toBe(3);
    expect(clampZoom(50, 60, 480)).toBe(8);
  });

  it("a zoom keeps the playhead where it is on screen", () => {
    // 60 px a second at zoom 1, the playhead at 4 s, scrolled to 100: it shows at 72 + 240 - 100 = 212 px
    const v = { width: 680, scroll: 100, left: 72 };
    const to = scrollForZoom(v, 60, 1, 2, 4);
    expect(to).toBe(340);
    expect(72 + 4 * 60 * 2 - to).toBe(212);
    // and back out again
    expect(72 + 4 * 60 * 1 - scrollForZoom({ ...v, scroll: to }, 60, 2, 1, 4)).toBe(212);
  });

  it("a playhead out of view goes to the middle, and the scroll never goes before the start", () => {
    // at 0 s with the view scrolled to 500: under the label column, so it lands in the middle of what shows
    const v = { width: 680, scroll: 500, left: 72 };
    expect(scrollForZoom(v, 60, 2, 4, 0)).toBe(0);
    const far = scrollForZoom({ ...v, scroll: 0 }, 60, 1, 4, 30); // 30 s is past the right edge at zoom 1
    expect(72 + 30 * 60 * 4 - far).toBe(72 + (680 - 72) / 2);
  });

  it("follows the playhead only once it leaves the view, a third of the way in", () => {
    const v = { width: 600, scroll: 300, left: 0 };
    expect(scrollToFollow(v, 100, 5)).toBeNull(); // 500 px: in view
    expect(scrollToFollow(v, 100, 8.8)).toBeCloseTo(680, 6); // 880 px, past 300 + 600 - 24
    expect(scrollToFollow(v, 100, 2)).toBe(0); // 200 px, before the view: 200 - 200
    expect(scrollToFollow({ ...v, left: 72 }, 100, 3.5)).toBeNull(); // 72 + 350 is right of the label column
  });

  it("the ruler's marks stand at least 64 px apart, and only the ones near what shows are listed", () => {
    // 20 px a second: a mark every 5 s (100 px), to the end
    expect(rulerMarks(20, 24)).toEqual({ step: 5, at: [0, 5, 10, 15, 20] });
    // 400 px a second: every 0.2 s; of a 60 s length only what lies between 1000 and 1500 px
    expect(rulerMarks(400, 60, 1000, 1500)).toEqual({ step: 0.2, at: [2.4, 2.6, 2.8, 3, 3.2, 3.4, 3.6, 3.8] });
    // before the start and past the end
    expect(rulerMarks(100, 3, -500, 5000).at).toEqual([0, 1, 2, 3]);
    expect(rulerMarks(0, 10).at).toEqual([]); // no length on screen yet
    // a ten-minute cut at its widest lists a few marks, not thousands
    expect(rulerMarks(480, 600, 20000, 21500).at.length).toBeLessThan(30);
  });

  it("the zoom slider moves by the same share at each step and comes back to the same zoom", () => {
    expect(zoomToSlider(1, 8)).toBe(0);
    expect(zoomToSlider(8, 8)).toBe(1000);
    expect(zoomToSlider(2, 8)).toBe(333);
    expect(sliderToZoom(500, 16)).toBeCloseTo(4, 6);
    expect(zoomToSlider(3, 1)).toBe(0); // nothing to zoom
  });
});
