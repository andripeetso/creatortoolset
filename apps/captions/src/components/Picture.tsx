import { useState, type ImgHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * A card picture that never moves the layout and never pops in: the parent box sets the size (aspect class or
 * width/height), the box shows a quiet fill until the picture is decoded, then the picture fades in over 150 ms.
 * A cached picture is already complete on mount, so it shows on the first frame with no fade.
 * A missing picture leaves the fill (no broken-image icon).
 */
export function Picture({ className, onLoad, onError, ...img }: ImgHTMLAttributes<HTMLImageElement>) {
  const [state, setState] = useState<"wait" | "shown" | "failed">("wait");
  return (
    <img
      decoding="async"
      loading="lazy"
      draggable={false}
      {...img}
      ref={(el) => {
        if (el?.complete && el.naturalWidth > 0 && state === "wait") setState("shown");
      }}
      onLoad={(e) => {
        setState("shown");
        onLoad?.(e);
      }}
      onError={(e) => {
        setState("failed");
        onError?.(e);
      }}
      className={cn(
        "transition-opacity duration-150",
        state === "shown" ? "opacity-100" : "opacity-0",
        className,
      )}
    />
  );
}
