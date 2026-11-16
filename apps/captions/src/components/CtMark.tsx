import { createLucideIcon } from "lucide-react";

/**
 * The app's own mark as a small icon: a filled rounded tile with the app icon's C and T cut out of it.
 * It marks what the AI writes or makes for you, in place of a generic sparkle.
 */
export const CtMark = createLucideIcon("CtMark", [
  [
    "path",
    {
      d: "M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5Z M10.5 7.5H18V9.48H16.2V16.5H14.28V9.48H10.5A2.52 2.52 0 1 0 12.31 13.75L13.73 15.13A4.5 4.5 0 1 1 10.5 7.5Z",
      fill: "currentColor",
      fillRule: "evenodd",
      stroke: "none",
      key: "tile",
    },
  ],
]);
