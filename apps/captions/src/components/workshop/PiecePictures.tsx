import { useEffect, useState } from "react";
import { X } from "lucide-react";

/** One picture where its token sits in a field: the image, its label under it, × to take the token out, a click opens it large (Esc or a click closes it). */
export function InlinePicture({ alt, url, disabled, onRemove }: { alt: string; url: string; disabled: boolean; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  return (
    <figure className="group relative my-2 w-fit max-w-[50%]">
      <button type="button" onClick={() => setOpen(true)} title="Open the picture" className="block overflow-hidden rounded-lg border border-border bg-muted hover:border-foreground/30">
        <img src={url} alt={alt} loading="lazy" className="block max-h-44 max-w-full object-contain" />
      </button>
      {alt ? <figcaption className="mt-1 text-[11px] text-muted-foreground">{alt}</figcaption> : null}
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        title="Take this picture out of the text"
        aria-label="Remove picture"
        className="absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1 text-white opacity-0 hover:bg-black/80 group-hover:opacity-100 focus:opacity-100 disabled:hidden"
      >
        <X className="h-3 w-3" />
      </button>
      {open ? (
        <div role="dialog" aria-label={alt || "Picture"} className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6" onClick={() => setOpen(false)}>
          <img src={url} alt={alt} className="max-h-full max-w-full rounded-lg" />
        </div>
      ) : null}
    </figure>
  );
}
