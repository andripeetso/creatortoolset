import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { ArrowDown, ArrowUp, Circle, Copy, Download, ImagePlus, Loader2, Plus, Redo2, Sparkles, Square, Trash2, Type, Undo2 } from "lucide-react";
import type { Design, DesignPage as Page, Layer } from "@contracts/design";
import type { AnimationStyle } from "@contracts/editor-styles";
import { AppBar } from "@/components/AppBar";
import { PageThumb, Stage } from "@/components/design/Stage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { drawingUrl, drawPage, sourceOf, type Loaded } from "@/lib/design/draw";
import { addPicture, designWithAi, getDesign, pictureUrl, saveDesign } from "@/lib/designs";
import { downloadBlob } from "@/lib/download";
import { freshHist, histChange, histRedo, histUndo, type Hist } from "@/lib/edit-history";
import { listAnimationStyles } from "@/lib/editor";
import { zipStored } from "@/lib/story-split";
import { FONT_OPTIONS, fontWeightFor } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The designer (/design/:id): a design's pages (contracts/design.ts) on a stage the person works on by hand, with the
 * panel for what is picked beside it. "Design with AI" has their AI design every page in the look they pick; what
 * comes back is layers like any others, so every part of it can be moved, resized, restyled or taken out. Each page is
 * saved as a PNG of exactly the design's size. Every change is a step ⌘Z takes back, and is saved a moment later.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const SELECT = "h-9 w-full rounded-md border border-zinc-500/30 bg-transparent px-2 text-sm";
const fileName = (name: string) => name.replace(/[^\p{L}\p{N} _-]+/gu, " ").trim().replace(/\s+/g, "-") || "design";
const nextId = (page: Page) => {
  for (let n = page.layers.length + 1; ; n++) if (!page.layers.some((l) => l.id === `l${n}`)) return `l${n}`;
};

export default function DesignPage() {
  const { id = "" } = useParams();
  const [design, setDesign] = useState<Design | null>(null);
  const [hist, setHist] = useState<Hist<Page[]> | null>(null);
  const [live, setLive] = useState<Page | null>(null);
  const [at, setAt] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<"saved" | "saving" | "unsaved">("saved");
  const [styles, setStyles] = useState<AnimationStyle[]>([]);
  const [look, setLook] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string[]>([]);
  const [version, setVersion] = useState(0);
  const loaded = useRef<Loaded>(new Map()).current;
  const frame = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 800, h: 600 });
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getDesign(id).then(
      (d) => {
        setDesign(d);
        setHist(freshHist(d.pages));
        setLook(d.look ?? "");
      },
      (e) => setError(message(e)),
    );
    listAnimationStyles().then((v) => setStyles(v.styles), () => setStyles([]));
  }, [id]);

  // the app's fonts, before the first page is drawn with them
  useEffect(() => {
    void Promise.all(FONT_OPTIONS.map((f) => document.fonts.load(`${fontWeightFor(f.family)} 48px "${f.family}"`))).then(() => setVersion((v) => v + 1), () => {});
  }, []);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const fit = () => setRoom({ w: el.clientWidth, h: el.clientHeight });
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [design !== null]);

  const pages = hist?.now ?? [];
  const page = live ?? pages[Math.min(at, pages.length - 1)];

  // every picture and drawing the pages show, loaded once each
  useEffect(() => {
    if (!design) return;
    for (const l of pages.flatMap((p) => p.layers)) {
      const src = sourceOf(l);
      if (!src || loaded.has(src)) continue;
      const img = new Image();
      loaded.set(src, img);
      img.onload = () => setVersion((v) => v + 1);
      img.src = l.type === "image" ? pictureUrl(design.id, src) : drawingUrl(src);
    }
  }, [pages, design, loaded]);

  // saved a moment after the last change
  const first = useRef(true);
  useEffect(() => {
    if (!design || !hist) return;
    if (first.current) return void (first.current = false);
    setSaved("unsaved");
    const t = setTimeout(() => {
      setSaved("saving");
      saveDesign(design.id, { pages: hist.now }).then(() => setSaved("saved"), (e) => (setSaved("unsaved"), setError(message(e))));
    }, 700);
    return () => clearTimeout(t);
  }, [hist?.now]);

  const change = useCallback((fn: (pages: Page[]) => Page[]) => setHist((h) => (h ? histChange(h, fn) : h)), []);
  const setPage = useCallback((next: Page) => change((all) => all.map((p) => (p.id === next.id ? next : p))), [change]);
  const sel = page?.layers.find((l) => l.id === selected) ?? null;
  const setLayer = (patch: Partial<Layer>) => page && sel && setPage({ ...page, layers: page.layers.map((l) => (l.id === sel.id ? ({ ...l, ...patch } as Layer) : l)) });
  const addLayer = (l: Record<string, unknown>) => {
    if (!page || !design) return;
    const id = nextId(page);
    setPage({ ...page, layers: [...page.layers, { id, x: Math.round(design.width * 0.2), y: Math.round(design.height * 0.4), w: Math.round(design.width * 0.6), h: Math.round(design.height * 0.2), ...l } as Layer] });
    setSelected(id);
  };
  const removeLayer = () => page && sel && (setPage({ ...page, layers: page.layers.filter((l) => l.id !== sel.id) }), setSelected(null));
  const order = (by: 1 | -1) => {
    if (!page || !sel) return;
    const k = page.layers.findIndex((l) => l.id === sel.id);
    const to = k + by;
    if (to < 0 || to >= page.layers.length) return;
    const layers = [...page.layers];
    [layers[k], layers[to]] = [layers[to]!, layers[k]!];
    setPage({ ...page, layers });
  };
  const duplicate = () => {
    if (!page || !sel) return;
    const id = nextId(page);
    setPage({ ...page, layers: [...page.layers, { ...sel, id, x: sel.x + 24, y: sel.y + 24 }] });
    setSelected(id);
  };

  // ⌘Z, ⇧⌘Z, ⌘D, Delete, the arrows (Shift: ten at a time), Escape
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") return e.preventDefault(), setHist((h) => (h ? (e.shiftKey ? histRedo(h) : histUndo(h)) : h));
      if (mod && e.key.toLowerCase() === "d") return e.preventDefault(), duplicate();
      if (!sel) return;
      if (e.key === "Delete" || e.key === "Backspace") return e.preventDefault(), removeLayer();
      if (e.key === "Escape") return setSelected(null);
      const step = e.shiftKey ? 10 : 1;
      const move: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const by = move[e.key];
      if (by) e.preventDefault(), setLayer({ x: sel.x + by[0], y: sel.y + by[1] });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const scale = useMemo(() => (design ? Math.max(0.05, Math.min((room.w - 48) / design.width, (room.h - 48) / design.height, 1)) : 1), [design, room]);

  const exportPngs = async () => {
    if (!design) return;
    setError(null);
    try {
      const files: { name: string; data: Uint8Array }[] = [];
      for (const [k, p] of pages.entries()) {
        const c = document.createElement("canvas");
        c.width = design.width;
        c.height = design.height;
        drawPage(c.getContext("2d")!, p, design.width, design.height, loaded);
        const blob = await new Promise<Blob | null>((done) => c.toBlob(done, "image/png"));
        if (!blob) throw new Error(`Page ${k + 1} could not be saved as a picture`);
        files.push({ name: `${fileName(design.name)}-${String(k + 1).padStart(2, "0")}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
      }
      if (files.length === 1) downloadBlob(files[0]!.name, new Blob([files[0]!.data as BlobPart], { type: "image/png" }));
      else downloadBlob(`${fileName(design.name)}.zip`, zipStored(files));
    } catch (e) {
      setError(message(e));
    }
  };

  const aiDesign = async () => {
    if (!design || !hist) return;
    setBusy(true);
    setError(null);
    setSaid([]);
    try {
      // what is on the pages now goes first, so the AI starts from the words as they are
      await saveDesign(design.id, { pages: hist.now });
      const out = await designWithAi(design.id, { look: look || null, notes });
      setDesign(out.design);
      change(() => out.design.pages);
      setSelected(null);
      setSaid(out.notes);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const fromComputer = async (files: FileList | null) => {
    if (!design || !files?.length) return;
    setError(null);
    try {
      for (const file of [...files]) {
        const picture = await addPicture(design.id, file);
        setDesign((d) => (d ? { ...d, pictures: [...d.pictures, picture] } : d));
        const size = await new Promise<{ w: number; h: number }>((done) => {
          const img = new Image();
          img.onload = () => done({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => done({ w: 1, h: 1 });
          img.src = pictureUrl(design.id, picture);
        });
        // at most 60 % of the page's width, in the picture's own shape
        const w = Math.round(Math.min(design.width * 0.6, size.w));
        addLayer({ type: "image", picture, fit: "cover", w, h: Math.round((w * size.h) / size.w) });
      }
    } catch (e) {
      setError(message(e));
    }
  };

  if (!design || !hist || !page) {
    return (
      <div className="flex min-h-screen flex-col">
        <AppBar tool="Designer" />
        <p className="p-6 text-sm text-zinc-500">{error ?? "Opening the design…"}</p>
      </div>
    );
  }

  const back = design.from && "session" in design.from ? `/workshop/sessions/${design.from.session}` : undefined;
  const num = (label: string, value: number, set: (n: number) => void, more: { min?: number; max?: number; step?: number } = {}) => (
    <label className="flex flex-col gap-1 text-xs text-zinc-500">
      {label}
      <Input type="number" value={Number.isFinite(value) ? value : 0} {...more} onChange={(e) => e.target.value !== "" && set(Number(e.target.value))} className="h-8 px-2" />
    </label>
  );
  const colour = (label: string, value: string, set: (c: string) => void) => (
    <label className="flex flex-col gap-1 text-xs text-zinc-500">
      {label}
      <input type="color" aria-label={label} value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"} onChange={(e) => set(e.target.value)} className="h-8 w-full cursor-pointer rounded-md border border-zinc-500/30 bg-transparent" />
    </label>
  );

  return (
    <div className="flex h-screen flex-col">
      <AppBar tool="Designer" to={back} trail={<span className="truncate font-normal text-zinc-500">{design.name}</span>}>
        <span className="text-xs text-zinc-500" aria-live="polite">
          {saved === "unsaved" ? "Not saved yet" : saved === "saving" ? "Saving" : ""}
        </span>
        <Button size="icon" variant="ghost" aria-label="Undo" disabled={!hist.past.length} onClick={() => setHist(histUndo(hist))}>
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="ghost" aria-label="Redo" disabled={!hist.future.length} onClick={() => setHist(histRedo(hist))}>
          <Redo2 className="h-4 w-4" />
        </Button>
        <Button size="sm" onClick={() => void exportPngs()}>
          <Download className="h-4 w-4" />
          {pages.length === 1 ? "Save PNG" : `Save ${pages.length} PNGs`}
        </Button>
      </AppBar>
      {error && <p className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400">{error}</p>}

      <div className="flex min-h-0 flex-1">
        <nav aria-label="Pages" className="flex w-32 shrink-0 flex-col gap-2 overflow-y-auto border-r border-zinc-500/20 p-3">
          {pages.map((p, k) => (
            <button
              key={p.id}
              type="button"
              aria-label={`Page ${k + 1}`}
              aria-current={k === at}
              onClick={() => (setAt(k), setSelected(null), setEditing(null))}
              className={cn("flex flex-col items-center gap-1 rounded-md p-1 text-xs text-zinc-500", k === at ? "bg-violet-500/15 text-violet-300 outline outline-1 outline-violet-500/50" : "hover:bg-zinc-500/10")}
            >
              <PageThumb page={k === at ? page : p} width={design.width} height={design.height} loaded={loaded} version={version} />
              {k + 1}
            </button>
          ))}
          <div className="mt-1 grid grid-cols-2 gap-1">
            <Button size="icon" variant="outline" aria-label="Add a page" onClick={() => (change((all) => [...all.slice(0, at + 1), { id: `p${Date.now().toString(36)}`, background: page.background, layers: [] }, ...all.slice(at + 1)]), setAt(at + 1))}>
              <Plus className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="outline" aria-label="Copy this page" onClick={() => (change((all) => [...all.slice(0, at + 1), { ...page, id: `p${Date.now().toString(36)}` }, ...all.slice(at + 1)]), setAt(at + 1))}>
              <Copy className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="outline" aria-label="Move this page up" disabled={at === 0} onClick={() => (change((all) => all.map((p, k) => (k === at - 1 ? all[at]! : k === at ? all[at - 1]! : p))), setAt(at - 1))}>
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="outline" aria-label="Move this page down" disabled={at >= pages.length - 1} onClick={() => (change((all) => all.map((p, k) => (k === at + 1 ? all[at]! : k === at ? all[at + 1]! : p))), setAt(at + 1))}>
              <ArrowDown className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="outline" aria-label="Delete this page" disabled={pages.length < 2} className="col-span-2 w-full" onClick={() => (change((all) => all.filter((_, k) => k !== at)), setAt(Math.max(0, at - 1)), setSelected(null))}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div role="toolbar" aria-label="Add to the page" className="flex flex-wrap items-center gap-1.5 border-b border-zinc-500/20 px-3 py-2">
            <Button size="sm" variant="outline" onClick={() => addLayer({ type: "text", text: "Your words", font: "Montserrat ExtraBold", size: Math.round(design.width * 0.07), color: "#111111", align: "left" })}>
              <Type className="h-4 w-4" />
              Text
            </Button>
            <Button size="sm" variant="outline" onClick={() => addLayer({ type: "shape", shape: "rect", fill: "#7c3aed", w: Math.round(design.width * 0.4), h: Math.round(design.width * 0.4) })}>
              <Square className="h-4 w-4" />
              Rectangle
            </Button>
            <Button size="sm" variant="outline" onClick={() => addLayer({ type: "shape", shape: "ellipse", fill: "#f59e0b", w: Math.round(design.width * 0.4), h: Math.round(design.width * 0.4) })}>
              <Circle className="h-4 w-4" />
              Ellipse
            </Button>
            <input ref={fileRef} type="file" multiple accept="image/jpeg,image/png,image/webp" className="hidden" aria-label="Pictures from this computer" onChange={(e) => (void fromComputer(e.target.files), (e.target.value = ""))} />
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
              <ImagePlus className="h-4 w-4" />
              Picture
            </Button>
            <span className="ml-auto text-xs text-zinc-500">
              {design.width} × {design.height} px
            </span>
          </div>
          <div ref={frame} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-zinc-500/10">
            <Stage
              page={page}
              width={design.width}
              height={design.height}
              scale={scale}
              loaded={loaded}
              version={version}
              selected={selected}
              onSelect={setSelected}
              onLive={setLive}
              onCommit={setPage}
              editing={editing}
              onEdit={setEditing}
            />
          </div>
        </div>

        <aside aria-label="Design" className="flex w-72 shrink-0 flex-col gap-4 overflow-y-scroll border-l border-zinc-500/20 p-3">
          <section aria-label="Design with AI" className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">Design with AI</h2>
            <div className="flex flex-col gap-1">
              <Label htmlFor="design-look" className="text-xs text-zinc-500">
                Look
              </Label>
              <select id="design-look" value={look} onChange={(e) => setLook(e.target.value)} className={SELECT}>
                <option value="">The AI's own</option>
                {styles.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <Textarea aria-label="What to ask for" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000} placeholder="Big type, one bright colour, a drawing on the first page." />
            <Button size="sm" disabled={busy} onClick={() => void aiDesign()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {busy ? "Designing" : pages.length === 1 ? "Design this page" : `Design all ${pages.length} pages`}
            </Button>
            {said.length > 0 && (
              <ul className="list-disc pl-4 text-xs text-zinc-500">
                {said.map((n, k) => (
                  <li key={k}>{n}</li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Page" className="flex flex-col gap-2 border-t border-zinc-500/20 pt-3">
            <h2 className="text-sm font-semibold">Page {at + 1}</h2>
            {colour("Background", page.background, (background) => setPage({ ...page, background }))}
          </section>

          {sel && (
            <section aria-label="Picked layer" className="flex flex-col gap-2 border-t border-zinc-500/20 pt-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">{sel.type === "text" ? "Text" : sel.type === "image" ? "Picture" : sel.type === "shape" ? "Shape" : "Drawing"}</h2>
                <div className="flex gap-1">
                  <Button size="icon" variant="ghost" aria-label="Bring forward" onClick={() => order(1)}>
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="Send back" onClick={() => order(-1)}>
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="Copy" onClick={duplicate}>
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="Delete" onClick={removeLayer}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {sel.type === "text" && (
                <>
                  <Textarea aria-label="Words" value={sel.text} rows={3} maxLength={600} onChange={(e) => setLayer({ text: e.target.value })} />
                  <label className="flex flex-col gap-1 text-xs text-zinc-500">
                    Font
                    <select value={sel.font} onChange={(e) => setLayer({ font: e.target.value })} className={SELECT}>
                      {FONT_OPTIONS.map((f) => (
                        <option key={f.family} value={f.family}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {num("Size", sel.size, (size) => setLayer({ size }), { min: 8, max: 600 })}
                    {num("Line height", sel.lineHeight ?? 1.15, (lineHeight) => setLayer({ lineHeight }), { min: 0.8, max: 3, step: 0.05 })}
                    {colour("Colour", sel.color, (color) => setLayer({ color }))}
                    <label className="flex flex-col gap-1 text-xs text-zinc-500">
                      Align
                      <select value={sel.align} onChange={(e) => setLayer({ align: e.target.value as "left" | "center" | "right" })} className={cn(SELECT, "h-8")}>
                        <option value="left">Left</option>
                        <option value="center">Centre</option>
                        <option value="right">Right</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-zinc-500">
                      In its box
                      <select value={sel.valign ?? "top"} onChange={(e) => setLayer({ valign: e.target.value as "top" | "middle" | "bottom" })} className={cn(SELECT, "h-8")}>
                        <option value="top">Top</option>
                        <option value="middle">Middle</option>
                        <option value="bottom">Bottom</option>
                      </select>
                    </label>
                    <label className="flex items-end gap-2 pb-1.5 text-xs text-zinc-500">
                      <input type="checkbox" checked={!!sel.upper} onChange={(e) => setLayer({ upper: e.target.checked || undefined })} />
                      Capitals
                    </label>
                    {num("Outline", sel.outline?.width ?? 0, (width) => setLayer({ outline: width > 0 ? { color: sel.outline?.color ?? "#000000", width } : undefined }), { min: 0, max: 60 })}
                    {sel.outline && colour("Outline colour", sel.outline.color, (color) => setLayer({ outline: { ...sel.outline!, color } }))}
                  </div>
                </>
              )}
              {sel.type === "image" && (
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 text-xs text-zinc-500">
                    In its box
                    <select value={sel.fit} onChange={(e) => setLayer({ fit: e.target.value as "cover" | "contain" })} className={cn(SELECT, "h-8")}>
                      <option value="cover">Fill it</option>
                      <option value="contain">Fit inside</option>
                    </select>
                  </label>
                  {num("Round corners", sel.radius ?? 0, (radius) => setLayer({ radius: radius || undefined }), { min: 0, max: 2000 })}
                </div>
              )}
              {sel.type === "shape" && (
                <div className="grid grid-cols-2 gap-2">
                  {colour("Fill", sel.fill, (fill) => setLayer({ fill }))}
                  {sel.shape === "rect" && num("Round corners", sel.radius ?? 0, (radius) => setLayer({ radius: radius || undefined }), { min: 0, max: 2000 })}
                  {num("Line", sel.stroke?.width ?? 0, (width) => setLayer({ stroke: width > 0 ? { color: sel.stroke?.color ?? "#000000", width } : undefined }), { min: 0, max: 200 })}
                  {sel.stroke && colour("Line colour", sel.stroke.color, (color) => setLayer({ stroke: { ...sel.stroke!, color } }))}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                {num("X", sel.x, (x) => setLayer({ x }))}
                {num("Y", sel.y, (y) => setLayer({ y }))}
                {num("Width", sel.w, (w) => setLayer({ w: Math.max(1, w) }), { min: 1 })}
                {num("Height", sel.h, (h) => setLayer({ h: Math.max(1, h) }), { min: 1 })}
                {num("Turn (°)", sel.rotate ?? 0, (rotate) => setLayer({ rotate: rotate || undefined }), { min: -360, max: 360 })}
                {num("See-through (%)", Math.round((1 - (sel.opacity ?? 1)) * 100), (p) => setLayer({ opacity: p > 0 ? Math.max(0, 1 - p / 100) : undefined }), { min: 0, max: 100 })}
              </div>
            </section>
          )}

          <section aria-label="Layers" className="flex flex-col gap-1 border-t border-zinc-500/20 pt-3">
            <h2 className="text-sm font-semibold">Layers</h2>
            {page.layers.length === 0 && <p className="text-xs text-zinc-500">Nothing on this page yet.</p>}
            {[...page.layers].reverse().map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => setSelected(l.id)}
                className={cn("truncate rounded-md px-2 py-1 text-left text-xs", l.id === selected ? "bg-violet-500/15 text-violet-300" : "text-zinc-400 hover:bg-zinc-500/10")}
              >
                {l.type === "text" ? l.text.replace(/\s+/g, " ").slice(0, 40) : l.type === "image" ? "Picture" : l.type === "shape" ? (l.shape === "ellipse" ? "Ellipse" : "Rectangle") : "Drawing"}
              </button>
            ))}
          </section>
        </aside>
      </div>
    </div>
  );
}
