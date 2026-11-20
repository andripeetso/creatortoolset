import type { CSSProperties, Ref, VideoHTMLAttributes } from "react";
import { Video, VideoPlayer, VideoSkin } from "@videojs/react/video";
import skinCss from "@videojs/react/video/skin.css?raw";

// The Mac app's WebKit (macOS 26) opens the skin's menus in the top layer but places them wrong from their anchor()
// insets: off the window (measured 11-19: the gear at y 775, its menu at y 937 of an 860 high window). There each menu
// is pinned above its own button as it opens, growing upward (the speed list is taller), its right edge on the button's.
// shortcut: placed once as it opens (the window resized with a menu open keeps the old spot); drop when WebKit fixes anchor()
const webkitOnly = typeof navigator !== "undefined" && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg/.test(navigator.userAgent);
// no toggle event reaches the page there: after any press in the player or its menus (a submenu draws its menu again),
// each open menu is placed by its button, looked for over half a second as the menu is drawn a moment after the press
const placeMenus = (tries: number) => {
  const open = [...document.querySelectorAll<HTMLElement>(".media-menu-popup:popover-open")];
  for (const pop of open) {
    const name = getComputedStyle(pop).getPropertyValue("position-anchor");
    const button = [...document.querySelectorAll<HTMLElement>(".media-skin button")].find((b) => getComputedStyle(b).getPropertyValue("anchor-name") === name);
    if (!button) continue;
    const b = button.getBoundingClientRect();
    const set = (bottom: number, right: number) => {
      for (const [k, v] of [["top", "auto"], ["left", "auto"], ["bottom", `${bottom}px`], ["right", `${Math.max(8, right)}px`]]) pop.style.setProperty(k!, v!, "important");
    };
    const bottom = innerHeight - b.top + 8;
    const right = innerWidth - b.right;
    set(bottom, right);
    // the menu's box sits a little off its insets (its own offsets): moved by what is left, so its edge meets the button's
    const r = pop.getBoundingClientRect();
    set(bottom + (r.bottom - (b.top - 8)), right + (r.right - b.right));
  }
  if (tries) setTimeout(placeMenus, 50, tries - 1);
};
if (webkitOnly) document.addEventListener("click", (e) => void (e.target instanceof Element && e.target.closest(".media-skin, .media-menu-popup") && placeMenus(10)), true);

// the skin's CSS uses the browser's own @layer, which the app's Tailwind 3 PostCSS step refuses: added as it ships, once
if (typeof document !== "undefined" && !document.getElementById("video-skin-css")) {
  const style = document.createElement("style");
  style.id = "video-skin-css";
  style.textContent = skinCss;
  document.head.append(style);
}

/**
 * The library viewer's video (11-19, Andri): Video.js's frosted skin around a plain <video>, so the element, its events
 * and its address are the ones ClipPlayer had: a dark bar with a preview frame over it on hover (the clip's strip, as
 * thumbs.vtt), the speed in the gear menu, its keys while the player has focus, and its own spinner after 500 ms of
 * waiting. Its own chunk: the page loads it when a clip opens.
 */
export const ACCENT = {
  // the workspace colour: every violet shade follows <html data-tint> (lib/workspace.ts), as the Library's other accents
  "--media-accent-color": "rgb(var(--violet-600))",
  "--media-accent-text-color": "white",
  // the whole clip, as the plain player showed it; the skin's own default crops it
  "--media-object-fit": "contain",
  "--media-object-position": "center",
  "--media-border-radius": "0",
} as CSSProperties;

export default function SkinPlayer({
  media,
  poster,
  thumbs,
  className,
  ...video
}: VideoHTMLAttributes<HTMLVideoElement> & { media: Ref<HTMLVideoElement>; poster?: string; thumbs?: string; className?: string }) {
  return (
    <VideoPlayer poster={poster}>
      <VideoSkin className={className} style={ACCENT}>
        {/* the box's whole height, the clip contained in it (an upright clip stands in the middle) */}
        <Video ref={media} playsInline preload="auto" className="h-full w-full" {...video}>
          {thumbs && <track kind="metadata" label="thumbnails" src={thumbs} default />}
        </Video>
      </VideoSkin>
    </VideoPlayer>
  );
}
