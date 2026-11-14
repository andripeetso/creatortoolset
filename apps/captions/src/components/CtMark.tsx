import { createLucideIcon } from "lucide-react";

/**
 * The app's own mark, drawn as a line icon: the C whose top runs into the T's bar (the app icon's "CT, one stroke").
 * It marks what the AI writes or makes for you, in place of a generic sparkle.
 */
export const CtMark = createLucideIcon("CtMark", [
  ["path", { d: "M10 5a7 7 0 1 0 3.5 13.06", key: "c" }],
  ["path", { d: "M10 5h11", key: "bar" }],
  ["path", { d: "M16.5 5v15", key: "stem" }],
]);
