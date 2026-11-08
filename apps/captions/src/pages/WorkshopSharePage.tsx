import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { Check, CheckCircle2, ChevronRight, Copy, Download, Hammer, Loader2, Upload } from "lucide-react";
import { FinalsGallery, SaveAllButton } from "@/components/workshop/FinalsGallery";
import { PANEL, PANEL_HEAD, PANEL_TITLE, ShareAnswers } from "@/components/workshop/ShareAnswers";
import { CarouselSlideCard } from "@/components/workshop/carousel-cards";
import { layoutSourceHash, liveCompose } from "@/lib/carousel-layout";
import { resolveCarouselType, visualizeCarousel } from "@/lib/carousel-visualize";
import { markdownToClipboardHtml, markdownToHtml, markdownToPlain } from "@/lib/inline-markdown";
import { sessionStatusLabel, shareDeliveryUrl, type SessionStatus, type ShareDelivery, type ShareProgress, type SharedPiece } from "@/lib/workshop";

/**
 * A Content Workshop share link (/ws/:token). No account. Left: every piece's text to copy. Right: the
 * status and dates, the freelancer's mark, their uploads, the slide previews.
 * Once finals are uploaded they are the page: the files,
 * Save all to phone and the post description first, the slide text folded,
 * no generated previews. Signed in with access, the post's comments head the right sidebar (ShareAnswers). Server: api/workshop.ts workshopShareApp.
 */

interface ShareData {
  title: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  progress?: ShareProgress;
  deliveries: ShareDelivery[];
  pieces: SharedPiece[];
}

const KIND: Record<string, string> = { carousel: "Carousel", reel: "Reel", ad: "Ad", free: "Draft" };
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const size = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/** Copy with the emphasis kept where the paste target takes formatting (Canva, Docs), plain text elsewhere; `plain` = text only (Instagram has no formatting). */
async function copyRich(text: string, plainOnly = false) {
  const plain = markdownToPlain(text);
  if (plainOnly) return navigator.clipboard.writeText(plain);
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ "text/html": new Blob([markdownToClipboardHtml(text)], { type: "text/html" }), "text/plain": new Blob([plain], { type: "text/plain" }) }),
    ]);
  } catch {
    await navigator.clipboard.writeText(plain);
  }
}

function CopyText({ text, label = "Copy", plain = false }: { text: string; label?: string; plain?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void copyRich(text, plain).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1500);
        });
      }}
      className="flex shrink-0 items-center gap-1 rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-500 hover:text-zinc-50"
    >
      {done ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />} {done ? "Copied" : label}
    </button>
  );
}

function TextRow({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</span>
        <span className="ml-auto">
          <CopyText text={text} />
        </span>
      </div>
      {/* the same HTML the Copy button puts on the clipboard: line breaks kept, emphasis rendered, text escaped */}
      <div className="text-[15px] leading-relaxed text-zinc-100 [&_p+p]:mt-3" dangerouslySetInnerHTML={{ __html: markdownToHtml(text) }} />
    </div>
  );
}

function piecesSlides(piece: SharedPiece) {
  const type = resolveCarouselType(piece.carouselType);
  const blocks = piece.blocks.map((b) => ({ key: b.id, id: b.id, text: b.text }));
  const compose = liveCompose(piece.carouselLayouts, layoutSourceHash(type.id, blocks.map((b) => b.text)), blocks.length);
  return visualizeCarousel({ typeId: type.id, blocks, caption: piece.caption, compose }).slides.filter((s) => !s.ghost);
}

function Previews({ piece }: { piece: SharedPiece }) {
  const slides = useMemo(() => piecesSlides(piece), [piece]);
  if (!slides.length) return null;
  return (
    <div className="grid grid-cols-2 gap-2">
      {slides.map((s) => (
        <CarouselSlideCard key={s.key} slide={s} width={170} />
      ))}
    </div>
  );
}

function PieceText({ piece, numbered }: { piece: SharedPiece; numbered: boolean }) {
  const unit = piece.kind === "carousel" ? "Slide" : piece.kind === "ad" ? "Variant" : "Part";
  const all =
    piece.kind === "reel"
      ? [...piece.hooks.map((h, i) => `Hook ${i + 1}\n${h.text}`), piece.blocks.map((b) => b.text).join("\n\n")].join("\n\n")
      : piece.blocks.map((b, i) => `${unit} ${i + 1}\n${b.text}`).join("\n\n");
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2">
        {numbered ? <h2 className="text-base font-semibold text-zinc-50">{piece.title}</h2> : null}
        <span className="text-xs text-zinc-500">{KIND[piece.kind] ?? piece.kind}</span>
        <span className="ml-auto">
          <CopyText text={all} label={piece.kind === "carousel" ? "Copy all slides" : "Copy all"} />
        </span>
      </div>
      {piece.kind === "reel" ? (
        <>
          {piece.hooks.map((h, i) => (
            <TextRow key={h.id} label={`Hook ${i + 1}`} text={h.text} />
          ))}
          {piece.blocks.length ? <TextRow label="Script" text={piece.blocks.map((b) => b.text).join("\n\n")} /> : null}
        </>
      ) : (
        piece.blocks.map((b, i) => <TextRow key={b.id} label={`${unit} ${i + 1}`} text={b.text} />)
      )}
    </section>
  );
}

/** The post description, as it goes under the post: its own look, its length against Instagram's 2,200, its own Copy. */
function Caption({ piece }: { piece: SharedPiece }) {
  if (!piece.caption.trim() && !piece.pinned.trim()) return null;
  const n = piece.caption.length;
  return (
    <section className="rounded-xl border border-violet-500/40 bg-violet-500/[0.07] p-3">
      {piece.caption.trim() ? (
        <>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-violet-300">Post description</span>
            <span className={`text-[10px] tabular-nums ${n > 2200 ? "text-red-400" : "text-violet-300/60"}`}>{n.toLocaleString("en-US")} / 2,200</span>
            <span className="ml-auto">
              <CopyText text={piece.caption} plain />
            </span>
          </div>
          <p className="mb-1.5 text-[11px] text-zinc-500">Goes under the post, not on the slides.</p>
          <div className="text-[13px] leading-relaxed text-zinc-100 [&_p+p]:mt-2.5" dangerouslySetInnerHTML={{ __html: markdownToHtml(piece.caption) }} />
        </>
      ) : null}
      {piece.pinned.trim() ? (
        <div className={piece.caption.trim() ? "mt-3 border-t border-violet-500/20 pt-3" : ""}>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-violet-300">Pinned comment</span>
            <span className="ml-auto">
              <CopyText text={piece.pinned} plain />
            </span>
          </div>
          <div className="text-[13px] leading-relaxed text-zinc-100" dangerouslySetInnerHTML={{ __html: markdownToHtml(piece.pinned) }} />
        </div>
      ) : null}
    </section>
  );
}

/** The freelancer's side: who they are, their mark, their uploads. */
function Production({ token, data, onChange, list = true }: { token: string; data: ShareData; onChange: (patch: Partial<ShareData>) => void; list?: boolean }) {
  const [name, setName] = useState(() => localStorage.getItem("ws.name") ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const keepName = (v: string) => {
    setName(v);
    localStorage.setItem("ws.name", v);
  };
  const mark = async (state: "producing" | "done") => {
    setBusy(state);
    setError(null);
    try {
      const r = await fetch(`/api/workshop-share/${token}/progress`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state, by: name.trim() }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      const { progress } = (await r.json()) as { progress: ShareProgress };
      onChange({ progress, status: state === "done" ? "toPost" : "editing" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    const added: ShareDelivery[] = [];
    for (const f of Array.from(files)) {
      setBusy(`Uploading ${f.name}…`);
      try {
        const q = new URLSearchParams({ name: f.name, ...(name.trim() ? { by: name.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
        const r = await fetch(`/api/workshop-share/${token}/deliveries?${q}`, { method: "POST", headers: { "Content-Type": f.type || "application/octet-stream" }, body: f });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        added.push((await r.json()) as ShareDelivery);
      } catch (e) {
        setError(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
    }
    setBusy(null);
    setNote("");
    if (added.length) onChange({ deliveries: [...data.deliveries, ...added] });
  };
  const btn = "flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium disabled:opacity-50";
  return (
    <div className="flex flex-col gap-3">
      <input
        value={name}
        onChange={(e) => keepName(e.target.value)}
        placeholder="Your name"
        className="rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-[13px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
      />
      <div className="grid grid-cols-2 gap-2">
        <button type="button" disabled={!!busy} onClick={() => void mark("producing")} className={`${btn} ${data.progress?.state === "producing" ? "bg-amber-500 text-black" : "border border-amber-500/50 text-amber-200 hover:bg-amber-500/15"}`}>
          <Hammer className="h-3.5 w-3.5" /> I'm producing it
        </button>
        <button type="button" disabled={!!busy} onClick={() => void mark("done")} className={`${btn} ${data.progress?.state === "done" ? "bg-emerald-500 text-black" : "border border-emerald-500/50 text-emerald-200 hover:bg-emerald-500/15"}`}>
          <CheckCircle2 className="h-3.5 w-3.5" /> It's done
        </button>
      </div>
      {data.progress ? (
        <p className="text-[11px] text-zinc-500">
          {data.progress.state === "done" ? "Marked done" : "Marked in production"}
          {data.progress.by ? ` by ${data.progress.by}` : ""} · {when(data.progress.at)}
        </p>
      ) : null}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void upload(e.dataTransfer.files);
        }}
        className="flex flex-col gap-2 rounded-lg border border-dashed border-zinc-700 p-3"
      >
        <p className="text-[12px] text-zinc-300">{data.deliveries.length ? "Add more files or a new version. Drop files here." : "Upload the final version: the slides, the video, or both. Drop files here."}</p>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="A note with it (optional)" className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600" />
        <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => void upload(e.target.files)} />
        <button type="button" disabled={!!busy} onClick={() => fileRef.current?.click()} className={`${btn} bg-violet-600 text-white hover:bg-violet-500`}>
          {busy?.startsWith("Uploading") ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} {busy?.startsWith("Uploading") ? busy : "Choose files"}
        </button>
      </div>
      {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
      {list && data.deliveries.length ? (
        <ul className="flex flex-col gap-1">
          {data.deliveries.map((d) => (
            <li key={d.id} className="flex items-start gap-2 rounded-md bg-zinc-900 px-2 py-1.5 text-[12px]">
              <div className="min-w-0 flex-1">
                <p className="truncate text-zinc-100" title={d.name}>
                  {d.name}
                </p>
                <p className="text-[11px] text-zinc-500">
                  {size(d.size)}
                  {d.by ? ` · ${d.by}` : ""} · {when(d.at)}
                </p>
                {d.note ? <p className="mt-0.5 text-[11px] text-zinc-300">{d.note}</p> : null}
              </div>
              <a href={shareDeliveryUrl(token, d.id, true)} className="shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-50" title="Download">
                <Download className="h-3.5 w-3.5" />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default function WorkshopSharePage() {
  const { token = "" } = useParams();
  return <WorkshopShareView token={token} />;
}

/**
 * The page itself; `embedded` = inside the session's Share window: no full-height page or title bar, the open tab kept in state, not the URL.
 */
export function WorkshopShareView({ token, embedded = false }: { token: string; embedded?: boolean }) {
  const [urlParams, setUrlParams] = useSearchParams();
  const [localPiece, setLocalPiece] = useState<string | null>(null);
  const params = embedded ? new URLSearchParams(localPiece ? { piece: localPiece } : {}) : urlParams;
  const setParams = (fn: (q: URLSearchParams) => URLSearchParams, opts?: { replace?: boolean }) =>
    embedded ? setLocalPiece(fn(new URLSearchParams()).get("piece")) : setUrlParams(fn, opts);
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState(false);
  // in the window the window scrolls, so the sidebar doesn't
  const asideClass = `flex flex-col gap-6 ${embedded ? "" : "lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:self-start lg:overflow-y-auto"}`;
  const load = useCallback(() => {
    fetch(`/api/workshop-share/${token}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => setError(true));
  }, [token]);
  useEffect(load, [load]);

  if (!data) {
    return (
      <div className={`flex ${embedded ? "h-64" : "h-dvh"} items-center justify-center bg-zinc-950 px-6 text-center text-sm text-zinc-400`}>
        {error ? <p>This link is off or doesn't exist.</p> : <Loader2 className="h-6 w-6 animate-spin text-zinc-600" />}
      </div>
    );
  }
  // a reel and a carousel: one tab each, the open one in the link (?piece=carousel), so a link can open the carousel
  const keyOf = (p: (typeof data.pieces)[number]) => (data.pieces.filter((x) => x.kind === p.kind).length > 1 ? p.id : p.kind);
  const wanted = params.get("piece");
  const open = data.pieces.find((p) => keyOf(p) === wanted) ?? data.pieces[0];
  const all = data;
  const tabs = all.pieces.length > 1;
  const pieces = tabs && open ? [open] : all.pieces;
  const carousels = pieces.filter((p) => p.kind === "carousel");
  const finals = data.deliveries.length > 0;
  const statusTone =
    data.status === "ready" || data.status === "toPost" || data.status === "published" ? "border-emerald-500/50 text-emerald-300"
    : data.status === "production" || data.status === "editing" ? "border-amber-500/50 text-amber-300"
    : "border-zinc-700 text-zinc-300";
  return (
    <div className={`${embedded ? "" : "min-h-dvh"} bg-zinc-950 text-zinc-200`}>
      <header data-titlebar={embedded ? undefined : ""} className={`border-b border-zinc-900 py-3 ${embedded ? "pl-4 pr-12" : "px-4"}`}>
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{data.title}</h1>
          <span className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] ${statusTone}`}>{sessionStatusLabel(data.status)}</span>
          <span className="ml-auto hidden shrink-0 text-[11px] text-zinc-500 sm:block">
            Started {day(data.createdAt)} · last change {when(data.updatedAt)}
          </span>
        </div>
        {tabs ? (
          <nav className="mx-auto mt-3 flex max-w-6xl gap-1" aria-label="Pieces">
            {all.pieces.map((p) => {
              const on = p.id === open?.id;
              const sameKind = all.pieces.filter((x) => x.kind === p.kind).length > 1;
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setParams((q) => {
                    q.set("piece", keyOf(p));
                    return q;
                  }, { replace: true })}
                  className={`rounded-md px-3 py-1.5 text-[13px] ${on ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"}`}
                >
                  {sameKind ? p.title : (KIND[p.kind] ?? p.kind)}
                </button>
              );
            })}
          </nav>
        ) : null}
      </header>
      {finals ? (
        <main className="mx-auto grid max-w-6xl gap-6 px-3 py-4 sm:px-4 sm:py-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-8">
          <div className="flex min-w-0 flex-col gap-5">
            <section className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <p className="text-[11px] uppercase tracking-wide text-emerald-300">
                  Finals · {data.deliveries.length} {data.deliveries.length === 1 ? "file" : "files"}
                  {data.progress?.by ? ` from ${data.progress.by}` : ""}
                </p>
              </div>
              <SaveAllButton token={token} files={data.deliveries} className="w-full sm:w-auto sm:self-start" />
              <FinalsGallery token={token} files={data.deliveries} />
            </section>
            {pieces.map((p) => (
              <Caption key={p.id} piece={p} />
            ))}
            <details className="group rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] text-zinc-400 hover:text-zinc-200">
                <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" /> The slide text
              </summary>
              <div className="mt-3 flex flex-col gap-8">
                {pieces.map((p) => (
                  <PieceText key={p.id} piece={p} numbered={pieces.length > 1} />
                ))}
              </div>
            </details>
          </div>
          <aside className={asideClass}>
            <ShareAnswers token={token} embedded={embedded} />
            <section className={PANEL}>
              <p className={`${PANEL_HEAD} ${PANEL_TITLE}`}>Production</p>
              <div className="p-3"><Production token={token} data={data} list={false} onChange={(patch) => setData((d) => (d ? { ...d, ...patch } : d))} /></div>
            </section>
          </aside>
        </main>
      ) : (
        <main className="mx-auto grid max-w-6xl gap-8 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="flex min-w-0 flex-col gap-12">
            {pieces.length === 0 && <p className="mt-16 text-center text-sm text-zinc-500">Nothing here yet.</p>}
            {pieces.map((p) => (
              <PieceText key={p.id} piece={p} numbered={pieces.length > 1} />
            ))}
          </div>
          <aside className={asideClass}>
            <ShareAnswers token={token} embedded={embedded} />
            <section className={PANEL}>
              <p className={`${PANEL_HEAD} ${PANEL_TITLE}`}>Production</p>
              <div className="p-3"><Production token={token} data={data} onChange={(patch) => setData((d) => (d ? { ...d, ...patch } : d))} /></div>
            </section>
            {pieces.map((p) => (
              <div key={p.id} className="flex flex-col gap-3">
                {p.kind === "carousel" ? (
                  <section className={PANEL}>
                    <p className={`${PANEL_HEAD} ${PANEL_TITLE}`}>{carousels.length > 1 ? `${p.title} · ` : ""}Previews</p>
                    <div className="p-3"><Previews piece={p} /></div>
                  </section>
                ) : null}
                <Caption piece={p} />
              </div>
            ))}
          </aside>
        </main>
      )}
    </div>
  );
}
