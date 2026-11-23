// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPRITE_FRAMES, type AssetCard } from "@contracts/library";
import { renderToStaticMarkup } from "react-dom/server";
import { AssetRow, AssetTile, fileLine, frameAt, frameStyle, intoColumns, masonryColumns } from "./ClipCards";
import { GalleryTile } from "./Gallery";

// A mouse across a video card's picture shows the clip there from its strip of frames; leaving shows the picture again.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// a strip "loads" at once in its frame shape: 16:9, 9:16 for a URL with "tall", never for one with "slow"
class FakeImage {
  onload: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  set src(url: string) {
    if (url.includes("slow")) return;
    const [w, h] = url.includes("tall") ? [9, 16] : [16, 9];
    [this.naturalWidth, this.naturalHeight] = [w * 10 * SPRITE_FRAMES, h * 10];
    this.onload?.();
  }
}
Object.assign(globalThis, { Image: FakeImage, IntersectionObserver: undefined });
const x = (el: HTMLElement) => parseFloat(el.style.backgroundPosition);

const card: AssetCard = {
  id: "a1", libraryId: "lib", kind: "video", title: "Beach run", versionId: "v1", versionN: 1, durationS: 40,
  thumbUrl: "/api/library/media/v1/thumb", spriteUrl: "/api/library/media/v1/sprite", tags: [], aiTags: [], state: "ready",
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const picture = () => host.querySelector("button > div") as HTMLDivElement;
const scrub = () => host.querySelector<HTMLDivElement>("[data-scrub]");
const point = (type: string, clientX: number, pointerType = "mouse") =>
  act(() => {
    picture().dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, pointerType, relatedTarget: type === "pointerout" ? document.body : null }));
  });

function show(a: AssetCard) {
  act(() => root.render(<AssetTile asset={a} onOpen={() => {}} />));
  picture().getBoundingClientRect = () => ({ left: 100, width: 200, top: 0, height: 112, right: 300, bottom: 112, x: 100, y: 0, toJSON() {} });
  act(() => void picture().dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }))); // the strip loads on the first hover
}

describe("a card's hover scrub", () => {
  it("shows the frame under the pointer from the one strip, and the thumbnail again on leaving", () => {
    show(card);
    expect(scrub()).toBeNull();
    point("pointermove", 250); // three quarters across
    expect(scrub()!.style.backgroundImage).toContain("/api/library/media/v1/sprite");
    expect(x(scrub()!)).toBeCloseTo((15 / (SPRITE_FRAMES - 1)) * 100);
    expect(scrub()!.style.backgroundSize).toBe("auto 100%");
    point("pointermove", 100);
    expect(x(scrub()!)).toBeCloseTo(0);
    point("pointerout", 400);
    expect(scrub()).toBeNull();
    expect(host.querySelector("img")!.getAttribute("src")).toBe(card.thumbUrl);
  });

  it("nothing on touch, on a clip without a strip, or on a photo", () => {
    show(card);
    point("pointermove", 250, "touch");
    expect(scrub()).toBeNull();
    for (const a of [{ ...card, spriteUrl: undefined }, { ...card, kind: "image" as const }]) {
      show(a);
      point("pointermove", 250);
      expect(scrub()).toBeNull();
    }
  });

  it("the picture stays until the strip is here", () => {
    show({ ...card, spriteUrl: "/api/library/media/v1/sprite?slow" });
    point("pointermove", 250);
    expect(scrub()).toBeNull();
  });

  it("never stretches a frame: it fills the box the way the picture does", () => {
    // an upright frame in a 16:9 card: as wide as the card, its middle in view
    expect(frameStyle("s", 5, 9 / 16, 16 / 9)).toMatchObject({ backgroundSize: `${SPRITE_FRAMES * 100}% auto`, backgroundPosition: `${(5 / (SPRITE_FRAMES - 1)) * 100}% 50%` });
    // a 16:9 frame (a strip made before frames kept their shape) in an upright 3:4 tile: as tall as the tile, frame i's middle
    // at the tile's middle, so the image's left edge sits (i + 0.5) frames left of the middle
    const s = frameStyle("s", 7, 16 / 9, 3 / 4);
    expect(s.backgroundSize).toBe("auto 100%");
    const p = parseFloat(String(s.backgroundPosition)) / 100;
    expect((3 / 4 - SPRITE_FRAMES * (16 / 9)) * p).toBeCloseTo(3 / 8 - 7.5 * (16 / 9));
  });

  it("an upright clip's strip in a Gallery tile, with no hover text over its frames", () => {
    const tall = { ...card, width: 1080, height: 1920, spriteUrl: "/api/library/media/v1/sprite?tall" };
    act(() => root.render(<GalleryTile asset={tall} onOpen={() => {}} ownShape={false} />));
    const tile = host.querySelector("button")!;
    expect(tile.hasAttribute("title")).toBe(false);
    tile.getBoundingClientRect = () => ({ left: 0, width: 150, top: 0, height: 200, right: 150, bottom: 200, x: 0, y: 0, toJSON() {} });
    act(() => void tile.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" })));
    act(() => void tile.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 0, pointerType: "mouse" })));
    expect(scrub()!.style.backgroundSize).toBe(`${SPRITE_FRAMES * 100}% auto`);
  });

  it("maps the pointer to a frame, the right edge to the last", () => {
    expect([0, 0.049, 0.05, 0.5, 0.999, 1].map(frameAt)).toEqual([0, 0, 1, 10, 19, 19]);
  });
});

describe("photo columns", () => {
  it("each photo to the shortest column; a page that comes in after never moves what is shown", () => {
    const tall = (h: number) => h;
    const first = intoColumns([2, 1, 1, 1], 3, tall);
    expect(first).toEqual([[2], [1, 1], [1]]);
    const more = intoColumns([2, 1, 1, 1, 0.5, 0.5], 3, tall);
    expect(more.map((c, i) => c.slice(0, first[i]!.length))).toEqual(first);
  });
});

describe("a card's line about its file", () => {
  const at = (c: Partial<AssetCard>) => ({ ...card, state: "ready", ...c }) as AssetCard;
  it("says the place word, and never missing for a file nobody has looked for", () => {
    expect(fileLine(at({ state: "missing", placeWord: { word: "unchecked" } }))).toBe("Not checked yet");
    expect(fileLine(at({ placeWord: { word: "unchecked" } }))).toBeNull();
    expect(fileLine(at({ placeWord: { word: "disk_away", disk: "Tiny Drive" } }))).toBe("Tiny Drive isn't connected");
    expect(fileLine(at({ placeWord: { word: "missing", computer: "Tiny Studio Mac" } }))).toBe("Missing on Tiny Studio Mac");
    expect(fileLine(at({ placeWord: { word: "here" } }))).toBeNull();
    expect(fileLine(at({ state: "missing" }))).toBe("File not found"); // a server without place rows
  });

  it("marks a clip on this computer from its place word", () => {
    expect(renderToStaticMarkup(<AssetRow asset={at({ placeWord: { word: "here" } })} onOpen={() => {}} />)).toContain('aria-label="On this computer"');
    expect(renderToStaticMarkup(<AssetRow asset={at({ placeWord: { word: "folder_not_found" } })} onOpen={() => {}} />)).toContain("Folder not found, re-point?");
  });
});

describe("a photo with no picture", () => {
  const photo: AssetCard = { ...card, kind: "image", title: "Cartwheel.heic", durationS: undefined, thumbUrl: undefined, spriteUrl: undefined };
  it("says No picture yet, once, on a photo that is in; nothing while it is being prepared or once it has one", () => {
    show(photo);
    expect(host.textContent?.match(/No picture yet/g)).toHaveLength(1);
    show({ ...photo, state: "processing" });
    expect(host.textContent).not.toContain("No picture yet");
    show({ ...photo, thumbUrl: "/api/library/media/v1/thumb" });
    expect(host.textContent).not.toContain("No picture yet");
    show({ ...card, thumbUrl: undefined });
    expect(host.textContent).not.toContain("No picture yet");
  });
});

describe("masonryColumns", () => {
  it("fits columns of the slider's size, never fewer than two", () => {
    expect(masonryColumns(1200, 100)).toBe(10);
    expect(masonryColumns(1200, 400)).toBe(2);
    expect(masonryColumns(300, 400)).toBe(2);
  });
});
