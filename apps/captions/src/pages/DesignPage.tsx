import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { ArrowRight, Circle, Download, Frame, Hand, ImagePlus, MousePointer2, PenTool, Redo2, Square, Star, Triangle, Type, Undo2, X } from "lucide-react";
import { DESIGN_BOOLEANS, DESIGN_LIMITS, type Design, type DesignBoolean, type DesignStyles, type DesignPage as Page, type GroupLayer, type Layer, type TextLayer } from "@contracts/design";
import { STYLE_NAME_MAX, type AnimationStyle, type AnimationStylesView } from "@contracts/editor-styles";
import { AppBar } from "@/components/AppBar";
import { CtMark } from "@/components/CtMark";
import { FramePresets } from "@/components/design/FramePresets";
import { Inspector, type ExportAs } from "@/components/design/Inspector";
import { usePageNeeds } from "@/lib/chat-mode";
import { canChange, useMe } from "@/lib/auth";
import { LayersPanel } from "@/components/design/LayersPanel";
import { Stage, type Tool } from "@/components/design/Stage";
import { Button } from "@/components/ui/button";
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "@/components/ui/context-menu";
import { Tip } from "@/components/design/Tip";
import { drawingUrl, drawPage, measureWords, sourceOf, type Loaded } from "@/lib/design/draw";
import { fillsOf, paintPictures, strokesOf } from "@/lib/design/paint";
import { alignLayers, besideFrames, BOOLEAN_NAMES, boundsOf, rehome, distribute, fitView, frameOf, freshIds, hugLoose, intersects, layerName, mergeFrames, pageName, regroup, zoomAt, ZOOM, type Align, type Rect } from "@/lib/design/hands";
import { dupStep, FIT_PAD, PAN_STEP, tidy, turnTo } from "@/lib/design/feel";
import { resized } from "@/lib/design/resize";
import { detached, plainOf, freshKey, instanceAround, isInstance, isMain, mainsOf, syncInstances } from "@/lib/design/components";
import { ComponentSection } from "@/components/design/ComponentSection";
import { depthOf, everyLayer, keepNext, findLayer, inFrame, inScope, isGroup, mapLayers, maskWithNext, parentOf, pathTo, reid, scopeOf, unscope, unwrap, wrap } from "@/lib/design/tree";
import { CopySizes } from "@/components/design/CopySizes";
import { viewStore, zoomStop } from "@/lib/design/view";
import { useAidPrefs } from "@/lib/design/aids";
import { coloursOn } from "@/lib/design/colour";
import { inPixels, refit } from "@/lib/design/path";
import { settles, withSent, type SentSave } from "@/lib/design/hands";
import { addPicture, cutOutPicture, DesignChanged, getDesign, isPicture, pictureFrames, pictureId, pictureUrl, saveDesign, splitPicture, type SendError } from "@/lib/designs";
import { splitLayers } from "@/lib/design/split";
import { onThisMac } from "@/lib/thisMac";
import { downloadBlob } from "@/lib/download";
import { addStylePictures, createAnimationStyle, listAnimationStyles } from "@/lib/editor";
import { useCachedLoad } from "@/lib/local-cache";
import { freshHist, histChange, histRedo, histUndo, type Hist } from "@/lib/edit-history";
import { addAutoLayout, flows, forgetWords, layoutPages, withoutLayout } from "@/lib/design/layout";
import { onTopic } from "@/lib/sync";
import { zipStored } from "@/lib/story-split";
import { DESIGN_FONTS, designWeight } from "@/lib/design/fonts";
import { patchRange, viewRange } from "@/lib/design/runs";
import { useOwnFonts } from "@/lib/design/own-fonts";
import { cn } from "@/lib/utils";
import { lookOf, mergeStyles, styled, unlinked, withLook, type Look } from "@/lib/design/styles";
import { DesignStylesContext } from "@/components/design/StylesSection";

/**
 * The designer (/design/:id): one canvas a design, with its frames lying where the person put them (a carousel's
 * slides, a cover, a thumbnail, each of its own size), the layers list on its left, the properties of what is picked
 * on its right and the tools under it. The person's AI designs here through the assistant beside the page (the
 * designer's tools, api/mcp-tools/designs.ts): what it writes shows on the canvas at once, as frames and layers like
 * any others. Each frame is saved as a PNG of exactly its size. Every change is a step ⌘Z takes back, and is saved a
 * moment later.
 *
 * ⌘G groups the picked layers, ⇧⌘G takes the group apart.
 * Keys: V move, H hand, F frame, R rectangle, O ellipse, T text, P pen (a triangle, a star and an arrow are on the toolbar) · ⌘A all, Esc none · ⌘C ⌘X ⌘V ⌘D · Delete · the arrows (Shift:
 * ten) · ] to the front, [ to the back · ⇧⌘H hide, ⇧⌘L lock · Enter types in the picked words · Alt with A D W S H V
 * (in a picture: moves it inside its box) · lines up left, right, top, bottom, centres · 1 to 9 and 0 set the opacity · + − zoom, ⇧1 fit, ⇧2 the picked, ⇧0 100%.
 * Nothing picked, the arrows pan the view (Shift: further). ⌘D again right after a copy was moved or turned repeats that
 * step. The canvas opens where this browser left it.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fileName = (name: string) => name.replace(/[^\p{L}\p{N} _-]+/gu, " ").trim().replace(/\s+/g, "-") || "design";
/** The keys are someone else's: a field being typed in, or an open menu or popover. */
const typingIn = (t: EventTarget | null) => t instanceof HTMLElement && ((t instanceof HTMLInputElement && t.type !== "color") || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || !!t.closest('[role="menu"],[role="dialog"]'));

const TOOLS: [Tool, string, string, typeof Hand][] = [
  ["move", "Move", "V", MousePointer2],
  ["hand", "Hand", "H", Hand],
  ["frame", "Frame", "F", Frame],
  ["rect", "Rectangle", "R", Square],
  ["ellipse", "Ellipse", "O", Circle],
  ["triangle", "Triangle", "", Triangle],
  ["star", "Star", "", Star],
  ["arrow", "Arrow", "", ArrowRight],
  ["pen", "Pen", "P", PenTool],
  ["text", "Text", "T", Type],
];
/** The tools that work on a canvas with no frame yet: the others draw a layer, and a layer lies on a frame. */
const TOOL_KEYS: Record<string, Tool> = { KeyV: "move", KeyH: "hand", KeyF: "frame", KeyR: "rect", KeyO: "ellipse", KeyT: "text", KeyP: "pen" };
const ON_A_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
/** ⌥⌘ and these combine the picked shapes (contracts/design.ts GroupLayer `boolean`). */
const BOOLEAN_KEYS: Record<string, DesignBoolean> = { KeyU: "union", KeyS: "subtract", KeyI: "intersect", KeyX: "exclude" };
const BOOLEAN_KEY_NAMES: Record<DesignBoolean, string> = { union: "⌥⌘U", subtract: "⌥⌘S", intersect: "⌥⌘I", exclude: "⌥⌘X" };
const ALIGN_KEYS: Record<string, Align> = { KeyA: "left", KeyD: "right", KeyW: "top", KeyS: "bottom", KeyH: "center", KeyV: "middle" };
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
/** Where the canvas was left in this browser, by design. */
const VIEW_KEY = "ct-design-view:";
// the panels' colours. The app's zinc greys mirror in the light theme (tailwind.config.js), so zinc-50 is the ink in both
const BAR = "border-[#e6e6e6] bg-white text-zinc-50 dark:border-[#444] dark:bg-[#2c2c2c]";

/**
 * What ⌘C took, for ⌘V. Kept here: a design's layers mean nothing to another program, which gets their names as
 * text. `wrote`: the computer's clipboard took that text, so a later copy somewhere else is noticed and pasted instead.
 * ponytail: where the browser keeps the clipboard shut, the layers copied last are pasted until the page is reloaded.
 */
/** `from`: the design copied from (a main or an instance means nothing in another design). */
let clip: { layers: Layer[]; text: string; wrote: boolean; from?: string } | null = null;

/** What the designer edits, as one step to undo: the frames and the design's styles. */
type Doc = { pages: Page[]; styles: DesignStyles };
const NO_STYLES: DesignStyles = {};

/** One designer a design: another design's address starts it afresh (what is picked, the view, the steps to undo). */
export default function DesignRoute() {
  const { id = "" } = useParams();
  return <DesignPage key={id} id={id} />;
}

/**
 * The designer on one design, full screen over another page (the video editor's timeline): the same canvas, layers,
 * properties, saving and assistant as /design/:id. Done saves what is not saved yet, then calls `onDone`; a save
 * that fails keeps it open, with the reason in its error line. While it is open, the page under it should leave the
 * keys alone: the designer's own (Delete, the arrows, ⌘Z) are read on the window.
 */
export function DesignEditor({ id, onDone }: { id: string; onDone: () => void }) {
  return (
    <div role="dialog" aria-label="Design" className="fixed inset-0 z-50 bg-background">
      <DesignPage key={id} id={id} onDone={onDone} />
    </div>
  );
}

function DesignPage({ id, onDone }: { id: string; onDone?: () => void }) {
  // the layers, the canvas and what is picked side by side: beside the chats (chat mode) the page asks for that much
  usePageNeeds(920);
  // Read (Settings → Team → Access): the design opens to look at; nothing in it changes, saves or shows a control to change it
  const locked = !canChange(useMe(), "design");
  const [design, setDesign] = useState<Design | null>(null);
  /** The name in the top bar while it is being typed (null: not being typed, the design's own name shows). */
  const [naming, setNaming] = useState<string | null>(null);
  /** the frames and the design's styles, as one step to undo (a style changed is a step too) */
  const [hist, setHist] = useState<Hist<Doc> | null>(null);
  const [live, setLiveRaw] = useState<Page[] | null>(null);
  /** the rulers showing (⇧R): the messages over the canvas go below the top one */
  const aidPrefs = useAidPrefs();
  const [at, setAt] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [framed, setFramed] = useState(false);
  /** The other frames picked with the one at `at`, by id (a box drawn round several, or Shift on a name). */
  const [others, setOthers] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  /** the letters picked in the words being typed: what the style panel styles while they are */
  const [textSel, setTextSel] = useState<{ start: number; end: number } | null>(null);
  /** A change of the style panel's, made only to the picked letters when some are (their style; the rest of it to the layer). */
  const toLetters = (fn: (l: Layer) => Layer) => (l: Layer): Layer => (textSel && l.id === editing && l.type === "text" ? patchRange(l, fn as (l: TextLayer) => TextLayer, textSel.start, textSel.end) : fn(l));
  /** The picture layer being moved inside its box, and whether a picture's background is being cut away. */
  const [cropping, setCropping] = useState<string | null>(null);
  const [cutting, setCutting] = useState(false);
  /** The path layer whose points are shown for moving, and the picked one of them. */
  const [shaping, setShaping] = useState<{ id: string; anchor: number | null } | null>(null);
  const [pickedTool, setTool] = useState<Tool>("move");
  // Read: the hand (pan) is the only tool, so nothing picked here draws or moves
  const tool = locked ? "hand" : pickedTool;
  // where the canvas is scrolled to and how far it is zoomed: kept beside this page's state, so a wheel draws the canvas again and not the whole page
  const view = useRef(viewStore()).current;
  const [pointed, setPointed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A Mac it needs is not reachable: said in a line of its own, with Stop while it is being done on this Mac instead. */
  const [macNote, setMacNote] = useState<{ text: string; stop?: () => void } | null>(null);
  const navigate = useNavigate();
  // the same saved copy as the Designer's Carousel styles tab, so a style made here is in that list too. Read when the
  // page opens and after a frame is added: not again at each save of this design
  const carouselStyles = useCachedLoad<AnimationStylesView>("/api/designs/styles", () => listAnimationStyles("carousel"), { topic: [] });
  const [saved, setSaved] = useState<"saved" | "saving" | "unsaved">("saved");
  /** The dropper is out: the next press on the canvas gives its colour to `take`. */
  const [dropper, setDropper] = useState<{ take: (hex: string) => void } | null>(null);
  const [version, setVersion] = useState(0);
  const loaded = useRef<Loaded>(new Map()).current;
  const frame = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<{ w: number; h: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const roomNow = useRef(room);
  useEffect(() => void (roomNow.current = room), [room]);

  useEffect(() => {
    getDesign(id).then(
      (d) => {
        // the server's pages as this window lays them out (its widths of the words, not the server's guess): what the
        // window changes is told from what the server has by that, never by the measuring alone
        const pages = layoutPages(d.pages, measureWords);
        server.current = { pages, styles: d.styles ?? {}, at: d.updatedAt };
        setDesign(d);
        setHist(freshHist({ pages, styles: d.styles ?? {} }));
        // a canvas with no frame yet opens with the frame tool out: its sizes are in the panel, and a drag draws one
        if (!d.pages.length) setTool("frame");
      },
      (e) => setError(message(e)),
    );
  }, [id]);

  // the words measured again once their fonts are here: every auto layout laid out with them, as it is (no step to undo)
  const ready = hist !== null;
  useEffect(() => {
    if (!version || !ready) return;
    forgetWords();
    // what the server has, too: told apart from this window's changes as they both are laid out now (on load, below)
    server.current = { ...server.current, pages: layoutPages(server.current.pages, measureWords) };
    setHist((h) => {
      const now = h && layoutPages(h.now.pages, measureWords);
      return !h || now === h.now.pages ? h : { ...h, now: { ...h.now, pages: now! } };
    });
  }, [version, ready]);

  // the app's fonts, before the first page is drawn with them
  useEffect(() => {
    void Promise.all(DESIGN_FONTS.map((f) => document.fonts.load(`${designWeight(f.family)} 48px "${f.family}"`))).then(() => setVersion((v) => v + 1), () => {});
  }, []);
  // and the person's own: each fetched and the pages drawn again, at the start and whenever one is added
  const ownFonts = useOwnFonts();
  useEffect(() => {
    void Promise.all(ownFonts.map((f) => document.fonts.load(`400 48px "${f.family}"`))).then(() => setVersion((v) => v + 1), () => {});
  }, [ownFonts]);

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

  // opened on its first frame, whole
  const placed = useRef(false);
  useEffect(() => {
    if (placed.current || !design || !room) return;
    placed.current = true;
    // a canvas with no frame yet stays where it is: its first frame is put in the middle of it
    if (!design.pages[0]) return;
    // where this browser left it, if it was here before
    try {
      const was = JSON.parse(localStorage.getItem(`${VIEW_KEY}${id}`) ?? "null") as { x: number; y: number; z: number } | null;
      if (was && Number.isFinite(was.x) && Number.isFinite(was.y) && Number.isFinite(was.z) && was.z > 0) return view.set({ x: was.x, y: was.y, z: Math.min(ZOOM.max, Math.max(ZOOM.min, was.z)) });
    } catch {
      // no storage here: fitted as for a first visit
    }
    // no closer than its own pixels: a small frame is not blown up to fill the window
    view.set(fitView(frameOf(design.pages[0], 0, design.width, design.height), room, 56, 1));
  }, [design, room, view, id]);
  // the view kept for the next visit, a moment after it stops moving (and at once when the page goes)
  useEffect(() => {
    let due = 0;
    const keep = () => {
      due = 0;
      try {
        localStorage.setItem(`${VIEW_KEY}${id}`, JSON.stringify(view.get()));
      } catch {
        // no storage here: the next visit fits the canvas again
      }
    };
    const off = view.subscribe(() => (window.clearTimeout(due), (due = window.setTimeout(keep, 300))));
    return () => {
      off();
      if (due) (window.clearTimeout(due), keep());
    };
  }, [view, id]);

  const pages = useMemo(() => hist?.now.pages ?? [], [hist]);
  const styles = hist?.now.styles ?? NO_STYLES;
  const k = Math.max(0, Math.min(at, pages.length - 1));
  /** The frame the picked layers are on: as saved (what a change starts from), and as shown (mid-drag). */
  const top = pages[k];
  /** The container the picked layers lie in (none: the frame's own layers): a change is made among its layers, as they lie in the frame (tree.ts inScope). */
  const scope = top ? scopeOf(top.layers, selected) : null;
  const base = top && inScope(top, scope);
  // a page new in the drag (a picture dragged out of its frame) is shown too, and a loose picture round what is on it
  // (one left empty stays in its place until the drag ends, so the frames keep their numbers)
  const shown = useMemo(() => (live ? hugLoose([...pages.map((p) => live.find((l) => l.id === p.id) ?? p), ...live.filter((l) => !pages.some((p) => p.id === l.id))], false) : pages), [pages, live]);
  const page = shown[k] && inScope(shown[k]!, scope);
  /** Where every frame lies on the canvas, and the one the picked layers are on. */
  const frames = useMemo(() => (design ? pages.map((p, n) => frameOf(p, n, design.width, design.height)) : []), [pages, design]);
  const here = frames[k];
  const mine = base ? base.layers.filter((l) => selected.includes(l.id)) : [];
  const colours = useMemo(() => coloursOn(pages), [pages]);
  const picked = page ? page.layers.filter((l) => selected.includes(l.id)) : [];
  // the text being typed in, as the style panel shows it: in the style of its picked letters
  const pickedShown = textSel ? picked.map((l) => (l.id === editing && l.type === "text" ? viewRange(l, textSel.start, textSel.end) : l)) : picked;
  /** Every frame that is picked, by id: the one at `at` first. A frame that is gone (deleted somewhere else) is not among them. */
  const framedIds = useMemo(() => (framed && base ? [base.id, ...others.filter((id) => id !== base.id && pages.some((p) => p.id === id))] : []), [framed, base, others, pages]);
  const framedAt = framedIds.map((id) => pages.findIndex((p) => p.id === id));
  /** The frames, without the pictures lying loose beside them: what is saved as PNGs, and what the limit counts. */
  const frameCount = pages.filter((p) => !p.loose).length;

  // every picture and drawing the pages show, loaded once each
  useEffect(() => {
    if (!design) return;
    for (const l of pages.flatMap((p) => everyLayer(p.layers))) {
      const src = sourceOf(l);
      if (!src || loaded.has(src)) continue;
      const img = new Image();
      loaded.set(src, img);
      img.onload = () => setVersion((v) => v + 1);
      img.onerror = () => setError("A picture on a frame could not be loaded");
      img.src = l.type === "image" ? pictureUrl(design.id, src) : drawingUrl(src);
    }
    // and the pictures that fill shapes, words and frames
    for (const src of pages.flatMap(paintPictures)) {
      if (loaded.has(src)) continue;
      const img = new Image();
      loaded.set(src, img);
      img.onload = () => setVersion((v) => v + 1);
      img.src = pictureUrl(design.id, src);
    }
  }, [pages, design, loaded]);

  /**
   * What the server has of this design, as far as this window knows: the frames as they were last read from it or
   * sent to it (what this window changed since is the difference to them), and when it was last changed there.
   */
  const server = useRef<{ pages: Page[]; styles: DesignStyles; at: number }>({ pages: [], styles: {}, at: 0 });
  /** The pages not sent yet. */
  const unsaved = useRef<Page[] | null>(null);
  /** Each save on its way, oldest first: the server may have it before this window hears so (mergeFrames `sent`). Each goes when its own answer comes. */
  const sent = useRef<SentSave[]>([]);
  /** This window, as its saves name it (`by`), and how many it has sent (`n`). */
  const by = useRef(`w${Math.random().toString(36).slice(2, 14)}`);
  const sends = useRef(0);
  /** A save of these pages: on its way (sent) until its answer, which takes it off. */
  const putSave = useCallback((pages: Page[], since: number, keepalive = false, base: Page[] = server.current.pages) => {
    const save: SentSave = { pages, base };
    sent.current = withSent(sent.current, save);
    const done = () => void (sent.current = sent.current.filter((s) => s !== save));
    // offline as it goes: no answer then means it never left
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    return saveDesign(id, { pages, styles: stylesNow.current, since, by: by.current, n: ++sends.current }, keepalive).then(
      // taken: it and every save sent before it are settled
      (d) => ((sent.current = sent.current.slice(sent.current.lastIndexOf(save) + 1)), d),
      (e) => {
        const status = (e as { status?: number }).status;
        if (settles({ refused: e instanceof DesignChanged, status: typeof status === "number" ? status : undefined, offline })) done();
        throw e;
      },
    );
  }, [id]);
  /** What a save said: what the server left out, and what it changed that loses nothing. */
  const told = useCallback((d: Design & { notes?: string[]; changes?: string[] }, quiet = false) => {
    if (d.notes?.length) (quiet ? (n: string) => toast(n, { id: "design-not-saved" }) : setError)(`Not saved: ${d.notes.join("; ")}`);
    if (d.changes?.length) toast(`Saved, with a change: ${d.changes.join("; ")}`, { id: "design-saved-changed" });
  }, []);
  /** What a change made somewhere else does with the design as the server has it now (set further down, once it can be). */
  const remote = useRef<(d: Design) => boolean>(() => false);
  /** The saves, one after another: each says the design's last change this window knows of, which the one before it may have made. */
  const saving = useRef<Promise<void>>(Promise.resolve());
  /** The last save failed (not refused for a change made elsewhere, which is merged and sent again): Done stops there. */
  const failed = useRef(false);
  const send = useCallback(
    (pages: Page[]) => {
      unsaved.current = null;
      setSaved("saving");
      saving.current = saving.current.then(() => {
        return putSave(pages, server.current.at).then(
          (d) => {
            server.current = { pages, styles: d.styles ?? {}, at: d.updatedAt };
            setSaved(unsaved.current ? "unsaved" : "saved");
            // the server kept less than was sent, or changed what loses nothing: said, so nothing goes missing unseen
            told(d);
          },
          (e) => {
            // changed somewhere else while this save was on its way (an AI's frames): nothing was written. This
            // window's changes are done again on the design as it is now, and that is saved: a moment later when
            // the canvas changed with it (as any change is), at once when it did not
            if (e instanceof DesignChanged) return void (remote.current(e.design) || ((JSON.stringify(latest.current) !== JSON.stringify(e.design.pages) || JSON.stringify(stylesNow.current) !== JSON.stringify(e.design.styles ?? {})) && send(latest.current)));
            failed.current = true;
            // what is on the canvas now, never an older save (a newer one may be on its way already)
            unsaved.current ??= latest.current;
            setSaved("unsaved");
            setError(message(e));
          },
        );
      });
    },
    [putSave, told],
  );
  // saved a moment after the last change
  const first = useRef(true);
  useEffect(() => {
    if (!design || !hist) return;
    if (first.current) return void (first.current = false);
    unsaved.current = hist.now.pages;
    setSaved("unsaved");
    const t = setTimeout(() => send(hist.now.pages), 700);
    return () => clearTimeout(t);
    // the pages alone: the design's other fields change when it is saved, and saving must not save again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hist?.now]);
  // Leaving sends what that moment had not sent yet. Another page of the app: a save after the ones under way (the
  // app goes on running, so it finishes), and one refused because the design changed somewhere else in that moment is
  // made again on top of that change. The window closing: a save the browser carries on with after the page is gone,
  // which it only does for a small one (64 KB); a bigger design is sent the plain way, and may not get there.
  useEffect(() => {
    /** This window's pages put onto the design as the server has it now (`theirs`), from what it had as `base`. */
    // (and this window's styles onto the server's: each style by its id, each field from the side that changed it)
    const onto = (pages: Page[], base: Page[], theirs: Design) => {
      stylesNow.current = mergeStyles(stylesNow.current, server.current.styles, theirs.styles);
      return styled(syncInstances(mergeFrames(pages, base, layoutPages(theirs.pages, measureWords), sent.current)), stylesNow.current);
    };
    // on the way out of the page: refused for a change made elsewhere, merged onto it and sent again (three times at
    // most); what the server kept less of, or never took, is said where it still shows, as a notice
    // `keepalive`: the window closing (the browser carries the save on after the page is gone)
    const leave = (pages: Page[], base: Page[], since: number, tries = 0, keepalive = false): Promise<void> =>
      putSave(pages, since, keepalive, base).then(
        (d) => {
          // (the page may be brought back: what the server has now is what it sent)
          server.current = { pages, styles: d.styles ?? {}, at: d.updatedAt };
          told(d, true);
        },
        (e) => {
          if (e instanceof DesignChanged && tries < 3) return leave(onto(pages, base, e.design), layoutPages(e.design.pages, measureWords), e.design.updatedAt, tries + 1, keepalive);
          toast(`Not saved: the last changes to this design (${message(e)})`, { id: "design-not-saved" });
        },
      );
    const flush = (closing: boolean) => {
      const pages = unsaved.current;
      unsaved.current = null;
      if (!pages) return;
      // the window closing: at once, with what this window knew of the design, so it never writes over a change made
      // since; refused, merged onto that and sent once more (the page may be gone before a second answer)
      if (closing) return void leave(pages, server.current.pages, server.current.at, 2, true).catch(() => {});
      // what this window knew as it left: a change made since (after a save still on its way) is merged, never written over
      const was = server.current;
      saving.current = saving.current.then(() => leave(pages, was.pages, was.at));
    };
    const closing = () => flush(true);
    window.addEventListener("pagehide", closing);
    return () => {
      window.removeEventListener("pagehide", closing);
      flush(false);
    };
  }, [id, told, putSave]);

  // the pages as of the last drawing, for what finishes later (an upload)
  const latest = useRef(pages);
  useEffect(() => void (latest.current = pages), [pages]);
  /** the styles as of the last drawing: what each save sends beside the frames */
  const stylesNow = useRef(styles);
  useEffect(() => void (stylesNow.current = styles), [styles]);
  /** Frames while a drag or a preview is under way, put back whole (a container's layers back into it). */
  const setLive = useCallback((next: Page[] | null) => setLiveRaw(next && layoutPages(syncInstances(unscope(next, latest.current), latest.current), measureWords)), []);
  /**
   * One step to undo. With `merge`, a change that follows another of the same name joins it: a colour dragged about
   * in the picker is one step, not one for every shade it passed.
   */
  const merging = useRef<string | null>(null);
  const change = useCallback((fn: (pages: Page[]) => Page[], merge?: string) => {
    if (locked) return;
    const join = !!merge && merging.current === merge;
    merging.current = merge ?? null;
    setLive(null);
    // a loose picture keeps to the box round it, whatever changed it
    // and a plain group to the box round its layers
    // a frame still showing an open container's layers (tree.ts inScope) is made whole before it is kept
    // and every auto layout laid out (lib/design/layout.ts), what it fixed said once the step is drawn
    // and every instance made again from its main, what was changed on one kept as its override (lib/design/components.ts)
    // and a frame that changed remembers how far its ids went (tree.ts nextOf): one taken out is never given again
    // and a value changed on a layer naming a style leaves the style, and every style's value put on what names it (lib/design/styles.ts)
    const whole = ({ pages: all, styles: s }: Doc): Doc => ({ styles: s, pages: keepNext(hugLoose(layoutPages(styled(syncInstances(unlinked(unscope(fn(all), all), all, s), all), s), measureWords, (n) => queueMicrotask(() => toast(n, { id: n })))), all) });
    setHist((h) => (!h ? h : join ? { ...h, now: whole(h.now) } : histChange(h, whole)));
  }, [locked]);
  /** Frames changed in one step: each takes the place of the one with its id, and one with a new id is added (a picture dragged out of its frame). */
  const setPages = useCallback(
    (given: readonly Page[], merge?: string) =>
      change((all) => {
        // a frame changed while a container was open: its layers go back into that container
        const next = unscope(given, all);
        return [...all.map((p) => next.find((n) => n.id === p.id) ?? p), ...next.filter((n) => !all.some((p) => p.id === n.id))];
      }, merge),
    [change],
  );
  const setPage = useCallback((next: Page, merge?: string) => setPages([next], merge), [setPages]);
  /** The frames and the styles as they are now somewhere else (merged): one step to undo. */
  const changeDoc = useCallback((doc: Doc) => {
    merging.current = null;
    setLive(null);
    setHist((h) => (h ? histChange(h, () => doc) : h));
  }, []);
  /** The design's styles changed: every layer naming one takes its value, laid out again (a text style's size), one step to undo (`merge` as change's). */
  const changeStyles = useCallback((fn: (s: DesignStyles) => DesignStyles, merge?: string) => {
    if (locked) return;
    const join = !!merge && merging.current === merge;
    merging.current = merge ?? null;
    setLive(null);
    const restyle = (doc: Doc): Doc => {
      const s = fn(doc.styles);
      return { styles: s, pages: hugLoose(layoutPages(styled(doc.pages, s), measureWords)) };
    };
    setHist((h) => (!h ? h : join ? { ...h, now: restyle(h.now) } : histChange(h, restyle)));
  }, [locked]);
  const pick = useCallback((to: number, ids: string[], frame = false, all: string[] = []) => {
    merging.current = null;
    setAt(to);
    setSelected(ids);
    setFramed(frame);
    setOthers(frame ? all : []);
    setCropping((id) => (id && ids.length === 1 && ids[0] === id ? id : null));
    setShaping((s) => (s && ids.length === 1 && ids[0] === s.id ? s : null));
    setError(null);
  }, []);
  // the words being typed taken away (by the assistant, another window, ⌘Z): the typing ends, so its keys are the canvas's again
  useEffect(() => {
    if (editing && !base?.layers.some((l) => l.id === editing)) setEditing(null);
  }, [editing, base]);
  // the picked frame by its id: a change that takes it away (a loose piece left empty, ⌘Z, a write from elsewhere) never
  // lets `at` and the picked ids land on another frame's layers (new loose layers are l1… like a frame's first ones)
  const pickedOn = useRef<{ at: number; selected: string[]; id?: string }>({ at, selected });
  useEffect(() => {
    const was = pickedOn.current;
    const id = pages[k]?.id;
    if (was.at !== at || was.selected !== selected || !was.id) return void (pickedOn.current = { at, selected, id });
    if (id === was.id) return;
    const moved = pages.findIndex((p) => p.id === was.id);
    if (moved >= 0) return void (pickedOn.current = { at: moved, selected, id: was.id }, setAt(moved));
    pickedOn.current = { at, selected: [], id };
    pick(at, []);
  }, [pages, k, at, selected, pick]);
  const step = (back: boolean) => {
    if (locked) return;
    merging.current = null;
    setLive(null);
    // the path being shaped may have other points now: none of them is the picked one
    setShaping((s) => s && { ...s, anchor: null });
    setHist((h) => (h ? (back ? histUndo(h) : histRedo(h)) : h));
  };

  // A change made somewhere else (the assistant designing the frames, another window) is shown at once, as a step ⌘Z
  // takes back. This window's own saves are not told back to it (lib/sync.ts), and a notice about another design, or
  // an answer that comes late, changes nothing (the design is no newer than what this window knows). What was changed
  // here and not sent yet stays as it is here, and is then sent: the hand that was on it is never thrown away. That
  // goes by what was changed (mergeFrame): a frame dragged aside here while its layers were designed there keeps its
  // new place and gets the new layers. Every other frame is the server's, and what came from the server is not saved back.
  useEffect(() => {
    /** The design as the server has it now, onto this window. True: the canvas changed (and is saved again when this window had changes of its own). */
    remote.current = (d) => {
      if (d.updatedAt <= server.current.at) return false;
      const had = latest.current;
      // laid out as this window lays out (on load, above)
      const theirs = layoutPages(d.pages, measureWords);
      // instances made again: a main changed on one side reaches the instances the other side changed; the styles merged
      // style by style, and put on the frames again
      const hadStyles = stylesNow.current;
      const mergedStyles = mergeStyles(hadStyles, server.current.styles, d.styles);
      const merged = layoutPages(styled(syncInstances(mergeFrames(had, server.current.pages, theirs, sent.current)), mergedStyles), measureWords);
      server.current = { pages: theirs, styles: d.styles ?? {}, at: d.updatedAt };
      setDesign(d);
      const text = JSON.stringify([merged, mergedStyles]);
      // nothing of this window's is left to send: what is on the canvas is what the server has
      if (text === JSON.stringify([theirs, d.styles ?? {}])) {
        unsaved.current = null;
        setSaved("saved");
      }
      if (text === JSON.stringify([had, hadStyles])) return false;
      if (text === JSON.stringify([theirs, d.styles ?? {}])) first.current = true;
      // at once for whatever is sent before the canvas is drawn again
      latest.current = merged;
      stylesNow.current = mergedStyles;
      changeDoc({ pages: merged, styles: mergedStyles });
      // frames arriving on a canvas that had none (the assistant designing it): shown whole, no closer than their own
      // pixels, and the frame tool (out on an empty canvas) put away
      if (!had.length && merged.length) {
        setTool("move");
        if (roomNow.current) view.glide(fitView(boundsOf(merged.map((p, n) => frameOf(p, n, d.width, d.height))), roomNow.current, 56, 1));
      }
      return true;
    };
    return onTopic("designs", () => void getDesign(id).then((d) => remote.current(d), () => {}));
  }, [id, changeDoc, view]);

  /** The saved page with every picked layer through `fn`. */
  const through = (fn: (l: Layer) => Layer): Page | null => (base ? { ...base, layers: base.layers.map((l) => (selected.includes(l.id) ? fn(l) : l)) } : null);
  const patch = (fn: (l: Layer) => Layer, merge?: string) => {
    const next = through(fn);
    if (next) setPage(next, merge);
  };
  const arrange = (next: Layer[]) => base && setPage({ ...base, layers: base.layers.map((l) => next.find((n) => n.id === l.id) ?? l) });

  /** New layers on a frame (to < 0: lying loose on the canvas, in its pixels, a piece of their own), picked; null (and it says why) when there is no room. */
  const put = (to: number, count: number, make: (ids: string[]) => Layer[], above?: string): string[] | null => {
    if (to < 0) {
      if (!count) return null;
      const all = latest.current;
      if (all.filter((p) => p.loose).length >= DESIGN_LIMITS.loose) return setError(`A canvas holds at most ${DESIGN_LIMITS.loose} pieces outside its frames`), null;
      const ids = Array.from({ length: count }, (_, n) => `l${n + 1}`);
      // its box is drawn round its layers (hugLoose); after every frame and every other loose piece
      change((now) => [...now, { id: `p${Date.now().toString(36)}`, loose: true, x: 0, y: 0, w: DESIGN_LIMITS.frameMin, h: DESIGN_LIMITS.frameMin, background: "#ffffff", layers: reid(make(ids), ids, []) }]);
      pick(all.length, ids);
      return ids;
    }
    const real = latest.current[to];
    if (!real || !count) return null;
    // a paste or a copy (just above a picked layer): among the picked layers, in the container they lie in; anything new
    // drawn or dropped: on the frame itself
    const target = to === k && above ? inScope(real, scope) : real;
    const ids = freshIds(real, count);
    // every layer inside a copied container gets an id of its own too; a group among the new layers stays a group among
    // themselves (copies do not join the group they were copied from)
    const made = regroup(reid(make(ids), ids, real.layers), target.layers);
    if (everyLayer(real.layers).length + everyLayer(made).length > DESIGN_LIMITS.layers) return setError(`A frame holds at most ${DESIGN_LIMITS.layers} layers`), null;
    // containers go so deep at most, counting the one they land in (the server would leave the deeper ones out)
    const inside = target === real || !scope ? 0 : (pathTo(real.layers, scope)?.length ?? 0) + 1;
    if (inside + depthOf(made) > DESIGN_LIMITS.depth) return setError(`Groups go at most ${DESIGN_LIMITS.depth} deep`), null;
    // just above the layer `above`, else in front of them all
    const n = above ? target.layers.findIndex((l) => l.id === above) + 1 : 0;
    setPage({ ...target, layers: n > 0 ? [...target.layers.slice(0, n), ...made, ...target.layers.slice(n)] : [...target.layers, ...made] });
    pick(to, ids);
    return ids;
  };
  /** Words on a frame `width` wide: their size goes by it. */
  const textLayer = (id: string, text: string, r: Rect, width: number): Layer => ({ id, type: "text", text, font: "Inter", size: Math.round(width * 0.06), color: "#111111", align: "left", ...r });

  /**
   * A new frame, picked. `like`: a copy of that frame. `rect`: where the frame tool drew it. `size`: one of the picture
   * sizes, picked from the panel. Without a `rect` it goes beside the rightmost frame (on a canvas with no frame yet,
   * in the middle of what is in view), the size given or that of the frame it was made from, and the canvas moves to
   * show it: a size picked from the panel fills the view, no closer than its own pixels. Answers the frame, or nothing
   * when the canvas is full.
   */
  const addFrame = (like?: Page, rect?: Rect, size?: { w: number; h: number }): Page | undefined => {
    if (!design) return undefined;
    if (frameCount >= DESIGN_LIMITS.pages) return void setError(`A design holds at most ${DESIGN_LIMITS.pages} frames`);
    // a loose picture's size is no frame's
    const dims = size ?? (here && !base?.loose ? here : { w: design.width, h: design.height });
    const v = view.aim();
    // beside the frames, level with the current one (loose pictures are not frames to line up with)
    const r = rect ?? (frameCount ? besideFrames(frames.filter((_, n) => !pages[n]!.loose), base?.loose ? undefined : here, dims) : { x: Math.round(((room?.w ?? 0) / 2 - v.x) / v.z - dims.w / 2), y: Math.round(((room?.h ?? 0) / 2 - v.y) / v.z - dims.h / 2), w: dims.w, h: dims.h });
    // a copy is a frame of its own: the carousel slide its original draws stays the original's
    const fresh: Page = { ...(like ? { ...like, block: undefined } : { background: base?.background ?? "#ffffff", layers: [] }), id: `p${Date.now().toString(36)}`, x: r.x, y: r.y, w: r.w, h: r.h };
    change((all) => [...all, fresh]);
    // a canvas's first frame is there: the frame tool (out on an empty canvas) is put away
    if (!frameCount) setTool("move");
    // after the frames, before the loose pictures (hugLoose)
    pick(frameCount, [], true);
    // a size picked from the panel, and a canvas's first frame: it fills the view; else the canvas moves to show it
    if ((size || !frameCount) && !rect && room) view.glide(fitView(r, room, 56, 1));
    else if (!rect && room) view.glide({ ...v, x: room.w / 2 - (r.x + r.w / 2) * v.z, y: room.h / 2 - (r.y + r.h / 2) * v.z });
    return fresh;
  };
  /** A copy of the current frame in another size beside the frames, its layers placed by their pins and their share of it. */
  const copySize = (size: { w: number; h: number; name: string }) => top && !top.loose && addFrame({ ...resized(top, size, "share"), name: `${pageName(top, k)} ${size.name}`.slice(0, 60) }, undefined, size);
  /** A box drawn with the frame tool: a click makes a frame the size of the current one (the first frame of a canvas: the design's own size), a drag the size drawn. */
  const makeFrame = (r: Rect, dragged: boolean) => {
    setTool("move");
    if (!design) return;
    const like = here && !base?.loose ? here : { w: design.width, h: design.height };
    const fit = (n: number) => Math.min(DESIGN_LIMITS.frameMax, Math.max(DESIGN_LIMITS.frameMin, Math.round(n)));
    addFrame(undefined, { x: Math.round(r.x), y: Math.round(r.y), w: dragged ? fit(r.w) : like.w, h: dragged ? fit(r.h) : like.h });
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
    } else if (framed && framedIds.length) {
      // every picked frame goes: the last one too, and the canvas is empty again
      change((all) => all.filter((p) => !framedIds.includes(p.id)));
      pick(Math.max(0, Math.min(...framedAt) - 1), [], pages.length > framedIds.length);
    }
  };
  /** A copy of every picked frame, each beside the rightmost frame and level with the one it copies; the copies are picked. */
  const copyFrames = () => {
    if (frameCount + framedIds.length > DESIGN_LIMITS.pages) return setError(`A design holds at most ${DESIGN_LIMITS.pages} frames`);
    const taken = [...frames];
    // loose pictures picked with the frames are not copied: a copy is a frame
    const fresh = framedAt.filter((n) => !pages[n]!.loose).map((n, m): Page => {
      const r = besideFrames(taken, frames[n]!, frames[n]!);
      taken.push(r);
      // a copy is a frame of its own: the carousel slide its original draws stays the original's
      return { ...pages[n]!, block: undefined, id: `p${Date.now().toString(36)}${m}`, x: r.x, y: r.y, w: r.w, h: r.h };
    });
    if (!fresh.length) return;
    change((all) => [...all, ...fresh]);
    pick(frameCount, [], true, fresh.map((p) => p.id));
  };
  /** The last layers duplicated: what they copied and the copies' ids, while the copies are what is picked. */
  const dup = useRef<{ k: number; from: Layer[]; ids: string[] } | null>(null);
  useEffect(() => {
    const d = dup.current;
    if (d && (selected.length !== d.ids.length || selected.some((id) => !d.ids.includes(id)))) dup.current = null;
  }, [selected]);
  // a copy lies on what it copies, just above it, picked: the next drag takes it away. Duplicated again while the
  // copies are still picked, the new copies take the same step (move and turn) from them as they took from theirs
  const duplicate = () => {
    if (!mine.length) return framedIds.length > 1 ? copyFrames() : framed && base ? addFrame(base) : undefined;
    const d = dup.current;
    const copies = d && d.k === k ? d.ids.map((id) => mine.find((l) => l.id === id)) : [];
    const s = d && copies.every(Boolean) && copies.length === mine.length ? dupStep(d.from, copies as Layer[]) : { dx: 0, dy: 0, turn: 0 };
    const from = [...mine];
    // shortcut: each copy turns about its own middle; several turned about their shared middle would need their places turned too
    const ids = put(k, mine.length, (ids) => mine.map((l, n) => ({ ...l, id: ids[n]!, x: Math.round(l.x + s.dx), y: Math.round(l.y + s.dy), rotate: s.turn ? turnTo(l.rotate ?? 0, s.turn, false) || undefined : l.rotate })), mine.at(-1)!.id);
    if (ids) dup.current = { k, from, ids };
  };
  const order = (front: boolean) => {
    if (!base || !mine.length) return;
    const rest = base.layers.filter((l) => !selected.includes(l.id));
    setPage({ ...base, layers: front ? [...rest, ...mine] : [...mine, ...rest] });
  };
  /**
   * The picked layers made one layer that holds them (tree.ts wrap): a plain group, or with `box` a frame round them
   * (⌥⌘G), lying where the frontmost of them was, they in the order they had and where they were. It is picked.
   */
  const group = (box = false, made?: (g: GroupLayer) => GroupLayer, wrapped: (inner: Layer[], id: string) => Layer[] | null = (inner, id) => wrap(inner, selected, id, box), these = mine) => {
    if (!base || !top || !these.length) return;
    // containers go so deep at most, counting the one they are in
    if ((pathTo(top.layers, these[0]!.id)?.length ?? 0) + 1 + depthOf(these) > DESIGN_LIMITS.depth) return setError(`Groups go at most ${DESIGN_LIMITS.depth} deep`);
    if (everyLayer(top.layers).length >= DESIGN_LIMITS.layers) return setError(`A frame holds at most ${DESIGN_LIMITS.layers} layers, counting those inside groups`);
    const [id] = freshIds(top, 1);
    const next = wrapped(base.layers, id!);
    if (!next) return;
    setPage({ ...base, layers: made ? next.map((l) => (l.id === id && isGroup(l) ? made(l) : l)) : next });
    pick(k, [id!]);
  };
  /**
   * The picked layers made one shape (⌥⌘U, ⌥⌘S, ⌥⌘I, ⌥⌘X): a boolean group of them in the bottom one's fills and lines,
   * they still there to change inside it. A picked boolean group alone is changed to combine that way.
   */
  const combineShapes = (op: DesignBoolean) => {
    if (mine.length === 1 && isGroup(mine[0]) && mine[0].boolean) return patch((l) => (isGroup(l) && l.boolean ? { ...l, boolean: op } : l));
    if (mine.length < 2) return;
    group(false, (g) => {
      const fills = fillsOf(g.layers[0]!);
      const strokes = strokesOf(g.layers[0]!);
      return { ...g, boolean: op, fills: fills.length ? fills : [{ type: "solid", color: "#d9d9d9" }], ...(strokes.length ? { strokes } : {}) };
    });
  };
  /**
   * The picked layer made a mask of what lies above it, or a mask no more (⌃⌘M, Ctrl+Alt+M); several: grouped, the
   * bottom one their mask. In an auto layout box it is grouped with the layer above it (tree.ts maskWithNext).
   */
  const useAsMask = () => {
    const one = mine.length === 1 ? mine[0]! : null;
    const above = one && base ? base.layers[base.layers.findIndex((l) => l.id === one.id) + 1] : undefined;
    if (one && !one.mask && above && !above.mask && top && flows(parentOf(top.layers, one.id))) return group(false, undefined, (inner, id) => maskWithNext(inner, one.id, id), [one, above]);
    if (one) return patch((l) => ({ ...l, mask: l.mask ? undefined : "alpha" }) as Layer);
    group(false, (g) => ({ ...g, name: "Mask group", layers: g.layers.map((l, n) => (n ? l : ({ ...l, mask: "alpha" } as Layer))) }));
  };
  /**
   * Auto layout added to the picked layers (⇧A, layout.ts addAutoLayout): one group or box is given it in place, else
   * they are wrapped in a box that has it, hugging them, in the order they lie in. It is picked.
   */
  const autoLayout = () => {
    if (!base || !top || !mine.length || (mine.length === 1 && flows(mine[0]))) return;
    const inPlace = mine.length === 1 && isGroup(mine[0]);
    if (!inPlace && (pathTo(top.layers, mine[0]!.id)?.length ?? 0) + 1 + depthOf(mine) > DESIGN_LIMITS.depth) return setError(`Groups go at most ${DESIGN_LIMITS.depth} deep`);
    if (!inPlace && everyLayer(top.layers).length >= DESIGN_LIMITS.layers) return setError(`A frame holds at most ${DESIGN_LIMITS.layers} layers, counting those inside groups`);
    const [id] = freshIds(top, 1);
    const made = addAutoLayout(base.layers, selected, id!, measureWords);
    if (!made) return;
    setPage({ ...base, layers: made.layers });
    pick(k, [made.id]);
  };
  /** The picked containers taken apart, their layers where they are, picked; and the older groups a picked layer is in (a shared `group` name): its layers single layers again. */
  const ungroup = () => {
    if (!base) return;
    const boxes = mine.filter(isGroup);
    const groups = new Set(mine.map((l) => l.group).filter(Boolean));
    if (!boxes.length && !groups.size) return;
    const freed = boxes.flatMap((g) => g.layers.map((l) => l.id));
    setPage({ ...base, layers: unwrap(base.layers, boxes.map((g) => g.id)).map((l) => (l.group && groups.has(l.group) ? { ...l, group: undefined } : l)) });
    if (freed.length) pick(k, [...mine.filter((l) => !isGroup(l)).map((l) => l.id), ...freed]);
  };
  /** The picked containers made frames (a box of their own) or plain groups (the box round their layers, no fill, line or clip). */
  const convert = (box: boolean) =>
    patch((l) => {
      if (!isGroup(l)) return l;
      if (box) {
        // a frame of its own is no combined shape: its layers are drawn as they are
        const { boolean: _o, ...rest } = l;
        return { ...rest, box: true };
      }
      // its auto layout goes with it (its layers stay where they are)
      const { box: _b, fills: _f, strokes: _s, radius: _r, smooth: _m, clip: _c, ...plain } = withoutLayout(l);
      return plain;
    });
  /**
   * The picked layers made a main component (⌥⌘K, lib/design/components.ts): one plain group or box in place, else they
   * are grouped first. Several mains picked: combined as variants of one set.
   */
  const makeComponent = () => {
    if (!base || !top || !mine.length || instanceAround(pathTo(top.layers, mine[0]!.id) ?? [])) return;
    if (mine.length > 1 && mine.every(isMain)) return combineVariants();
    const key = freshKey(pages);
    const one = mine.length === 1 ? mine[0]! : null;
    if (one && isGroup(one) && !one.instance && one.component === undefined) return patch((l) => (isGroup(l) ? { ...l, component: key, name: l.name ?? "Component" } : l));
    if (one && (isMain(one) || isInstance(one))) return;
    group(false, (g) => ({ ...g, component: key, name: "Component" }));
  };
  /** Picked mains made variants of one set: each its value of the set's property from its name ("Size=4:5, Theme=Dark", or the name itself). */
  const combineVariants = () => {
    const set = mine[0]?.name ?? "Component";
    const variantOf = (n: string): Record<string, string> => {
      const pairs = n.split(",").map((p) => p.split("=").map((x) => x.trim()));
      return pairs.every((p) => p.length === 2 && p[0] && p[1]) ? Object.fromEntries(pairs) : { "Property 1": n };
    };
    patch((l) => (isMain(l) ? { ...l, set, variant: variantOf(l.name ?? l.component) } : l));
  };
  /** A layer of the picked frame (however deep, by its id) through `fn`. */
  const onLayer = (id: string, fn: (l: Layer) => Layer) => top && setPage({ ...top, layers: mapLayers(top.layers, (l) => (l.id === id ? fn(l) : l)) });
  /** An instance of main `key` placed in the middle of the picked frame, picked. */
  const placeInstance = (key: string) => {
    const m = mainsOf(pages).get(key)?.main;
    const f = top && !top.loose ? frameOf(top, k, design?.width ?? 0, design?.height ?? 0) : null;
    if (!m || !f) return;
    put(k, 1, ([id]) => [{ type: "group", id: id!, x: Math.round((f.w - m.w) / 2), y: Math.round((f.h - m.h) / 2), w: m.w, h: m.h, layers: [], instance: { of: key } }]);
  };
  /** The main component an instance shows, picked on its frame. */
  const goToMain = (key: string) => {
    const at = mainsOf(pages).get(key);
    const n = at ? pages.findIndex((p) => p.id === at.page) : -1;
    if (at && n >= 0) pick(n, [at.main.id]);
  };

  const outward = () => scope && pick(k, [scope]);
  const toggle = (flag: "hidden" | "locked") => {
    const all = mine.every((l) => l[flag]);
    patch((l) => ({ ...l, [flag]: all ? undefined : true }) as Layer);
  };
  /** A layer's look, copied (⌥⌘C) to put on others (⌥⌘V): its fills, lines, effects, type and the styles they name. */
  const [copiedLook, setCopiedLook] = useState<Look | null>(null);
  const copyLook = () => mine.length === 1 && (setCopiedLook(lookOf(mine[0]!)), toast("Style copied", { id: "design-style-copied" }));
  const pasteLook = () => copiedLook && patch((l) => withLook(l, copiedLook));
  const copy = () => {
    if (!mine.length) return;
    const taken: NonNullable<typeof clip> = { layers: mine, text: mine.map(layerName).join("\n"), wrote: false, from: design?.id };
    clip = taken;
    try {
      void navigator.clipboard?.writeText(taken.text).then(() => void (taken.wrote = true), () => {});
    } catch {
      // no clipboard here: the layers are kept all the same
    }
  };
  /** The middle of what is in view, on the canvas. */
  const middle = () => {
    const v = view.aim();
    return { x: ((room?.w ?? 0) / 2 - v.x) / v.z, y: ((room?.h ?? 0) / 2 - v.y) / v.z };
  };
  /** The copied layers onto this frame, where they were on theirs. A picture this design does not have stays behind. */
  const paste = () => {
    // from another design: its components are plain layers here (a key there names nothing, or another component, here)
    const elsewhere = clip?.from !== design?.id;
    const layers = mapLayers(clip?.layers ?? [], (l) => (l.type === "image" && !design?.pictures.includes(l.picture) ? null : elsewhere ? plainOf(l) : l));
    // a canvas with no frame yet: they lie loose in the middle of the view
    if (!here) {
      if (!layers.length) return;
      const b = boundsOf(layers);
      const m = middle();
      return void put(-1, layers.length, (ids) => rehome(layers, { x: Math.round(m.x - b.w / 2), y: Math.round(m.y - b.h / 2) }, b).map((l, n) => ({ ...l, id: ids[n]! })));
    }
    if (!layers.length) return;
    // where they were, unless that is out of sight: then in the middle of the view; a frame picked by itself takes them in its middle
    const b = boundsOf(layers);
    const v = view.get();
    const seen = room ? { x: -v.x / v.z - here.x, y: -v.y / v.z - here.y, w: room.w / v.z, h: room.h / v.z } : null;
    const mid = framed ? { x: here.w / 2, y: here.h / 2 } : seen && !intersects(b, seen) ? { x: seen.x + seen.w / 2, y: seen.y + seen.h / 2 } : null;
    const dx = mid ? Math.round(mid.x - b.x - b.w / 2) : 0;
    const dy = mid ? Math.round(mid.y - b.y - b.h / 2) : 0;
    // a layer picked: just above it
    put(k, layers.length, (ids) => layers.map((l, n) => ({ ...l, id: ids[n]!, x: l.x + dx, y: l.y + dy })), mine.at(-1)?.id);
  };

  const zoom = (to: "in" | "out" | "fit" | "selection" | number) => {
    if (!room) return;
    if (to === "fit" || to === "selection") {
      // a canvas with no frame has nothing to fit
      if (!here) return;
      // fit: every frame of the canvas
      if (to === "fit") return view.glide(fitView(boundsOf(frames), room, FIT_PAD));
      const b = mine.length ? boundsOf(mine) : null;
      const all = framedAt.length > 1 ? boundsOf(framedAt.map((n) => frames[n]!)) : here;
      return view.glide(fitView(b ? { ...b, x: b.x + here.x, y: b.y + here.y } : all, room, FIT_PAD));
    }
    // in and out: to the next stop, about the middle of the canvas, from where a glide under way is headed (two
    // presses in a row are two stops)
    const v = view.aim();
    view.glide(zoomAt(v, to === "in" ? zoomStop(v.z, true) : to === "out" ? zoomStop(v.z, false) : to, room.w / 2, room.h / 2));
  };

  /** The view on frame `to`, or on its layer `id`, as close as fits (a double click on its icon in the layers list). */
  const zoomTo = (to: number, id?: string) => {
    const f = frames[to];
    if (!f || !room) return;
    const l = id && pages[to] ? inFrame(pages[to]!.layers, id) : undefined;
    const b = l ? boundsOf([l]) : null;
    view.glide(fitView(b ? { ...b, x: b.x + f.x, y: b.y + f.y } : f, room, FIT_PAD));
  };
  /** Several frames picked, by their boxes on the canvas, and those boxes put back as the frames' new places. */
  const framesBoxes = () => framedAt.map((n) => ({ ...frames[n]!, id: pages[n]!.id }));
  const placeFrames = (boxes: readonly (Rect & { id: string })[]) => setPages(boxes.map((r) => ({ ...pages.find((p) => p.id === r.id)!, x: Math.round(r.x), y: Math.round(r.y) })));
  const manyFrames = !mine.length && framedIds.length > 1;
  // one layer lines up with what it lies in: the open container's box, else the frame
  const holder = top && scope ? boundsOf([inFrame(top.layers, scope)!]) : here && { w: here.w, h: here.h };
  const align = (how: Align) => (manyFrames ? placeFrames(alignLayers(framesBoxes(), how, here ?? { w: 0, h: 0 })) : holder && arrange(alignLayers(mine, how, holder)));
  const spread = (axis: "x" | "y") => (manyFrames ? placeFrames(distribute(framesBoxes(), axis)) : arrange(distribute(mine, axis)));
  /** Tidy up (feel.ts tidy): null when what is picked is not a row, a column or a grid. */
  const tidied = manyFrames ? tidy(framesBoxes()) : tidy(mine);
  const tidyUp = () => tidied && (manyFrames ? placeFrames(tidied as (Rect & { id: string })[]) : arrange(tidied as Layer[]));

  /**
   * Pictures from this computer (the Picture button, a paste, a drop). `drop`: where on the canvas they were let go.
   * Let go over a frame, they are layers of that frame, the first with its middle at that point. Let go on empty
   * canvas, each lies loose on it, at its own size, outside every frame. Without a `drop` they go onto the current
   * frame, in its middle (with no frame picked or none on the canvas: loose, in the middle of the view). Each shows at once, from the file itself, under the id it will have; it is sent to the server
   * before any save that names it, and taken back out (and why said) when it cannot be.
   */
  const fromComputer = async (given: readonly File[], drop?: { x: number; y: number }) => {
    if (locked) return;
    const files = given.filter(isPicture);
    if (!design || !given.length) return;
    if (!files.length) return setError("Only JPEG, PNG and WebP pictures can be put on a canvas");
    // a frame under the point (the later one where two lie over each other); loose pictures are not frames to land in
    const over = drop ? frames.map((r, n) => !pages[n]!.loose && drop.x >= r.x && drop.x <= r.x + r.w && drop.y >= r.y && drop.y <= r.y + r.h).lastIndexOf(true) : base && !base.loose ? k : -1;
    // no frame to land on: they lie loose, where they were let go or in the middle of the view
    const alone = over < 0;
    const v = view.aim();
    const spot = drop ?? { x: ((room?.w ?? 0) / 2 - v.x) / v.z, y: ((room?.h ?? 0) / 2 - v.y) / v.z };
    const onto = pages[over]?.id;
    const f = frames[over];
    setError(null);
    const space = alone ? DESIGN_LIMITS.loose - latest.current.filter((p) => p.loose).length : files.length;
    if (space < files.length) setError(`A canvas holds at most ${DESIGN_LIMITS.loose} pieces outside its frames`);
    const got: { picture: string; w: number; h: number }[] = [];
    for (const file of files.slice(0, Math.max(0, space))) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
      } catch {
        URL.revokeObjectURL(url);
        setError(`${file.name} could not be read`);
        continue;
      }
      // ponytail: the file's address stays open while the page does, as what the picture is drawn from
      const picture = pictureId(file);
      loaded.set(picture, img);
      got.push({ picture, w: img.naturalWidth, h: img.naturalHeight });
      // sent before any save that names it: a save naming a picture the server does not have yet would lose it.
      // The design is newer by this picture alone when this window knew it just before: it goes on from the new stamp
      saving.current = saving.current.then(() =>
        addPicture(design.id, file, picture, (updatedAt, was) => void (server.current.at === was && (server.current = { ...server.current, at: updatedAt }))).then(
          () => {},
          (e) => {
            setError(`${file.name}: ${message(e)}`);
            setDesign((d) => (d ? { ...d, pictures: d.pictures.filter((x) => x !== picture) } : d));
            change((all) => all.map((p) => ({ ...p, layers: mapLayers(p.layers, (l) => (l.type === "image" && l.picture === picture ? null : l)) })));
          },
        ),
      );
    }
    if (!got.length) return;
    setDesign((d) => (d ? { ...d, pictures: [...d.pictures, ...got.map((g) => g.picture)] } : d));
    if (alone) {
      const fresh = pictureFrames(got, spot.x, spot.y, got.map((_, n) => `p${Date.now().toString(36)}${n}`)).map((p) => ({ ...p, loose: true as const }));
      const from = latest.current.length;
      change((all) => [...all, ...fresh]);
      setTool("move");
      pick(from, fresh[0]!.layers.map((l) => l.id));
      return;
    }
    // at most 60 % of the frame's width, in the picture's own shape; at the point they were let go, else in the middle
    const made = got.map((g) => {
      const w = Math.round(Math.min(f!.w * 0.6, g.w));
      return { picture: g.picture, w, h: Math.round((w * g.h) / g.w) };
    });
    const cx = drop ? drop.x - f!.x : f!.w / 2;
    const cy = drop ? drop.y - f!.y : f!.h / 2;
    // onto the frame it was started on, as that frame is by now; several step down and to the right
    put(latest.current.findIndex((p) => p.id === onto), made.length, (ids) => made.map((m, n) => ({ id: ids[n]!, type: "image", picture: m.picture, fit: "cover", x: Math.round(cx - m.w / 2) + n * 24, y: Math.round(cy - m.h / 2) + n * 24, w: m.w, h: m.h })));
  };
  /** Files held over the page: the canvas shows that it takes them. */
  const [dropping, setDropping] = useState(false);
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");
  /** Let go anywhere on the page: over the canvas they land where they were let go, over a panel on the current frame. */
  const dropped = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDropping(false);
    if (locked) return;
    const r = frame.current?.getBoundingClientRect();
    const onCanvas = !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    const v = view.get();
    void fromComputer([...e.dataTransfer.files], onCanvas ? { x: (e.clientX - r.left - v.x) / v.z, y: (e.clientY - r.top - v.y) / v.z } : undefined);
  };

  /**
   * The picked picture with its background taken away. The cut-out is a new picture of the design, and the layer
   * keeps the one it was cut from, so ⌘Z (or the panel) puts the background back.
   */
  /**
   * A call to a Mac of the person's own (a cut-out, a split), said as it goes: a Mac of theirs that is not reachable is
   * named, and in the Mac app the call is made on this Mac instead, with Stop. In a browser the line stays, with Settings.
   */
  const withMac = async <T,>(run: (signal: AbortSignal) => Promise<T>): Promise<T | null> => {
    const stop = new AbortController();
    setMacNote(null);
    try {
      return await onThisMac(() => run(stop.signal), { signal: stop.signal, onHere: (text) => setMacNote({ text, stop: () => stop.abort() }) });
    } catch (e) {
      if (stop.signal.aborted) return null;
      const no = e as SendError;
      if (no.code !== "no_mac") throw e;
      setMacNote({ text: no.device ? `${no.message}. Open Creator Toolset on it, then retry.` : no.message });
      return null;
    } finally {
      setMacNote((n) => (n?.stop ? null : n));
    }
  };

  const cutOut = async () => {
    const l = mine.length === 1 ? mine[0]! : null;
    if (!design || !base || l?.type !== "image" || cutting) return;
    const onto = base.id;
    setCutting(true);
    setError(null);
    try {
      const cut = await withMac((signal) => cutOutPicture(design.id, l.picture, signal));
      if (!cut) return;
      setDesign((d) => (d ? { ...d, pictures: [...d.pictures, cut] } : d));
      // onto the layer as it is by now: the cutting took a while
      const page = latest.current.find((p) => p.id === onto);
      const now = page && findLayer(page.layers, l.id);
      if (page && now?.type === "image") setPage({ ...page, layers: mapLayers(page.layers, (x) => (x.id === l.id ? { ...now, picture: cut, uncut: now.uncut ?? now.picture } : x)) });
    } catch (e) {
      setError(message(e));
    } finally {
      setCutting(false);
    }
  };

  /** The picked picture split into layers by a Mac of the person's own (lib/design/split.ts): one step ⌘Z takes back. */
  const split = async () => {
    if (locked) return;
    const l = mine.length === 1 ? mine[0]! : null;
    if (!design || !base || l?.type !== "image" || cutting) return;
    const img = loaded.get(sourceOf(l) ?? "") as HTMLImageElement | undefined;
    if (!img?.naturalWidth) return setError("The picture is still loading");
    const onto = base.id;
    setCutting(true);
    setError(null);
    try {
      const a = await withMac((signal) => splitPicture(design.id, l.picture, signal));
      if (!a) return;
      setDesign((d) => (d ? { ...d, pictures: [...d.pictures, a.background, ...a.pieces.map((p) => p.picture)] } : d));
      // onto the frame as it is by now: the Mac took a while
      // among the layers of the container it lies in (tree.ts inScope), its new layers' ids the frame's own
      const real = latest.current.find((p) => p.id === onto);
      const page = real && inScope(real, scopeOf(real.layers, [l.id]));
      if (real && page?.layers.some((x) => x.id === l.id && x.type === "image")) {
        const next = splitLayers(page, l.id, { width: img.naturalWidth, height: img.naturalHeight }, a, real.layers);
        setPage(next);
        setSelected(next.layers.filter((x) => !page.layers.some((y) => y.id === x.id)).map((x) => x.id));
        if (!a.lines.length && !a.pieces.length) setError("No words or objects found in this picture: it is one layer named Background");
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setCutting(false);
    }
  };

  /** A line drawn with the pen, as a layer: closed, a filled shape; open, a line alone. */
  const makePath = (to: number, path: { x: number; y: number; w: number; h: number; points: { x: number; y: number; in?: [number, number]; out?: [number, number] }[]; closed: boolean }) => {
    const { closed, ...rest } = path;
    put(to, 1, ([id]) => [{ id: id!, type: "path", ...rest, ...(closed ? { closed: true, fill: "#d9d9d9" } : { stroke: { color: "#111111", width: 6, round: true } }) }]);
    setTool("move");
  };
  /** The picked point of the path being shaped taken out; a path left with one point goes with it. */
  const removePoint = () => {
    const l = base?.layers.find((x) => x.id === shaping?.id);
    if (!base || !shaping || shaping.anchor === null || l?.type !== "path") return;
    const px = inPixels(l).filter((_, n) => n !== shaping.anchor);
    setShaping(px.length < 2 ? null : { id: l.id, anchor: null });
    if (px.length < 2) return void (setPage({ ...base, layers: base.layers.filter((x) => x.id !== l.id) }), setSelected([]));
    // a closed line needs three points to hold anything
    setPage({ ...base, layers: base.layers.map((x) => (x.id === l.id ? refit({ ...l, closed: l.closed && px.length > 2 ? true : undefined }, px) : x)) });
  };

  /** A box drawn with a making tool: a click makes the usual size, a drag the size drawn. */
  const make = (to: number, r: Rect, dragged: boolean) => {
    // loose on the canvas (to < 0): sized as on a frame of the design's own size
    const f = to < 0 && design ? { w: design.width, h: design.height } : frames[to];
    if (!f || tool === "move" || tool === "hand" || tool === "frame" || tool === "pen") return;
    const words = tool === "text";
    const b = { x: Math.round(r.x), y: Math.round(r.y), w: Math.max(1, Math.round(dragged ? r.w : words ? f.w / 2 : 100)), h: Math.max(1, Math.round(dragged ? r.h : words ? f.w * 0.08 : 100)) };
    const ids = put(to, 1, ([id]) => [tool === "text" ? textLayer(id!, "Text", b, f.w) : { id: id!, type: "shape", shape: tool, fill: "#d9d9d9", ...b }]);
    setTool("move");
    if (ids && words) setEditing(ids[0]!);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // words being typed with focus on a button of the style panel: their keys are not the canvas's (Backspace, Delete, the
      // tool letters); ⌘Z, the arrows and Escape still reach the canvas
      const wordKey = !mod && !e.altKey && (e.key === "Backspace" || e.key === "Delete" || e.key.length === 1);
      if (typingIn(e.target) || !design || (editing && wordKey)) return;
      const c = e.code;
      const has = mine.length > 0;
      const run = (fn: () => unknown) => (e.preventDefault(), void fn());
      // nothing picked: the arrows pan the view
      const pan = ARROWS[e.key];
      if (pan && !mod && !e.altKey && !has && !framed && !shaping && !cropping)
        return run(() => {
          const v = view.aim();
          const d = e.shiftKey ? PAN_STEP.far : PAN_STEP.near;
          view.glide({ ...v, x: v.x - pan[0] * d, y: v.y - pan[1] * d }, 100);
        });
      // a canvas with no frame yet: the zoom, the tools and undo, nothing else
      if (!base || !here) {
        if (mod && c === "KeyZ") run(() => step(!e.shiftKey));
        else if (!e.altKey && (e.key === "+" || e.key === "=")) run(() => zoom("in"));
        else if (!e.altKey && e.key === "-") run(() => zoom("out"));
        else if (!e.altKey && (mod || e.shiftKey) && c === "Digit0") run(() => zoom(1));
        else if (!mod && !e.altKey && !e.shiftKey && TOOL_KEYS[c]) run(() => setTool(TOOL_KEYS[c]!));
        else if (e.key === "Escape") run(() => setTool("move"));
        return;
      }
      if (mod) {
        if (c === "KeyZ") run(() => step(!e.shiftKey));
        else if (e.key === "+" || e.key === "=") run(() => zoom("in"));
        else if (e.key === "-") run(() => zoom("out"));
        else if (c === "Digit0") run(() => zoom(1));
        else if (c === "KeyD") run(duplicate);
        else if (e.altKey && c === "KeyT") run(tidyUp);
        else if (e.altKey && c === "KeyK" && has) run(makeComponent);
        else if (e.altKey && c === "KeyB" && has) run(() => patch((l) => (isInstance(l) ? detached(l) : l)));
        else if (e.altKey && BOOLEAN_KEYS[c] && has) run(() => combineShapes(BOOLEAN_KEYS[c]!));
        // ⌃⌘M; Ctrl+Alt+M where there is no ⌘ (the Windows key is not the page's)
        else if (c === "KeyM" && has && (ON_A_MAC ? e.ctrlKey && e.metaKey : e.ctrlKey && e.altKey)) run(useAsMask);
        else if (c === "KeyG") run(() => (e.shiftKey ? ungroup() : group(e.altKey)));
        else if (c === "KeyA") run(() => pick(k, base.layers.filter((l) => !l.hidden && !l.locked).map((l) => l.id)));
        else if (e.altKey && c === "KeyC" && mine.length === 1) run(copyLook);
        else if (e.altKey && c === "KeyV" && has && copiedLook) run(pasteLook);
        else if (c === "KeyC") copy(); // not stopped: words picked in a panel are still the browser's to copy
        else if (c === "KeyX" && has) run(() => (copy(), remove()));
        else if (e.shiftKey && c === "KeyH" && has) run(() => toggle("hidden"));
        else if (e.shiftKey && c === "KeyL" && has) run(() => toggle("locked"));
        return; // ⌘V is the page's paste event (below); everything else is the browser's
      }
      if (e.altKey) return void ((has || manyFrames) && ALIGN_KEYS[c] && run(() => align(ALIGN_KEYS[c]!)));
      if (e.shiftKey && c === "Digit1") return run(() => zoom("fit"));
      if (e.shiftKey && c === "KeyA" && has) return run(autoLayout);
      if (e.shiftKey && c === "Digit2") return run(() => zoom("selection"));
      if (e.shiftKey && c === "Digit0") return run(() => zoom(1));
      if (e.key === "+" || e.key === "=") return run(() => zoom("in"));
      if (e.key === "-") return run(() => zoom("out"));
      if (!e.shiftKey && TOOL_KEYS[c]) return run(() => setTool(TOOL_KEYS[c]!));
      if (cropping && (e.key === "Escape" || e.key === "Enter")) return run(() => setCropping(null));
      // the pen's line is ended by taking the move tool up again; a path being shaped: Delete takes its picked point out
      if (tool === "pen" && e.key === "Enter") return run(() => setTool("move"));
      if (shaping && (e.key === "Escape" || e.key === "Enter")) return run(() => setShaping(null));
      if (shaping && shaping.anchor !== null && (e.key === "Delete" || e.key === "Backspace")) return run(removePoint);
      // Esc: out of the container the picked layers are in (it is picked), then nothing picked
      if (e.key === "Escape") return run(() => (dropper ? setDropper(null) : tool !== "move" ? setTool("move") : scope ? outward() : pick(k, [])));
      if (e.key === "Delete" || e.key === "Backspace") return run(remove);
      const by = ARROWS[e.key];
      const far = e.shiftKey ? 10 : 1;
      // the frame itself is picked: the arrows move it
      if (by && !has && framed) return run(() => setPages(framedAt.map((n) => ({ ...pages[n]!, x: frames[n]!.x + by[0] * far, y: frames[n]!.y + by[1] * far }))));
      if (!has) return;
      // a locked layer is not nudged
      if (by) run(() => patch((l) => (l.locked ? l : { ...l, x: l.x + by[0] * far, y: l.y + by[1] * far })));
      else if (e.key === "Enter" && mine.length === 1 && mine[0]!.type === "text") run(() => setEditing(mine[0]!.id));
      else if (e.key === "Enter" && mine.length === 1 && mine[0]!.type === "image") run(() => setCropping(mine[0]!.id));
      else if (e.key === "Enter" && mine.length === 1 && mine[0]!.type === "path") run(() => setShaping({ id: mine[0]!.id, anchor: null }));
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
      // words copied somewhere else become a text layer in the middle of the frame
      else if (text.trim()) {
        const words = (id: string, f: { w: number; h: number }) => [textLayer(id, text.trim().slice(0, DESIGN_LIMITS.text), { x: Math.round(f.w / 4), y: Math.round(f.h * 0.4), w: Math.round(f.w / 2), h: Math.round(f.h * 0.2) }, f.w)];
        // on a canvas with no frame yet: loose in the middle of the view
        const m = middle();
        if (here) put(k, 1, ([id]) => words(id!, here));
        else put(-1, 1, ([id]) => rehome(words(id!, { w: design.width, h: design.height }), { x: Math.round(m.x - design.width / 2), y: Math.round(m.y - design.height / 2) }, {}));
      }
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

  /** Frame `n` as a picture, exactly as it is drawn (at its own size, or `scale` times it). */
  const frameBlob = async (n: number, type: string, scale: number): Promise<Blob> => {
    const p = pages[n]!;
    // every picture and drawing of the frame is there first: a frame is never saved with a grey box where one goes
    for (const l of p.layers) {
      // a hidden or reference layer is never drawn in it: its picture is not waited for
      const img = l.hidden || l.reference ? undefined : (loaded.get(sourceOf(l) ?? "") as HTMLImageElement | undefined);
      if (!img || (img.complete && img.naturalWidth)) continue;
      const gone = new Error(`A picture on ${pageName(p, n)} could not be loaded: nothing was saved`);
      if (img.complete) throw gone;
      await new Promise<void>((ok, fail) => {
        img.addEventListener("load", () => ok(), { once: true });
        img.addEventListener("error", () => fail(gone), { once: true });
      });
    }
    const f = frames[n]!;
    const c = document.createElement("canvas");
    c.width = f.w * scale;
    c.height = f.h * scale;
    const ctx = c.getContext("2d")!;
    // a JPG has nothing see-through: a see-through frame is white there, never black
    if (type === "image/jpeg") (ctx.fillStyle = "#ffffff"), ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawPage(ctx, p, f.w, f.h, loaded, true);
    const blob = await new Promise<Blob | null>((done) => c.toBlob(done, type, 0.92));
    if (!blob) throw new Error(`${pageName(p, n)} could not be saved as a picture`);
    return blob;
  };

  /** The frame he liked goes into a carousel style's Made & liked: a new one named after the design when `to` is null. */
  const likeFrame = async (n: number, to: AnimationStyle | null) => {
    if (locked) return;
    if (!design || !pages[n]) return;
    setError(null);
    try {
      // drawn first: a frame that cannot be drawn makes no style
      const blob = await frameBlob(n, "image/jpeg", 1);
      let style = to;
      if (!style) {
        // named after the design, and never like one there is: an AI finds a style by its name
        const taken = new Set((carouselStyles.data?.styles ?? []).map((s) => s.name.toLowerCase()));
        const stem = (design.name.trim() || "Carousel style").slice(0, STYLE_NAME_MAX - 3);
        let name = stem;
        for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${stem} ${i}`;
        style = await createAnimationStyle({ name, brief: "" }, "carousel");
      }
      await addStylePictures(style.id, [new File([blob], "frame.jpg", { type: "image/jpeg" })], "carousel", true);
      void carouselStyles.refresh().catch(() => {});
      const at = `/design?tab=styles&style=${style.id}`;
      toast(`${pageName(pages[n]!, n)} added to ${style.name}`, { action: { label: "Open", onClick: () => navigate(at) } });
    } catch (e) {
      setError(message(e));
    }
  };

  /** Done (the designer opened over another page): every change saved first, then `onDone`. A save refused because the design changed elsewhere is merged and sent again (send), so this waits until no save is left. */
  const [finishing, setFinishing] = useState(false);
  const finish = async () => {
    if (!onDone || finishing) return;
    // Read: nothing here changes, so nothing is saved
    if (locked) return onDone();
    setFinishing(true);
    // a field being typed in sets its value as it is left (a name, a hex code)
    (document.activeElement as HTMLElement | null)?.blur?.();
    // the change the blur made, and one merged in from a refused save, reach `unsaved` once the page has drawn them
    const drawn = () => new Promise((r) => setTimeout(r, 0));
    /** The canvas is what the server has: a change merged in from a refused save reaches `unsaved` only when its timer's effect runs. */
    const sent = () => JSON.stringify(latest.current) === JSON.stringify(server.current.pages) && JSON.stringify(stylesNow.current) === JSON.stringify(server.current.styles);
    failed.current = false;
    try {
      await drawn();
      for (let n = 0; n < 5 && !failed.current; n++) {
        if (unsaved.current || !sent()) send(unsaved.current ?? latest.current);
        const now = saving.current;
        await now;
        await drawn();
        if (now === saving.current && !unsaved.current && sent()) break;
      }
    } finally {
      setFinishing(false);
    }
    // a save that failed says why in the error line, and the designer stays open; so does a merged change not sent yet
    if (!unsaved.current && sent()) onDone();
  };

  const exportPngs = async (only?: number | readonly number[], as: ExportAs = { jpeg: false, scale: 1 }) => {
    if (!design) return;
    setError(null);
    const type = as.jpeg ? "image/jpeg" : "image/png";
    try {
      const files: { name: string; data: Uint8Array }[] = [];
      for (const n of pages.keys()) {
        if (only === undefined ? pages[n]!.loose : !(typeof only === "number" ? n === only : only.includes(n))) continue;
        // each frame at its own size (or twice it)
        const blob = await frameBlob(n, type, as.scale);
        files.push({ name: `${fileName(design.name)}-${String(n + 1).padStart(2, "0")}${as.scale > 1 ? `@${as.scale}x` : ""}.${as.jpeg ? "jpg" : "png"}`, data: new Uint8Array(await blob.arrayBuffer()) });
      }
      if (files.length === 1) downloadBlob(files[0]!.name, new Blob([files[0]!.data as BlobPart], { type }));
      else downloadBlob(`${fileName(design.name)}.zip`, zipStored(files));
    } catch (e) {
      setError(message(e));
    }
  };

  if (!design || !hist) {
    return (
      <div className="flex min-h-screen flex-col">
        <AppBar tool="Designer">{onDone && <Button size="sm" onClick={onDone}>Done</Button>}</AppBar>
        <p className="p-6 text-sm text-zinc-500">{error ?? "Opening the design…"}</p>
      </div>
    );
  }

  const stylesCtx = { styles, set: changeStyles, locked };
  const piece = design.from && "session" in design.from ? `/workshop/sessions/${design.from.session}` : null;
  const item = (label: string, keys: string, onSelect: () => void, disabled = false) => (
    <ContextMenuItem key={label} disabled={disabled} onSelect={onSelect}>
      {label}
      {keys && <ContextMenuShortcut>{keys}</ContextMenuShortcut>}
    </ContextMenuItem>
  );
  const none = !mine.length;
  /** The typed name, saved (Enter or leaving the field). Empty or unchanged keeps the old one. */
  const rename = (typed: string) => {
    setNaming(null);
    if (locked) return;
    const name = typed.trim().slice(0, DESIGN_LIMITS.name);
    const old = design.name;
    if (!name || name === old) return;
    const was = server.current.at;
    setDesign((d) => (d ? { ...d, name } : d));
    saveDesign(design.id, { name }).then(
      // the save moves the design's updatedAt; the frames' next save goes from it unless another save came between
      (d) => void (server.current.at === was && (server.current = { ...server.current, at: d.updatedAt })),
      (e) => {
        setDesign((d) => (d ? { ...d, name: old } : d));
        setError(message(e));
      },
    );
  };

  return (
    <DesignStylesContext.Provider value={stylesCtx}>
    <div
      className="flex h-screen flex-col"
      // a file held over the page is the page's to take: without this the window would open the file instead
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!locked && !dropping) setDropping(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropping(false)}
      onDrop={dropped}
    >
      <AppBar tool="Designer" to="/design" trail={
          // as wide as the name (an invisible copy sizes it), so the rest of the bar stays free to drag the Mac window
          <span className="inline-grid min-w-0">
            <span aria-hidden className="invisible col-start-1 row-start-1 truncate whitespace-pre border border-transparent px-2 py-1 text-sm">{naming ?? design.name}</span>
            {locked ? <span className="col-start-1 row-start-1 truncate px-2 py-1 text-sm text-zinc-500">{design.name}</span> : <input
              value={naming ?? design.name}
              aria-label="Design name"
              title="Rename"
              maxLength={DESIGN_LIMITS.name}
              onChange={(e) => setNaming(e.target.value)}
              onBlur={(e) => rename(e.target.value)}
              onKeyDown={(e) => {
                // Enter saves and leaves the field, Esc puts the saved name back
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  setNaming(design.name);
                  const field = e.currentTarget;
                  requestAnimationFrame(() => field.blur());
                }
              }}
              className="col-start-1 row-start-1 w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-normal text-zinc-500 outline-none hover:border-border focus:border-violet-500 focus:text-foreground"
            />}
          </span>
        }>
        {piece && (
          <Button size="sm" variant="ghost" asChild>
            <Link to={piece}>Content Workshop piece</Link>
          </Button>
        )}
        <span className="text-xs text-zinc-500" aria-live="polite">
          {saved === "unsaved" ? "Not saved" : saved === "saving" ? "Saving" : ""}
        </span>
        {!locked && <>
        <Button size="icon" variant="ghost" aria-label="Undo" disabled={!hist.past.length} onClick={() => step(true)}>
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="ghost" aria-label="Redo" disabled={!hist.future.length} onClick={() => step(false)}>
          <Redo2 className="h-4 w-4" />
        </Button>
        </>}
        <Button size="sm" disabled={!frameCount} onClick={() => void exportPngs()}>
          <Download className="h-4 w-4" />
          {frameCount === 1 ? "Export PNG" : `Export ${frameCount} PNGs`}
        </Button>
        {onDone && (
          <Button size="sm" variant="secondary" disabled={finishing} onClick={() => void finish()}>
            Done
          </Button>
        )}
      </AppBar>
      <div className="flex min-h-0 flex-1">
        <LayersPanel pages={shown} at={k} selected={selected} framed={framed} framedIds={framedIds} onPick={pick} onPoint={setPointed} onPage={setPage} onMovePage={movePage} onAddPage={() => addFrame()} onZoomTo={zoomTo} />

        <div ref={frame} data-dropping={dropping || undefined} className={cn("relative min-w-0 flex-1 overflow-hidden bg-[#f5f5f5] dark:bg-[#1e1e1e]", dropping && "ring-2 ring-inset ring-[#0d99ff]")}>
          {/* messages lie over the canvas, never above it: the canvas never moves under the pointer when one comes or goes.
              In its top right corner, below the top ruler when the rulers show: clear of a frame's name (which drags the
              frame) and of the handles over a picked layer, at the top left where a fitted frame starts */}
          <div className={cn("pointer-events-none absolute right-3 z-30 flex w-[min(24rem,calc(100%-1.5rem))] flex-col gap-2", aidPrefs.rulers ? "top-8" : "top-3")}>
            {error && (
              <div role="alert" className="pointer-events-auto flex items-start gap-2 rounded-md border border-red-500/40 bg-red-50 py-1 pl-3 pr-1 text-sm text-red-700 shadow-md dark:bg-[#3a2222] dark:text-red-300">
                <p className="max-h-32 min-w-0 flex-1 overflow-y-auto [overflow-wrap:anywhere] py-1">{error}</p>
                <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label="Close" onClick={() => setError(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            )}
            {macNote && (
              <div role="status" className="pointer-events-auto flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-50 py-1 pl-3 pr-1 text-sm text-amber-800 shadow-md dark:bg-[#3a3122] dark:text-amber-200">
                <span className="max-h-32 min-w-0 flex-1 overflow-y-auto [overflow-wrap:anywhere]">{macNote.text}</span>
                {macNote.stop && (
                  <Button size="sm" variant="ghost" className="h-7" onClick={macNote.stop}>
                    Stop
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="h-7" onClick={() => navigate("/settings/devices")}>
                  Settings
                </Button>
                {!macNote.stop && (
                  <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Close" onClick={() => setMacNote(null)}>
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            )}
          </div>
          {/* for the assistant beside the page, which reads the headings on screen (lib/page-context.ts): what is picked, by id. Here, where nothing scrolls it out of sight */}
          {onDone && <h3 className="sr-only">Design open over the video editor: {design.name} (design id {design.id}, as in /design/{design.id})</h3>}
          <h3 data-picked className="sr-only">
            Picked: {page?.loose ? "layers lying loose on the canvas, outside every frame (design_get's canvas)" : framedIds.length > 1 ? `frames ${framedAt.map((n) => `${pageName(pages[n]!, n)} (id ${pages[n]!.id})`).join(", ")}` : page ? `frame ${pageName(page, k)} (id ${page.id})` : "nothing: the canvas has no frame yet"}
            {picked.length > 0 &&
              `, ${picked.length === 1 ? "layer" : "layers"} ${picked
                .slice(0, 8)
                .map((l) => `${layerName(l)} (id ${l.id})`)
                .join(", ")}`}
          </h3>
          {room && (
            <Stage
              pages={shown}
              at={k}
              width={design.width}
              height={design.height}
              room={room}
              view={view}
              loaded={loaded}
              version={version}
              selected={selected}
              framed={framed}
              framedIds={framedIds}
              onPick={pick}
              onError={setError}
              onLive={setLive}
              onCommit={setPages}
              tool={tool}
              onMake={make}
              onMakeFrame={makeFrame}
              editing={editing}
              onEdit={setEditing}
              onTextSelect={setTextSel}
              onMakePath={makePath}
              shaping={shaping}
              onShape={setShaping}
              cropping={cropping}
              onCrop={setCropping}
              pointed={pointed}
              dropper={dropper ? (hex) => (dropper.take(hex), setDropper(null)) : null}
              menu={locked ? (
                <ContextMenuContent className="w-56">
                  {item("Copy", "⌘C", copy, none)}
                </ContextMenuContent>
              ) : (
                <ContextMenuContent className="w-56">
                  {item("Copy", "⌘C", copy, none)}
                  {item("Paste here", "⌘V", paste, !clip)}
                  {item("Copy style", "⌥⌘C", copyLook, mine.length !== 1)}
                  {item("Paste style", "⌥⌘V", pasteLook, none || !copiedLook)}
                  {item("Duplicate", "⌘D", duplicate, none && !framed)}
                  {item("Group selection", "⌘G", () => group(), none)}
                  {item("Frame selection", "⌥⌘G", () => group(true), none)}
                  {item("Add auto layout", "⇧A", autoLayout, none || (mine.length === 1 && flows(mine[0])))}
                  <ContextMenuSub>
                    <ContextMenuSubTrigger disabled={mine.length < 2 && !(isGroup(mine[0]) && mine[0].boolean)} className="data-[disabled]:pointer-events-none data-[disabled]:opacity-50">Combine shapes</ContextMenuSubTrigger>
                    <ContextMenuSubContent className="w-48">{DESIGN_BOOLEANS.map((op) => item(BOOLEAN_NAMES[op], BOOLEAN_KEY_NAMES[op], () => combineShapes(op), false))}</ContextMenuSubContent>
                  </ContextMenuSub>
                  {item(mine.length === 1 && mine[0]!.mask ? "Stop using as mask" : "Use as mask", ON_A_MAC ? "⌃⌘M" : "Ctrl+Alt+M", useAsMask, none)}
                  {item(mine.length > 1 && mine.every(isMain) ? "Combine as variants" : "Create component", "⌥⌘K", makeComponent, none || (mine.length === 1 && (isMain(mine[0]) || isInstance(mine[0]))))}
                  {mine.length === 1 && isInstance(mine[0]) && item("Detach instance", "⌥⌘B", () => patch((l) => (isInstance(l) ? detached(l) : l)), false)}
                  {item("Ungroup", "⇧⌘G", ungroup, !mine.some((l) => isGroup(l) || (l.group && (base?.layers ?? []).filter((x) => x.group === l.group).length > 1)))}
                  {mine.some(isGroup) && (mine.filter(isGroup).every((l) => l.box) ? item("Convert to group", "", () => convert(false), false) : item("Convert to frame", "", () => convert(true), false))}
                  <ContextMenuSeparator />
                  {item("Bring to front", "]", () => order(true), none)}
                  {item("Send to back", "[", () => order(false), none)}
                  <ContextMenuSeparator />
                  {item(mine.length && mine.every((l) => l.hidden) ? "Show" : "Hide", "⇧⌘H", () => toggle("hidden"), none)}
                  {item(mine.length && mine.every((l) => l.locked) ? "Unlock" : "Lock", "⇧⌘L", () => toggle("locked"), none)}
                  <ContextMenuSeparator />
                  {item("Delete", "⌫", remove, none && !framed)}
                  {mine.length === 1 && mine[0]!.type === "image" && (
                    <>
                      <ContextMenuSeparator />
                      {/* the AI makes the layers: its mark where a shortcut would be */}
                      <ContextMenuItem disabled={cutting} onSelect={() => void split()}>
                        {cutting ? "Working…" : "Split into layers"}
                        <CtMark className="ml-auto size-4 text-violet-500" />
                      </ContextMenuItem>
                    </>
                  )}
                  <ContextMenuSeparator />
                  <ContextMenuSub>
                    <ContextMenuSubTrigger disabled={!base || !!base.loose || !here} className="data-[disabled]:pointer-events-none data-[disabled]:opacity-50">Copy in another size</ContextMenuSubTrigger>
                    <ContextMenuSubContent className="w-60">{here && <CopySizes Item={ContextMenuItem} from={here} onCopy={copySize} />}</ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger disabled={!base} className="data-[disabled]:pointer-events-none data-[disabled]:opacity-50">Add to a carousel style</ContextMenuSubTrigger>
                    <ContextMenuSubContent className="w-56">
                      {(carouselStyles.data?.styles ?? []).map((s) => (
                        <ContextMenuItem key={s.id} onSelect={() => void likeFrame(k, s)}>
                          {s.name}
                        </ContextMenuItem>
                      ))}
                      {!!carouselStyles.data?.styles.length && <ContextMenuSeparator />}
                      {item("New carousel style", "", () => void likeFrame(k, null))}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                </ContextMenuContent>
              )}
            />
          )}

          <div role="toolbar" aria-label="Tools" className={cn("absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-xl border p-1.5 shadow-lg", BAR)}>
            {TOOLS.filter(([t]) => !locked || t === "hand").map(([t, label, keys, Icon]) => (
              // the button lets the keys go again, so Space still drags the canvas after a click here
              <Tip key={t} label={label} keys={keys}>
              <button type="button" aria-label={label} aria-pressed={tool === t} onClick={(e) => (setTool(t), e.currentTarget.blur())} className={cn("flex h-8 w-8 items-center justify-center rounded-md disabled:opacity-35", tool === t ? "bg-[#0d99ff] text-white" : "enabled:hover:bg-zinc-500/15")}>
                <Icon className="h-4 w-4" />
              </button>
              </Tip>
            ))}
            <input ref={fileRef} type="file" multiple accept="image/jpeg,image/png,image/webp" className="hidden" aria-label="Pictures from this computer" onChange={(e) => (void fromComputer([...(e.target.files ?? [])]), (e.target.value = ""))} />
            {!locked && <Tip label="Picture from this computer">
              <button type="button" aria-label="Picture" onClick={(e) => (fileRef.current?.click(), e.currentTarget.blur())} className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-zinc-500/15">
                <ImagePlus className="h-4 w-4" />
              </button>
            </Tip>}
            {/* one picture picked: what the AI can make of it, in a pill of its own beside the tools, so they never move */}
            {!locked && mine.length === 1 && mine[0]!.type === "image" && (
              <div className={cn("absolute left-full top-1/2 ml-2 flex -translate-y-1/2 rounded-xl border p-1.5 shadow-lg", BAR)}>
                <button type="button" disabled={cutting} onClick={(e) => (void split(), e.currentTarget.blur())} className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-sm enabled:hover:bg-zinc-500/15 disabled:opacity-50">
                  <CtMark className="h-4 w-4 text-violet-500" />
                  {cutting ? "Working…" : "Split into layers"}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* the frame tool out, or no frame yet: the sizes a frame can be made in; else what is picked */}
        {tool === "frame" || !page || !here || (page.loose && !picked.length) ? (
          <FramePresets view={view} onZoom={zoom} onAdd={(size) => (setTool("move"), addFrame(undefined, undefined, size))} />
        ) : (
        <Inspector
          design={design}
          page={page}
          at={k}
          count={frameCount}
          picked={pickedShown}
          onPreview={(fn) => {
            const next = fn && through(toLetters(fn));
            setLive(next ? [next] : null);
          }}
          onPatch={(fn, merge) => patch(toLetters(fn), merge)}
          onPage={setPage}
          onPagePreview={(next) => setLive(next ? [next] : null)}
          onAlign={align}
          onDistribute={spread}
          onTidy={tidied ? tidyUp : undefined}
          view={view}
          onZoom={zoom}
          framesPicked={framedAt}
          onExport={(only, as) => void exportPngs(only, as)}
          cropping={!!cropping}
          onCrop={(on) => setCropping(on && mine.length === 1 ? mine[0]!.id : null)}
          onCutOut={() => void cutOut()}
          onSplit={() => void split()}
          onGroup={() => group()}
          onUngroup={ungroup}
          onAutoLayout={autoLayout}
          onCombine={combineShapes}
          components={
            top && (
              <ComponentSection
                pages={pages}
                picked={mine}
                path={mine[0] ? (pathTo(top.layers, mine[0].id) ?? []) : []}
                onLayer={onLayer}
                onMake={makeComponent}
                onPlace={placeInstance}
                onGoToMain={goToMain}
              />
            )
          }
          flow={(() => {
            const c = top && scope ? findLayer(top.layers, scope) : null;
            return flows(c) ? c.layout : null;
          })()}
          cutting={cutting}
          colours={colours}
          onDropper={(take) => setDropper({ take })}
          onCopySize={copySize}
        />
        )}
      </div>
    </div>
    </DesignStylesContext.Provider>
  );
}
