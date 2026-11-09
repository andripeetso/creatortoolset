import { useState } from "react";
import { Download, Loader2, Smartphone } from "lucide-react";
import { markdownToPlain } from "@/lib/inline-markdown";
import { shareDeliveryUrl, shareDeliveriesZipUrl, type ShareDelivery } from "@/lib/workshop";
import { CopyButton } from "./CopyButton";

/**
 * The finals a freelancer delivered on a Workshop link, in slide order. On a phone "Save all to phone" fetches them
 * and opens the share sheet (Save to Photos); elsewhere, and where the share
 * sheet can't take files, it's one ZIP, which the iPhone app unpacks into Photos.
 */
const TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", gif: "image/gif", mp4: "video/mp4", mov: "video/quicktime", m4v: "video/mp4" };
const typeOf = (d: ShareDelivery) => (d.type && d.type !== "application/octet-stream" ? d.type : TYPES[d.name.split(".").pop()?.toLowerCase() ?? ""] ?? d.type);
const isVideo = (d: ShareDelivery) => typeOf(d).startsWith("video/");
const isImage = (d: ShareDelivery) => typeOf(d).startsWith("image/");

function shareSheetTakesFiles(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.canShare !== "function") return false;
  if (!window.matchMedia("(pointer: coarse)").matches) return false; // a computer gets the ZIP
  try {
    return navigator.canShare({ files: [new File([""], "x.jpg", { type: "image/jpeg" })] });
  } catch {
    return false;
  }
}

export function SaveAllButton({ token, files, className = "" }: { token: string; files: ShareDelivery[]; className?: string }) {
  const [ready, setReady] = useState<File[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const btn = `flex items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-[13px] font-medium text-white hover:bg-violet-500 disabled:opacity-60 ${className}`;
  if (!shareSheetTakesFiles()) {
    return (
      <a href={shareDeliveriesZipUrl(token)} className={btn}>
        <Download className="h-4 w-4" /> {window.matchMedia("(pointer: coarse)").matches ? "Save all to phone" : `Download all (${files.length})`}
      </a>
    );
  }
  const save = async () => {
    setError(null);
    if (ready) {
      await navigator.share({ files: ready }).catch((e: unknown) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) setError(e instanceof Error ? e.message : String(e));
      });
      return;
    }
    // two taps: fetching takes longer than the share sheet waits for the tap that opened it
    try {
      const got: File[] = [];
      for (const [i, d] of files.entries()) {
        setBusy(`Getting ${i + 1} of ${files.length}…`);
        const r = await fetch(shareDeliveryUrl(token, d.id));
        if (!r.ok) throw new Error(`${d.name}: HTTP ${r.status}`);
        got.push(new File([await r.blob()], d.name, { type: typeOf(d) }));
      }
      setReady(got);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <button type="button" disabled={!!busy} onClick={() => void save()} className={btn}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Smartphone className="h-4 w-4" />} {busy ?? (ready ? `Save ${files.length} to Photos` : "Save all to phone")}
      </button>
      {ready && !busy ? <p className="text-center text-[11px] text-zinc-500">Ready: tap again, then Save to Photos.</p> : null}
      {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
    </div>
  );
}

export function FinalsGallery({ token, files, className = "grid-cols-2 sm:grid-cols-3" }: { token: string; files: ShareDelivery[]; className?: string }) {
  return (
    <div className={`grid gap-2 ${className}`}>
      {files.map((d, i) => (
        <figure key={d.id} className="flex min-w-0 flex-col gap-1">
          <div className="relative overflow-hidden rounded-lg bg-black">
            {isVideo(d) ? (
              <video src={`${shareDeliveryUrl(token, d.id)}#t=0.1`} controls playsInline preload="metadata" className="aspect-[4/5] w-full object-cover" />
            ) : isImage(d) ? (
              <img src={shareDeliveryUrl(token, d.id)} alt={d.name} loading="lazy" className="aspect-[4/5] w-full object-cover" />
            ) : (
              <div className="flex aspect-[4/5] items-center justify-center p-2 text-center text-[11px] text-zinc-400">{d.name}</div>
            )}
            <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 text-[11px] tabular-nums text-white">{i + 1}</span>
          </div>
          <figcaption className="flex items-center gap-1 text-[11px] text-zinc-500">
            <span className="min-w-0 flex-1 truncate" title={d.note ? `${d.name}: ${d.note}` : d.name}>
              {d.name}
            </span>
            <a href={shareDeliveryUrl(token, d.id, true)} className="shrink-0 rounded p-1 hover:bg-zinc-800 hover:text-zinc-50" title="Download this one">
              <Download className="h-3.5 w-3.5" />
            </a>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

/** The post description as Instagram takes it (plain text, the **emphasis** marks dropped), with one big Copy. */
export function PostDescription({ text, title = "Post description" }: { text: string; title?: string }) {
  const plain = markdownToPlain(text);
  if (!plain) return null;
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-violet-500/40 bg-violet-500/[0.07] p-3">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-violet-300">{title}</span>
        <CopyButton
          text={() => plain}
          label="Copy"
          title="Copy the post description"
          className="ml-auto flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-violet-500"
        />
      </div>
      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-zinc-100">{plain}</p>
    </section>
  );
}
