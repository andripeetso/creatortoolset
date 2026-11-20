import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge, validators } from "tailwind-merge"

// tailwind-merge 3 is made for Tailwind 4, where a bare `outline` is a width; on Tailwind 3 it is the solid style, so
// `outline outline-2` kept only the width and drew no outline (a picked layer's box on the Designer's canvas)
const twMerge = extendTailwindMerge({
  override: {
    classGroups: {
      "outline-w": [{ outline: [validators.isNumber, validators.isArbitraryVariableLength, validators.isArbitraryLength] }],
      "outline-style": [{ outline: ["", "solid", "dashed", "dotted", "double", "none", "hidden"] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
