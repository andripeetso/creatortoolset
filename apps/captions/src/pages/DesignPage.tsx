import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { Circle, Download, Hand, ImagePlus, Loader2, MousePointer2, Redo2, Sparkles, Square, Type, Undo2 } from "lucide-react";
import { DESIGN_LIMITS, type Design, type DesignPage as Page, type Layer } from "@contracts/design";
import type { AnimationStyle } from "@contracts/editor-styles";
import { AppBar } from "@/components/AppBar";
import { Inspector } from "@/components/design/Inspector";
import { LayersPanel } from "@/components/design/LayersPanel";
import { Stage, type Tool } from "@/components/design/Stage";
import { Button } from "@/components/ui/button";
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut } from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { drawingUrl, drawPage, sourceOf, type Loaded } from "@/lib/design/draw";
import { alignLayers, boundsOf, distribute, fitView, freshIds, layerName, pageLeft, pageName, zoomAt, type Align, type Rect, type View } from "@/lib/design/hands";
import { addPicture, designWithAi, getDesign, pictureUrl, saveDesign } from "@/lib/designs";
import { downloadBlob } from "@/lib/download";
import { freshHist, histChange, histRedo, histUndo, type Hist } from "@/lib/edit-history";
import { listAnimationStyles } from "@/lib/editor";
import { onTopic } from "@/lib/sync";
import { zipStored } from "@/lib/story-split";
import { DESIGN_FONTS, designWeight } from "@/lib/design/fonts";
import { cn } from "@/lib/utils";

/**
 * The designer (/design/:id): a canvas with every page of the design on it, the layers list on its left, the
 * properties of what is picked on its right and the tools under it. "Design with AI" has the person's AI design every
 * page in the look they pick; what comes back is layers like any others, so every part of it can be moved, resized,
 * restyled or taken out. Each page is saved as a PNG of exactly the design's size. Every change is a step ⌘Z takes
 * back, and is saved a moment later.
 *
 * Keys: V move, H hand, R rectangle, O ellipse, T text · ⌘A all, Esc none · ⌘C ⌘X ⌘V ⌘D · Delete · the arrows (Shift:
 * ten) · ] to the front, [ to the back · ⇧⌘H hide, ⇧⌘L lock · Enter types in the picked words · Alt with A D W S H V
 * lines up left, right, top, bottom, centres · 1 to 9 and 0 set the opacity · + − zoom, ⇧1 fit, ⇧2 the picked, ⇧0 100%.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fileName = (name: string) => name.replace(/[^\p{L}\p{N} _-]+/gu, " ").trim().replace(/\s+/g, "-") || "design";
/** The keys are someone else's: a field being typed in, or an open menu or popover. */
const typingIn = (t: EventTarget | null) => t instanceof HTMLElement && ((t instanceof HTMLInputElement && t.type !== "color") || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || !!t.closest('[role="menu"],[role="dialog"]'));

const TOOLS: [Tool, string, string, typeof Hand][] = [
  ["move", "Move", "V", MousePointer2],
  ["hand", "Hand", "H", Hand],
  ["rect", "Rectangle", "R", Square],
  ["ellipse", "Ellipse", "O", Circle],
  ["text", "Text", "T", Type],
];
const TOOL_KEYS: Record<string, Tool> = { KeyV: "move", KeyH: "hand", KeyR: "rect", KeyO: "ellipse", KeyT: "text" };
const ALIGN_KEYS: Record<string, Align> = { KeyA: "left", KeyD: "right", KeyW: "top", KeyS: "bottom", KeyH: "center", KeyV: "middle" };
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
// the panels' colours. The app's zinc greys mirror in the light theme (tailwind.config.js), so zinc-50 is the ink in both
const BAR = "border-[#e6e6e6] bg-white text-zinc-50 dark:border-[#444] dark:bg-[#2c2c2c]";

/**
 * What ⌘C took, for ⌘V. Kept here: a design's layers mean nothing to another program, which gets their names as
 * text. `wrote`: the computer's clipboard took that text, so a later copy somewhere else is noticed and pasted instead.
 * ponytail: where the browser keeps the clipboard shut, the layers copied last are pasted until the page is reloaded.
 */
let clip: { layers: Layer[]; text: string; wrote: boolean } | null = null;

/** One designer a design: another design's address starts it afresh (what is picked, the view, the steps to undo). */
export default function DesignRoute() {
  const { id = "" } = useParams();
  return <DesignPage key={id} id={id} />;
}

function DesignPage({ id }: { id: string }) {
  const [design, setDesign] = useState<Design | null>(null);
  const [hist, setHist] = useState<Hist<Page[]> | null>(null);
  const [live, setLive] = useState<Page | null>(null);
  const [at, setAt] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [framed, setFramed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("move");
  const [view, setView] = useState<View>({ x: 0, y: 0, z: 1 });
  const [pointed, setPointed] = useState<string | null>(null);
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
  const [room, setRoom] = useState<{ w: number; h: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getDesign(id).then(
      (d) => {
        server.current = { pages: d.pages, at: d.updatedAt };
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
    void Promise.all(DESIGN_FONTS.map((f) => document.fonts.load(`${designWeight(f.family)} 48px "${f.family}"`))).then(() => setVersion((v) => v + 1), () => {});
  }, []);

  const opened = design !== null;
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const fit = () => setRoom({ w: el.clientWidth, h: el.clientHeight });
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [opened]);

  // opened on its first page, whole
  const placed = useRef(false);
  useEffect(() => {
    if (placed.current || !design || !room) return;
    placed.current = true;
    setView(fitView({ x: 0, y: 0, w: design.width, h: design.height }, room));
  }, [design, room]);

  const pages = useMemo(() => hist?.now ?? [], [hist]);
  const k = Math.max(0, Math.min(at, pages.length - 1));
  /** The page the picked layers are on: as saved (what a change starts from), and as shown (mid-drag). */
  const base = pages[k];
  const shown = useMemo(() => (live ? pages.map((p) => (p.id === live.id ? live : p)) : pages), [pages, live]);
  const page = shown[k];
  const mine = base ? base.layers.filter((l) => selected.includes(l.id)) : [];
  const picked = page ? page.layers.filter((l) => selected.includes(l.id)) : [];

  // every picture and drawing the pages show, loaded once each
  useEffect(() => {
    if (!design) return;
    for (const l of pages.flatMap((p) => p.layers)) {
      const src = sourceOf(l);
      if (!src || loaded.has(src)) continue;
      const img = new Image();
      loaded.set(src, img);
      img.onload = () => setVersion((v) => v + 1);
      img.onerror = () => setError("A picture on a page could not be loaded");
      img.src = l.type === "image" ? pictureUrl(design.id, src) : drawingUrl(src);
    }
  }, [pages, design, loaded]);

  /**
   * What the server has of this design, as far as this window knows: the pages as they were last read from it or
   * sent to it (the very objects, so a page changed here since is one that is not among them), and when it was last
   * changed there.
   */
  const server = useRef<{ pages: Page[]; at: number }>({ pages: [], at: 0 });
  /** The pages not sent yet. */
  const unsaved = useRef<Page[] | null>(null);
  const send = useCallback(
    (pages: Page[]) => {
      unsaved.current = null;
      setSaved("saving");
      return saveDesign(id, { pages }).then(
        (d) => {
          server.current = { pages, at: d.updatedAt };
          setSaved(unsaved.current ? "unsaved" : "saved");
        },
        (e) => {
          unsaved.current ??= pages;
          setSaved("unsaved");
          setError(message(e));
        },
      );
    },
    [id],
  );
  // saved a moment after the last change
  const first = useRef(true);
  useEffect(() => {
    if (!design || !hist) return;
    if (first.current) return void (first.current = false);
    unsaved.current = hist.now;
    setSaved("unsaved");
    const t = setTimeout(() => void send(hist.now), 700);
    return () => clearTimeout(t);
    // the pages alone: the design's other fields change when it is saved, and saving must not save again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hist?.now]);
  // leaving (another page of the app, the window closing) sends what that moment had not sent yet
  useEffect(() => {
    const flush = () => {
      const pages = unsaved.current;
      unsaved.current = null;
      if (pages) void fetch(`/api/designs/${id}`, { method: "PUT", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ pages }) }).catch(() => {});
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [id]);

  // the pages as of the last drawing, for what finishes later (an upload)
  const latest = useRef(pages);
  useEffect(() => void (latest.current = pages), [pages]);
  /**
   * One step to undo. With `merge`, a change that follows another of the same name joins it: a colour dragged about
   * in the picker is one step, not one for every shade it passed.
   */
  const merging = useRef<string | null>(null);
  const change = useCallback((fn: (pages: Page[]) => Page[], merge?: string) => {
    const join = !!merge && merging.current === merge;
    merging.current = merge ?? null;
    setLive(null);
    setHist((h) => (!h ? h : join ? { ...h, now: fn(h.now) } : histChange(h, fn)));
  }, []);
  const setPage = useCallback((next: Page, merge?: string) => change((all) => all.map((p) => (p.id === next.id ? next : p)), merge), [change]);
  const pick = useCallback((to: number, ids: string[], frame = false) => {
    merging.current = null;
    setAt(to);
    setSelected(ids);
    setFramed(frame);
    setError(null);
  }, []);
  const step = (back: boolean) => {
    merging.current = null;
    setLive(null);
    setHist((h) => (h ? (back ? histUndo(h) : histRedo(h)) : h));
  };

  // A change made somewhere else (the assistant designing the pages, another window) is shown at once, as a step ⌘Z
  // takes back. This window's own saves are not told back to it (lib/sync.ts), and a notice about another design, or
  // an answer that comes late, changes nothing (the design is no newer than what this window knows). A page changed
  // here and not sent yet stays as it is here, and is then sent: the hand that was on it is never thrown away. Every
  // other page is the server's, and what came from the server is not saved back.
  useEffect(
    () =>
      onTopic("designs", () => {
        getDesign(id).then(
          (d) => {
            if (d.updatedAt <= server.current.at) return;
            const known = server.current.pages;
            const mine = latest.current.filter((p) => !known.includes(p));
            const merged = [...d.pages.map((p) => mine.find((m) => m.id === p.id) ?? p), ...mine.filter((m) => !d.pages.some((p) => p.id === m.id))];
            const same = JSON.stringify(merged) === JSON.stringify(latest.current);
            // the pages this window holds that are the server's: the server's own when they go on the canvas, else the ones here
            server.current = { pages: same ? latest.current.filter((p) => !mine.includes(p)) : d.pages, at: d.updatedAt };
            setDesign(d);
            if (same) return;
            if (!mine.length) first.current = true;
            change(() => merged);
          },
          () => {},
        );
      }),
    [id, change],
  );

  /** The saved page with every picked layer through `fn`. */
  const through = (fn: (l: Layer) => Layer): Page | null => (base ? { ...base, layers: base.layers.map((l) => (selected.includes(l.id) ? fn(l) : l)) } : null);
  const patch = (fn: (l: Layer) => Layer, merge?: string) => {
    const next = through(fn);
    if (next) setPage(next, merge);
  };
  const arrange = (next: Layer[]) => base && setPage({ ...base, layers: base.layers.map((l) => next.find((n) => n.id === l.id) ?? l) });

  /** New layers on a page, picked; null (and it says why) when the page is full. */
  const put = (to: number, count: number, make: (ids: string[]) => Layer[]): string[] | null => {
    const target = latest.current[to];
    if (!target || !count) return null;
    if (target.layers.length + count > DESIGN_LIMITS.layers) return setError(`A page holds at most ${DESIGN_LIMITS.layers} layers`), null;
    const ids = freshIds(target, count);
    setPage({ ...target, layers: [...target.layers, ...make(ids)] });
    pick(to, ids);
    return ids;
  };
  const textLayer = (id: string, text: string, r: Rect): Layer => ({ id, type: "text", text, font: "Inter", size: Math.round((design?.width ?? 1080) * 0.06), color: "#111111", align: "left", ...r });

  const addPage = (like?: Page) => {
    if (!base) return;
    if (pages.length >= DESIGN_LIMITS.pages) return setError(`A design holds at most ${DESIGN_LIMITS.pages} pages`);
    const fresh: Page = { ...(like ?? { background: base.background, layers: [] }), id: `p${Date.now().toString(36)}` };
    change((all) => [...all.slice(0, k + 1), fresh, ...all.slice(k + 1)]);
    pick(k + 1, [], true);
  };
  const movePage = (from: number, to: number) => {
    if (from === to) return;
    change((all) => {
      const next = [...all];
      next.splice(to, 0, ...next.splice(from, 1));
      return next;
    });
    pick(to, [], true);
  };
  const remove = () => {
    if (mine.length && base) {
      setPage({ ...base, layers: base.layers.filter((l) => !selected.includes(l.id)) });
      setSelected([]);
    } else if (framed && pages.length > 1) {
      change((all) => all.filter((_, n) => n !== k));
      pick(Math.max(0, k - 1), [], true);
    }
  };
  // a copy lies on what it copies, picked: the next drag takes it away
  const duplicate = () => (mine.length ? void put(k, mine.length, (ids) => mine.map((l, n) => ({ ...l, id: ids[n]! }))) : framed && base ? addPage(base) : undefined);
  const order = (front: boolean) => {
    if (!base || !mine.length) return;
    const rest = base.layers.filter((l) => !selected.includes(l.id));
    setPage({ ...base, layers: front ? [...rest, ...mine] : [...mine, ...rest] });
  };
  const toggle = (flag: "hidden" | "locked") => {
    const all = mine.every((l) => l[flag]);
    patch((l) => ({ ...l, [flag]: all ? undefined : true }) as Layer);
  };
  const copy = () => {
    if (!mine.length) return;
    const taken: NonNullable<typeof clip> = { layers: mine, text: mine.map(layerName).join("\n"), wrote: false };
    clip = taken;
    try {
      void navigator.clipboard?.writeText(taken.text).then(() => void (taken.wrote = true), () => {});
    } catch {
      // no clipboard here: the layers are kept all the same
    }
  };
  /** The copied layers onto this page, where they were on theirs. A picture this design does not have stays behind. */
  const paste = () => {
    const layers = (clip?.layers ?? []).filter((l) => l.type !== "image" || design?.pictures.includes(l.picture));
    put(k, layers.length, (ids) => layers.map((l, n) => ({ ...l, id: ids[n]! })));
  };

  const zoom = (to: "in" | "out" | "fit" | "selection" | number) => {
    if (!design || !room) return;
    const one = { x: pageLeft(k, design.width), y: 0, w: design.width, h: design.height };
    if (to === "fit") return setView(fitView({ ...one, x: 0, w: pageLeft(pages.length - 1, design.width) + design.width }, room));
    if (to === "selection") {
      const b = mine.length ? boundsOf(mine) : null;
      return setView(fitView(b ? { ...b, x: b.x + one.x } : one, room));
    }
    setView((v) => zoomAt(v, to === "in" ? v.z * 2 : to === "out" ? v.z / 2 : to, room.w / 2, room.h / 2));
  };

  const fromComputer = async (files: readonly File[]) => {
    if (!design || !base || !files.length) return;
    const onto = base.id;
    setError(null);
    try {
      const made: { picture: string; w: number; h: number }[] = [];
      for (const file of files) {
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
        made.push({ picture, w, h: Math.round((w * size.h) / size.w) });
      }
      // onto the page it was started on, as that page is by now
      put(latest.current.findIndex((p) => p.id === onto), made.length, (ids) => made.map((m, n) => ({ id: ids[n]!, type: "image", picture: m.picture, fit: "cover", x: Math.round((design.width - m.w) / 2), y: Math.round((design.height - m.h) / 2), w: m.w, h: m.h })));
    } catch (e) {
      setError(message(e));
    }
  };

  /** A box drawn with a making tool: a click makes the usual size, a drag the size drawn. */
  const make = (to: number, r: Rect, dragged: boolean) => {
    if (!design) return;
    const words = tool === "text";
    const b = { x: Math.round(r.x), y: Math.round(r.y), w: Math.max(1, Math.round(dragged ? r.w : words ? design.width / 2 : 100)), h: Math.max(1, Math.round(dragged ? r.h : words ? design.width * 0.08 : 100)) };
    const ids = put(to, 1, ([id]) => [words ? textLayer(id!, "Text", b) : { id: id!, type: "shape", shape: tool === "ellipse" ? "ellipse" : "rect", fill: "#d9d9d9", ...b }]);
    setTool("move");
    if (ids && words) setEditing(ids[0]!);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (typingIn(e.target) || !base || !design) return;
      const mod = e.metaKey || e.ctrlKey;
      const c = e.code;
      const has = mine.length > 0;
      const run = (fn: () => unknown) => (e.preventDefault(), void fn());
      if (mod) {
        if (c === "KeyZ") run(() => step(!e.shiftKey));
        else if (c === "KeyD") run(duplicate);
        else if (c === "KeyA") run(() => pick(k, base.layers.filter((l) => !l.hidden && !l.locked).map((l) => l.id)));
        else if (c === "KeyC") copy(); // not stopped: words picked in a panel are still the browser's to copy
        else if (c === "KeyX" && has) run(() => (copy(), remove()));
        else if (e.shiftKey && c === "KeyH" && has) run(() => toggle("hidden"));
        else if (e.shiftKey && c === "KeyL" && has) run(() => toggle("locked"));
        return; // ⌘V is the page's paste event (below); everything else is the browser's
      }
      if (e.altKey) return void (has && ALIGN_KEYS[c] && run(() => arrange(alignLayers(mine, ALIGN_KEYS[c]!, { w: design.width, h: design.height }))));
      if (e.shiftKey && c === "Digit1") return run(() => zoom("fit"));
      if (e.shiftKey && c === "Digit2") return run(() => zoom("selection"));
      if (e.shiftKey && c === "Digit0") return run(() => zoom(1));
      if (e.key === "+" || e.key === "=") return run(() => zoom("in"));
      if (e.key === "-") return run(() => zoom("out"));
      if (!e.shiftKey && TOOL_KEYS[c]) return run(() => setTool(TOOL_KEYS[c]!));
      if (e.key === "Escape") return run(() => (tool !== "move" ? setTool("move") : pick(k, [])));
      if (e.key === "Delete" || e.key === "Backspace") return run(remove);
      if (!has) return;
      const by = ARROWS[e.key];
      const far = e.shiftKey ? 10 : 1;
      if (by) run(() => patch((l) => ({ ...l, x: l.x + by[0] * far, y: l.y + by[1] * far })));
      else if (e.key === "Enter" && mine.length === 1 && mine[0]!.type === "text") run(() => setEditing(mine[0]!.id));
      else if (c === "BracketRight") run(() => order(true));
      else if (c === "BracketLeft") run(() => order(false));
      // 1 to 9: 10 % to 90 %; 0: all the way
      else if (!e.shiftKey && /^Digit\d$/.test(c)) run(() => patch((l) => ({ ...l, opacity: c === "Digit0" ? undefined : Number(c.slice(5)) / 10 })));
    };
    const onPaste = (e: ClipboardEvent) => {
      if (typingIn(e.target) || !design) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type));
      if (clip && (!clip.wrote || text === clip.text)) paste();
      else if (files.length) void fromComputer(files);
      // words copied somewhere else become a text layer in the middle of the page
      else if (text.trim()) put(k, 1, ([id]) => [textLayer(id!, text.trim().slice(0, DESIGN_LIMITS.text), { x: Math.round(design.width / 4), y: Math.round(design.height * 0.4), w: Math.round(design.width / 2), h: Math.round(design.height * 0.2) })]);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", key);
    document.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", key);
      document.removeEventListener("paste", onPaste);
    };
  });

  const exportPngs = async (only?: number) => {
    if (!design) return;
    setError(null);
    try {
      const files: { name: string; data: Uint8Array }[] = [];
      for (const [n, p] of pages.entries()) {
        if (only !== undefined && n !== only) continue;
        // every picture and drawing of the page is there first: a page is never saved with a grey box where one goes
        for (const l of p.layers) {
          const img = l.hidden ? undefined : (loaded.get(sourceOf(l) ?? "") as HTMLImageElement | undefined);
          if (!img || (img.complete && img.naturalWidth)) continue;
          const gone = new Error(`A picture on ${pageName(p, n)} could not be loaded: nothing was exported`);
          if (img.complete) throw gone;
          await new Promise<void>((ok, fail) => {
            img.addEventListener("load", () => ok(), { once: true });
            img.addEventListener("error", () => fail(gone), { once: true });
          });
        }
        const c = document.createElement("canvas");
        c.width = design.width;
        c.height = design.height;
        drawPage(c.getContext("2d")!, p, design.width, design.height, loaded);
        const blob = await new Promise<Blob | null>((done) => c.toBlob(done, "image/png"));
        if (!blob) throw new Error(`${pageName(p, n)} could not be saved as a picture`);
        files.push({ name: `${fileName(design.name)}-${String(n + 1).padStart(2, "0")}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
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
      await send(hist.now);
      const out = await designWithAi(design.id, { look: look || null, notes });
      // what the AI made is on the server already: shown as one step, and not saved back
      server.current = { pages: out.design.pages, at: out.design.updatedAt };
      first.current = true;
      setDesign(out.design);
      change(() => out.design.pages);
      pick(k, []);
      setSaid(out.notes);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  if (!design || !hist || !base || !page) {
    return (
      <div className="flex min-h-screen flex-col">
        <AppBar tool="Designer" />
        <p className="p-6 text-sm text-zinc-500">{error ?? "Opening the design…"}</p>
      </div>
    );
  }

  const piece = design.from && "session" in design.from ? `/workshop/sessions/${design.from.session}` : null;
  const item = (label: string, keys: string, onSelect: () => void, disabled = false) => (
    <ContextMenuItem disabled={disabled} onSelect={onSelect}>
      {label}
      {keys && <ContextMenuShortcut>{keys}</ContextMenuShortcut>}
    </ContextMenuItem>
  );
  const none = !mine.length;

  return (
    <div className="flex h-screen flex-col">
      <AppBar tool="Designer" to="/design" trail={<span className="truncate font-normal text-zinc-500">{design.name}</span>}>
        {piece && (
          <Button size="sm" variant="ghost" asChild>
            <Link to={piece}>Its Workshop piece</Link>
          </Button>
        )}
        <span className="text-xs text-zinc-500" aria-live="polite">
          {saved === "unsaved" ? "Not saved yet" : saved === "saving" ? "Saving" : ""}
        </span>
        <Button size="icon" variant="ghost" aria-label="Undo" disabled={!hist.past.length} onClick={() => step(true)}>
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="ghost" aria-label="Redo" disabled={!hist.future.length} onClick={() => step(false)}>
          <Redo2 className="h-4 w-4" />
        </Button>
        <Button size="sm" onClick={() => void exportPngs()}>
          <Download className="h-4 w-4" />
          {pages.length === 1 ? "Export PNG" : `Export ${pages.length} PNGs`}
        </Button>
      </AppBar>
      {error && <p className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400">{error}</p>}

      <div className="flex min-h-0 flex-1">
        <LayersPanel pages={shown} at={k} selected={selected} framed={framed} onPick={pick} onPoint={setPointed} onPage={setPage} onMovePage={movePage} onAddPage={() => addPage()} />

        <div ref={frame} className="relative min-w-0 flex-1 overflow-hidden bg-[#f5f5f5] dark:bg-[#1e1e1e]">
          {room && (
            <Stage
              pages={shown}
              at={k}
              width={design.width}
              height={design.height}
              room={room}
              view={view}
              onView={setView}
              loaded={loaded}
              version={version}
              selected={selected}
              framed={framed}
              onPick={pick}
              onLive={setLive}
              onCommit={setPage}
              tool={tool}
              onMake={make}
              editing={editing}
              onEdit={setEditing}
              pointed={pointed}
              menu={
                <ContextMenuContent className="w-56">
                  {item("Copy", "⌘C", copy, none)}
                  {item("Paste here", "⌘V", paste, !clip)}
                  {item("Duplicate", "⌘D", duplicate, none && !framed)}
                  <ContextMenuSeparator />
                  {item("Bring to front", "]", () => order(true), none)}
                  {item("Send to back", "[", () => order(false), none)}
                  <ContextMenuSeparator />
                  {item(mine.length && mine.every((l) => l.hidden) ? "Show" : "Hide", "⇧⌘H", () => toggle("hidden"), none)}
                  {item(mine.length && mine.every((l) => l.locked) ? "Unlock" : "Lock", "⇧⌘L", () => toggle("locked"), none)}
                  <ContextMenuSeparator />
                  {item("Delete", "⌫", remove, none && !(framed && pages.length > 1))}
                </ContextMenuContent>
              }
            />
          )}

          <div role="toolbar" aria-label="Tools" className={cn("absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-xl border p-1.5 shadow-lg", BAR)}>
            {TOOLS.map(([t, label, keys, Icon]) => (
              // the button lets the keys go again, so Space still drags the canvas after a click here
              <button key={t} type="button" aria-label={label} aria-pressed={tool === t} title={`${label} (${keys})`} onClick={(e) => (setTool(t), e.currentTarget.blur())} className={cn("flex h-8 w-8 items-center justify-center rounded-md", tool === t ? "bg-[#0d99ff] text-white" : "hover:bg-zinc-500/15")}>
                <Icon className="h-4 w-4" />
              </button>
            ))}
            <input ref={fileRef} type="file" multiple accept="image/jpeg,image/png,image/webp" className="hidden" aria-label="Pictures from this computer" onChange={(e) => (void fromComputer([...(e.target.files ?? [])]), (e.target.value = ""))} />
            <button type="button" aria-label="Picture" title="Picture" onClick={(e) => (fileRef.current?.click(), e.currentTarget.blur())} className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-zinc-500/15">
              <ImagePlus className="h-4 w-4" />
            </button>
            <span className="mx-1 h-5 w-px bg-[#e6e6e6] dark:bg-[#444]" />
            <Popover>
              <PopoverTrigger asChild>
                <button type="button" aria-label="Design with AI" title="Design with AI" className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium hover:bg-zinc-500/15">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  {busy ? "Designing" : "Design with AI"}
                </button>
              </PopoverTrigger>
              <PopoverContent side="top" align="center" sideOffset={12} className={cn("w-72 p-3", BAR)}>
                <section aria-label="Design with AI" className="flex flex-col gap-2 text-xs">
                  <label className="flex flex-col gap-1 text-zinc-500 dark:text-[#b3b3b3]">
                    Look
                    <select value={look} onChange={(e) => setLook(e.target.value)} className="h-8 w-full rounded-[5px] bg-[#f5f5f5] px-2 text-zinc-50 outline-none dark:bg-[#383838]">
                      <option value="">The AI's own</option>
                      {styles.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Textarea aria-label="What to ask for" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000} placeholder="Big type, one bright colour, a drawing on the first page." />
                  <Button size="sm" disabled={busy} onClick={() => void aiDesign()}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    {busy ? "Designing" : pages.length === 1 ? "Design this page" : `Design all ${pages.length} pages`}
                  </Button>
                  {said.length > 0 && (
                    <ul className="list-disc pl-4 text-zinc-500 dark:text-[#b3b3b3]">
                      {said.map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                    </ul>
                  )}
                </section>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <Inspector
          design={design}
          page={page}
          at={k}
          count={pages.length}
          picked={picked}
          onPreview={(fn) => setLive(fn ? through(fn) : null)}
          onPatch={patch}
          onPage={setPage}
          onAlign={(how) => arrange(alignLayers(mine, how, { w: design.width, h: design.height }))}
          onDistribute={(axis) => arrange(distribute(mine, axis))}
          zoom={view.z}
          onZoom={zoom}
          onExport={(only) => void exportPngs(only)}
        />
      </div>
    </div>
  );
}
