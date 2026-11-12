import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { CaptionRenderSurface } from "@/components/CaptionRenderSurface";
import { pagePicture } from "@/lib/design/picture";
import type { CaptionRenderSpec } from "@/lib/types";
import "./index.css";

interface CaptionRendererApi {
  setSpec(spec: CaptionRenderSpec): Promise<void>;
  renderAt(time: number): Promise<void>;
}

declare global {
  interface Window {
    captionRenderer: CaptionRendererApi;
    /** A design's page as a small picture, for the AI that designed it (api/lib/design-picture.ts). */
    designRenderer: { draw: typeof pagePicture };
  }
}

const fontFiles: [family: string, file: string, weight: number][] = [
  ["Anton", "Anton-Regular.ttf", 400],
  ["Archivo Black", "ArchivoBlack-Regular.ttf", 400],
  ["Bebas Neue", "BebasNeue-Regular.ttf", 400],
  ["Inter", "Inter-Bold.ttf", 700],
  ["Inter ExtraBold", "Inter-ExtraBold.ttf", 800],
  ["Montserrat", "Montserrat-Bold.ttf", 700],
  ["Montserrat SemiBold", "Montserrat-SemiBold.ttf", 600],
  ["Montserrat ExtraBold", "Montserrat-ExtraBold.ttf", 800],
  ["Oswald SemiBold", "Oswald-SemiBold.ttf", 600],
  ["Oswald", "Oswald-Bold.ttf", 700],
  ["Poppins", "Poppins-Bold.ttf", 700],
  // the Designer's own (src/lib/design/fonts.ts)
  ["Poppins Regular", "Poppins-Regular.ttf", 400],
  ["DM Serif Display", "DMSerifDisplay-Regular.ttf", 400],
  ["Caveat", "Caveat-Variable.ttf", 700],
];

// render.html is opened from dist/public via file://. These relative URLs
// deliberately point at the exact same bundled font files as the editor.
const base = new URL(".", window.location.href).href;
const reset = document.createElement("style");
reset.textContent =
  fontFiles
    .map(
      ([family, file, weight]) =>
        `@font-face{font-family:"${family}";src:url("${base}fonts/${file}");font-weight:${weight};font-display:block}`
    )
    .join("\n") +
  "\nhtml,body,#root{margin:0!important;width:100%;height:100%;overflow:hidden;background:transparent!important}";
document.head.append(reset);

const host = document.getElementById("root");
if (!host) throw new Error("Missing caption renderer root");
const root = createRoot(host);
let spec: CaptionRenderSpec | null = null;
let currentTime = 0;

function paint(): void {
  if (!spec) return;
  flushSync(() => {
    root.render(<CaptionRenderSurface spec={spec!} currentTime={currentTime} />);
  });
}

async function nextPaint(): Promise<void> {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
}

window.designRenderer = { draw: pagePicture };

window.captionRenderer = {
  async setSpec(next) {
    spec = next;
    currentTime = 0;
    paint();
    await document.fonts.ready;
    await Promise.all(
      fontFiles.map(([family, , weight]) =>
        document.fonts.load(`${weight} 100px "${family}"`)
      )
    );
    await nextPaint();
  },
  async renderAt(time) {
    currentTime = Math.max(0, time);
    paint();
    await nextPaint();
  },
};
