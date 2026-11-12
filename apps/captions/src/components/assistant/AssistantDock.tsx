import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ArrowUpRight, Check, Copy, CornerDownLeft, FileText, Film, Folder, History, ImageOff, KeyRound, Loader2, MessageCircle, PanelRight, PanelRightClose, Pencil, RotateCcw, SquarePen, Trash2, VolumeX, X } from "lucide-react";
import type { AssistantImage, AssistantMessage, AssistantView } from "@contracts/assistant";
import { isLimitLine } from "@contracts/plans";
import { ReplyText } from "@/components/ReplyText";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMe } from "@/lib/auth";
import {
  cancelSecret,
  chatText,
  deletePast,
  getAssistant,
  keySaved,
  navigated,
  openAssistant,
  openPast,
  saveKey,
  sendTurn,
  startOver,
  stopTurn,
  sendAnswer,
  useAssistant,
} from "@/lib/assistant";
import { cornerOf, storePlace, storedPlace, type Corner, type Place } from "@/lib/dock-place";
import { pageContext } from "@/lib/page-context";
import { speak, stopSpeaking, unlockAudio, useReadAloud } from "@/lib/read-aloud";
import { onTopic } from "@/lib/sync";
import { cn } from "@/lib/utils";
import { Composer, PictureOverlay } from "./Composer";
import { EMPTY_DRAFT, MAX_FILES, MAX_FOLDERS, MAX_PICTURES, addVideo, cancelUpload, droppedByPath, droppedFiles, folderName, isLongPaste, isMediaFile, isPicture, toPicture, uploadVideo, type Draft, type Upload } from "./draft";
import { chooseFolderOnMac, droppedOnMac, thisMacBridge } from "@/lib/thisMac";
import { useThrow } from "./useThrow";
import { Elapsed, WorkCards } from "./WorkCards";
import { VideoCards } from "./VideoCard";
import { ApprovalCards } from "./ApprovalCards";
import { ConfirmCards } from "./ConfirmCards";
import { NoticeLine, WelcomeLine, WelcomePill, useWelcome } from "./Welcome";
import { openSetupAt, setupFinished, useSetup, useWorkTalk } from "@/lib/setup";

/** Width of the chat docked to the right edge; the page moves over by as much. */
const DOCK_W = 400;
/** Below the pages' top bars, above the corner buttons bottom left. */
/** On the right it stands in from the window's edge by what a page's scrollbar takes, where a screen has none
 *  (--edge-room, index.css): the same place on every screen. */
const RIGHT = "right-[calc(1rem+var(--edge-room,0px))]";
const AT: Record<Corner, string> = { tl: "left-4 top-16", tr: `${RIGHT} top-16`, bl: "left-4 bottom-14", br: `${RIGHT} bottom-4` };
/** The bubble's own place. Bottom right it sits above what a screen keeps in that corner: the screen says how high that
 *  stands (--corner-taken on <html>: a Review video's comment box, whose Send button the bubble used to cover). */
const BUBBLE_AT: Record<Corner, string> = { ...AT, br: `${RIGHT} bottom-[calc(1rem+var(--corner-taken,0px))] motion-safe:transition-[bottom]` };
const ORIGIN: Record<Corner, string> = { tl: "origin-top-left", tr: "origin-top-right", bl: "origin-bottom-left", br: "origin-bottom-right" };

const QUEUE_KEY = "ct-assistant:queue";
/** A message waiting its turn, with what goes with it (an older stored one is only { id, text }). */
type Queued = { id: string; text: string; images?: AssistantImage[]; pasted?: Draft["pasted"]; files?: Array<{ id: string; name: string }>; local?: string[]; folders?: string[]; quote?: string };
const storedQueue = (): Queued[] => {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]") as Queued[];
  } catch {
    return [];
  }
};

/** A few things to ask, for the page you're on; a tap sends it. */
/** Between one suggestion arriving and the next. */
const POP_MS = 190;

/**
 * How many of the `n` suggestions are up. None while `go` is off (the welcome is still writing); then one more every
 * POP_MS, so each arrives by itself. All at once for someone who asked for less motion.
 */
export function usePopIn(n: number, go: boolean): number {
  const [up, setUp] = useState(0);
  useEffect(() => {
    if (!go) return setUp(0);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return setUp(n);
    const t = window.setInterval(() => setUp((u) => Math.min(n, u + 1)), POP_MS);
    return () => window.clearInterval(t);
  }, [go, n]);
  return up;
}

function suggestionsFor(path: string): string[] {
  if (path.startsWith("/workshop")) return ["Tighten the piece I'm on", "Give me three other hooks", "What should I make next?"];
  if (path.startsWith("/review")) return ["What's new in Review?", "Sum up the comments on my latest video", "Which versions are approved?"];
  if (path.startsWith("/editor")) return ["How are my edits doing?", "What changed in the last draft?"];
  if (path.startsWith("/instagram") || path.startsWith("/analyzer")) return ["How did my last five posts do?", "Refresh my Instagram numbers"];
  return ["Where did I leave off?", "What can I finish right away?", "Find my next content idea"];
}

/**
 * The assistant, on every signed-in page (App.tsx): a bubble you can drag or throw to any corner, that opens into
 * the chat. Drag the chat by its header to another corner, or against the right edge to dock it there as a panel
 * beside the page. Its state is the server's (api/assistant.ts): no AI yet = a line and "Connect your AI" (setup,
 * step 4); an AI = the chat. It starts folded to the bubble. After setup it says hello once (Welcome.tsx). A key it
 * asks for is typed into a password box that saves straight to Settings → API keys. You can talk to it (the mic) and have its
 * replies read aloud (the speaker).
 */
export function AssistantDock() {
  const me = useMe();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const { collapsed, set, quote, setQuote, images: handed, notice } = useAssistant();
  const readAloud = useReadAloud();
  const real = !!me;
  const [view, setView] = useState<AssistantView | null>(null);
  /** Each video upload of this window, by its chip's key: Stop and a chip's X end it. */
  const uploads = useRef(new Map<string, Upload>());
  /** The sends this window answered, by their reply's id (null: it told the server the file isn't here), and how far each is. */
  const sends = useRef(new Map<string, Upload | null>());
  const [sendState, setSendState] = useState<Record<string, { pct: number; error?: string }>>({});
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [place, setPlaceState] = useState<Place>(storedPlace);
  const [closing, setClosing] = useState(false);
  /** The last message you've seen (undefined until the first load): a newer reply while closed nudges the bubble. */
  const [seenId, setSeenId] = useState<string | null | undefined>(undefined);
  /** The list of earlier conversations shows in place of the chat. */
  const [showPast, setShowPast] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLElement>(null);

  const setPlace = useCallback((p: Place) => {
    setPlaceState(p);
    storePlace(p);
  }, []);
  const bubbleThrow = useThrow(bubbleRef, false, setPlace);
  const cardThrow = useThrow(cardRef, true, setPlace);
  const { talk } = useWorkTalk();
  const setup = useSetup((s) => s.view);
  const connected = !!view && view.provider !== "none";
  const welcome = useWelcome({
    open: !collapsed,
    eligible: !!view && !!setup && talk !== "chat" && setupFinished(setup) && view.messages.length === 0,
    connected,
    user: me?.username ?? "",
  });
  // the suggestions under an empty chat arrive one at a time, once the welcome has finished writing
  const popped = usePopIn(suggestionsFor(pathname).length, !collapsed && !!view && welcome.stage !== "typing");

  const load = useCallback(async () => {
    const r = await getAssistant();
    if (!r.ok) return;
    setView(r.data);
    useAssistant.getState().set({ connected: r.data.provider !== "none" });
    setSeenId((s) => (s === undefined ? (r.data.messages.at(-1)?.id ?? null) : s));
  }, []);

  // the AI is read with the view: again on each page (back from Settings → Providers) and when the window comes back
  useEffect(() => {
    if (real) void load();
  }, [real, load, pathname]);
  useEffect(() => {
    if (!real) return;
    const again = () => void load();
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [real, load]);

  const last = view?.messages.at(-1);
  const thinking = last?.status === "thinking";
  // a reply is written on the server from the Mac's answer, and a scheduled task may post in the chat any time: the
  // server says when the conversation changed (api/assistant.ts) and it is read again then, never on a timer. Also
  // in a hidden window: a reply that finishes there is still read aloud
  useEffect(() => (real ? onTopic("assistant", () => void load()) : undefined), [real, load]);

  // a reply that just finished: read it aloud, when that's on
  const waitingOn = useRef<string | null>(null);
  useEffect(() => {
    if (!last) return;
    if (last.status === "thinking") waitingOn.current = last.id;
    else if (waitingOn.current === last.id) {
      waitingOn.current = null;
      if (last.status === "done" && last.text && useReadAloud.getState().on) speak(last.text);
    }
  }, [last]);
  // the reply asks to do something on the Mac: the closed bubble nudges until it's answered
  const asking = thinking && !!last?.approvals?.some((a) => a.status === "waiting");
  const unread = asking || (collapsed && seenId !== undefined && last?.role === "assistant" && last.status === "done" && last.id !== seenId);

  // ?chat=<id> on any page (a scheduled task's run, the inbox): open that chat, then take the id out of the address
  // (read fresh: a run may have made the chat since this view was loaded)
  useEffect(() => {
    const chat = new URLSearchParams(search).get("chat");
    if (!chat || !real) return;
    const q = new URLSearchParams(search);
    q.delete("chat");
    navigate({ pathname, search: q.toString() ? `?${q}` : "" }, { replace: true });
    void (async () => {
      const fresh = await getAssistant();
      const r = fresh.ok && fresh.data.id !== chat && fresh.data.past.some((p) => p.id === chat) ? await openPast(chat) : fresh;
      if (!r.ok) return setError(r.error);
      setView(r.data);
      setSeenId(r.data.messages.at(-1)?.id ?? null);
      setShowPast(false);
      openAssistant();
    })();
  }, [search, real, pathname, navigate]);

  // a page the assistant opened: move there once, then clear it on the server
  useEffect(() => {
    if (!view?.navigate) return;
    navigate(view.navigate);
    void navigated().then((r) => r.ok && setView(r.data));
    // `navigate` changes with the page, which ran this twice: two history entries, and Back reopened a dialog the link had opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.navigate]);

  useEffect(() => {
    if (!collapsed) bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [view?.messages.length, last?.text, last?.steps?.length, view?.pending, collapsed]);

  // docked and open: the page moves over to make room
  const docked = !collapsed && place.mode === "dock";
  useEffect(() => {
    if (!docked) return;
    const body = document.body.style;
    body.transition = "padding-right 300ms cubic-bezier(.2,.8,.2,1)";
    body.paddingRight = `${DOCK_W}px`;
    return () => {
      body.paddingRight = "";
    };
  }, [docked]);

  // the current project's colour, like the home page's tools (violet when Settings → Appearance turns it off)
  const tint = { "--tint": "rgb(var(--violet-600))" } as React.CSSProperties; // the project's colour (data-tint on <html>)

  const send = async (it: Omit<Queued, "id">): Promise<boolean> => {
    stopSpeaking();
    unlockAudio();
    setBusy(true);
    setError(null);
    const r = await sendTurn({
      text: it.text,
      ...(it.images?.length ? { images: it.images } : {}),
      ...(it.pasted?.length ? { pasted: it.pasted } : {}),
      ...(it.files?.length ? { files: it.files.map((f) => f.id) } : {}),
      ...(it.local?.length ? { localFiles: it.local } : {}),
      ...(it.folders?.length ? { paths: it.folders } : {}),
      context: { ...pageContext(), ...(it.quote ? { selection: it.quote } : {}) },
    });
    setBusy(false);
    if (r.ok) setView(r.data);
    else {
      setError(r.error);
      if (r.code === "NO_PROVIDER") void load();
    }
    return r.ok;
  };

  // The queue, as in the Workshop's chat: Enter while a reply runs adds the message here, and the first one sends
  // when the reply is done. Steer stops the reply and sends that one now; Edit puts it back in the box.
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [queue, setQueue] = useState<Queued[]>(storedQueue);
  // a queued message the server refused stays first and waits for a click (no retry loop)
  const [held, setHeld] = useState(false);
  const sending = useRef(false);
  useEffect(() => {
    const save = (q: Queued[]) => (q.length ? localStorage.setItem(QUEUE_KEY, JSON.stringify(q)) : localStorage.removeItem(QUEUE_KEY));
    try {
      save(queue);
    } catch {
      // pictures too big for this browser's storage: keep the words, the pictures stay until reload
      try {
        save(queue.map((it) => ({ ...it, images: undefined })));
      } catch {
        /* the queue stays until reload */
      }
    }
  }, [queue]);

  // Pictures and long pastes: dropped on the card, pasted, picked with the paperclip, or handed over from
  // elsewhere in the app (a screenshot of this screen). Each one is shrunk here to stay well under the server's cap.
  const [dropping, setDropping] = useState(false);
  const addPictures = useCallback((imgs: AssistantImage[]) => {
    setDraft((d) => {
      if (d.images.length + imgs.length > MAX_PICTURES) setError(`At most ${MAX_PICTURES} pictures go with one message`);
      return { ...d, images: [...d.images, ...imgs].slice(0, MAX_PICTURES) };
    });
  }, []);
  const addFiles = useCallback(
    async (files: File[], folder = false, paths?: Map<File, string>) => {
      const pics = files.filter(isPicture);
      let media = files.filter((f) => !isPicture(f) && isMediaFile(f));
      // a folder's other files (a camera's sidecars, notes) are passed over without a word
      const other = files.find((f) => !isPicture(f) && !isMediaFile(f));
      if (folder ? !pics.length && !media.length : other)
        setError(folder ? "That folder has no pictures, videos or recordings" : `"${other?.name}" can't go with a message: only pictures, videos and recordings can`);
      const room = MAX_FILES - draftRef.current.files.length;
      if (media.length > room) {
        setError(`At most ${MAX_FILES} videos go with one message: the first ${Math.max(room, 0)} were added`);
        media = media.slice(0, Math.max(room, 0));
      }
      // dropped in the Mac app, a video goes as its path and nothing uploads. Otherwise it uploads at once, and the message
      // may go as soon as the upload is made: the server waits for the rest, and it keeps uploading after the message goes
      for (const f of media) {
        const key = `${Date.now()}-${f.name}-${f.size}`;
        const patch = (p: Partial<Draft["files"][number]>) => setDraft((d) => ({ ...d, files: d.files.map((x) => (x.key === key ? { ...x, ...p } : x)) }));
        setDraft((d) => ({ ...d, files: [...d.files, { key, name: f.name || "Recording", size: f.size, pct: 0 }] }));
        const u = addVideo(f, paths?.get(f), patch);
        if (u) uploads.current.set(key, u);
      }
      if (!pics.length) return;
      try {
        addPictures(await Promise.all(pics.map(toPicture)));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [addPictures],
  );
  const handlePaste = useCallback(
    (data: DataTransfer): boolean => {
      const pics = Array.from(data.files).filter(isPicture);
      if (pics.length) {
        void addFiles(pics);
        return true;
      }
      const t = data.getData("text/plain");
      if (!isLongPaste(t)) return false;
      setDraft((d) => ({ ...d, pasted: [...d.pasted, { name: d.pasted.length ? `Pasted text ${d.pasted.length + 1}` : "Pasted text", text: t }] }));
      return true;
    },
    [addFiles],
  );
  // a paste while a dock button has focus (not the box) still lands in the box
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const a = document.activeElement;
      if (!e.clipboardData || !cardRef.current?.contains(a) || a?.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      if (handlePaste(e.clipboardData)) return;
      const t = e.clipboardData.getData("text/plain");
      if (t) setDraft((d) => ({ ...d, text: d.text + t }));
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [handlePaste]);
  // a picture handed to the dock from elsewhere (useAssistant.addImage) moves into the box
  useEffect(() => {
    if (handed.length) addPictures(useAssistant.getState().takeImages());
  }, [handed, addPictures]);
  const connectedNow = !!view && view.provider !== "none";
  useEffect(() => {
    const next = queue[0];
    // the server queues a message sent while a reply is being written: only a send in flight or a refused one holds this
    if (!next || held || !connectedNow || sending.current) return;
    sending.current = true;
    void send(next).then((ok) => {
      sending.current = false;
      if (ok) setQueue((q) => q.filter((x) => x.id !== next.id));
      else setHeld(true);
    });
    // send is a fresh function each render; the queue, the reply and the hold decide when to go
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, held, connectedNow]);
  // a reply that needs a file dropped here on the server (a tool's send, api/assistant.ts askSend): this window uploads
  // that one file and names its upload; a file this window no longer has (it was reloaded) is told, and the reply says so
  useEffect(() => {
    // only the Mac app has dropped files by their path: a browser window open beside it leaves its sends alone
    if (!thisMacBridge()) return;
    for (const m of view?.messages ?? []) {
      if (m.status !== "thinking" || !m.send || sends.current.has(m.id)) continue;
      const reply = m.id;
      const file = droppedByPath.get(m.send.path);
      if (!file) {
        sends.current.set(reply, null);
        void sendAnswer(reply, { gone: true }).then((r) => r.ok && setView(r.data));
        continue;
      }
      const at = (p: { pct: number; error?: string }) => setSendState((s) => ({ ...s, [reply]: p }));
      at({ pct: 0 });
      sends.current.set(
        reply,
        uploadVideo(file, {
          pct: (pct) => at({ pct }),
          id: (id) => void sendAnswer(reply, { id }).then((r) => r.ok && setView(r.data)),
          done: () => at({ pct: 100 }),
          error: (error) => at({ pct: 0, error }),
        }),
      );
    }
  }, [view?.messages]);
  /** A message (and the highlighted text it asks about) back in the box, after what's there. */
  const putBack = (it: Queued) => {
    setDraft((cur) => ({
      text: cur.text.trim() ? `${cur.text}\n\n${it.text}` : it.text,
      images: [...cur.images, ...(it.images ?? [])].slice(0, MAX_PICTURES),
      pasted: [...cur.pasted, ...(it.pasted ?? [])],
      files: [
        ...cur.files,
        ...(it.files ?? []).map((f) => ({ key: f.id, name: f.name, size: 0, pct: 100, id: f.id, done: true })),
        ...(it.local ?? []).map((p) => ({ key: p, name: folderName(p), size: 0, pct: 100, done: true, path: p })),
      ],
      folders: [...new Set([...cur.folders, ...(it.folders ?? [])])],
    }));
    if (it.quote) setQuote(it.quote);
  };
  // the pending highlighted text goes with this message and leaves the box
  const submit = ({ files, folders, ...d }: Draft) => {
    const it: Queued = {
      id: `${Date.now()}-${queue.length}`,
      ...d,
      ...(files.some((f) => !f.path) ? { files: files.filter((f) => !f.path).map((f) => ({ id: f.id!, name: f.name })) } : {}),
      ...(files.some((f) => f.path) ? { local: files.flatMap((f) => (f.path ? [f.path] : [])) } : {}),
      ...(folders.length ? { folders } : {}),
      ...(quote ? { quote } : {}),
    };
    setQuote(null);
    // the first thing sent ends the welcome and any notice a tool left
    set({ notice: null });
    welcome.end("sent");
    // a reply being written doesn't hold it: the server queues it behind that reply
    if (busy || queue.length) setQueue((q) => [...q, it]);
    // refused or failed: it comes back to the box rather than being lost
    else void send(it).then((ok) => !ok && putBack(it));
  };
  /** A notice's chip: its words go out as a message. */
  const chipSend = (text: string) => submit({ ...EMPTY_DRAFT, text });
  const stop = () => {
    // the reply Stop ends (the one being written, else the first that waits, as the server picks): the uploads it waits
    // for stop too (the server deletes what reached it: nothing will use them)
    const msgs = view?.messages ?? [];
    const thinking = msgs.filter((m) => m.role === "assistant" && m.status === "thinking");
    const target = thinking.find((m) => !m.wait) ?? thinking[0];
    const i = target ? msgs.indexOf(target) : -1;
    const ids = new Set((i > 0 && target?.wait ? (msgs[i - 1]!.files ?? []) : []).map((f) => f.id));
    for (const u of uploads.current.values()) if (u.id && ids.has(u.id)) u.ctl.abort();
    if (target) sends.current.get(target.id)?.ctl.abort();
    void stopTurn().then((r) => r.ok && setView(r.data));
  };
  /** A chip's X in the box: its upload stops, and what reached the server is deleted. */
  const removeFile = (f: Draft["files"][number]) => {
    const u = uploads.current.get(f.key);
    uploads.current.delete(f.key);
    if (u) cancelUpload(u);
    // put back from a message that didn't go: its upload ended earlier, its server copy is still there
    else if (f.id) cancelUpload({ ctl: new AbortController(), id: f.id });
  };
  /** The X on a reply's send: its upload stops, its copy is deleted, and the reply that waited for it ends as stopped. */
  const cancelSend = (reply: string) => {
    const u = sends.current.get(reply);
    if (u) cancelUpload(u);
    void stopTurn(reply).then((r) => r.ok && setView(r.data));
  };
  const steer = (id: string) => {
    setQueue((q) => [...q.filter((x) => x.id === id), ...q.filter((x) => x.id !== id)]);
    setHeld(false);
    if (thinking) stop();
  };
  const editQueued = (it: Queued) => {
    setQueue((q) => q.filter((x) => x.id !== it.id));
    if (queue[0]?.id === it.id) setHeld(false);
    putBack(it);
  };
  const unqueue = (it: Queued) => {
    setQueue((q) => q.filter((x) => x.id !== it.id));
    if (queue[0]?.id === it.id) setHeld(false);
  };

  const close = useCallback(() => {
    welcome.end("closed");
    setSeenId(last?.id ?? null);
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      set({ collapsed: true });
    }, 160);
  }, [last?.id, set, welcome.end]);

  // once the welcome has been said, a press outside the card and the bubble closes the dock, as the X does
  useEffect(() => {
    if (welcome.stage !== "ready") return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (cardRef.current?.contains(t) || bubbleRef.current?.contains(t)) return;
      welcome.end("away");
      close();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [welcome.stage, welcome.end, close]);

  if (!real) return null;

  const corner = cornerOf(place);

  if (collapsed) {
    return (
      <>
        <button
          ref={bubbleRef}
          type="button"
          onPointerDown={bubbleThrow.onPointerDown}
          onClick={() => {
            if (bubbleThrow.dragged.current) return;
            setSeenId(last?.id ?? null);
            openAssistant();
          }}
          aria-label={asking ? "Open the assistant: it asks to do something on your Mac" : unread ? "Open the assistant: a new reply" : "Open the assistant"}
          style={tint}
          title="Assistant · drag to move"
          data-assistant-dock
          // which corner it is in, for what else stands in the corners (a toast keeps clear of it, index.css)
          data-corner={corner}
          className={cn(
            "group pointer-events-auto fixed z-[55] size-14 touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint)] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            "motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-50 motion-safe:duration-300",
            BUBBLE_AT[corner],
          )}
        >
          {thinking && <span className="absolute inset-0 rounded-full bg-[color-mix(in_srgb,var(--tint)_50%,transparent)] motion-safe:animate-ping" aria-hidden />}
          <span
            className={cn(
              "relative flex size-full items-center justify-center rounded-full bg-[var(--tint)] text-white shadow-lg shadow-black/25",
              "transition-transform duration-300 ease-[cubic-bezier(.3,1.6,.5,1)] group-hover:scale-110 group-active:scale-95",
              unread && "motion-safe:animate-[ct-nudge_0.9s_ease-out_2]",
            )}
          >
            <MessageCircle className="size-6 transition-transform duration-300 group-hover:-rotate-12" aria-hidden />
            {unread && <span className={cn("absolute top-0.5 right-0.5 size-3.5 rounded-full border-2 border-background", asking ? "bg-amber-400" : "bg-emerald-400")} aria-hidden />}
          </span>
        </button>
        {/* the one "I'm here if you need me" after the welcome, once */}
        {welcome.pillDue && <WelcomePill corner={corner} onOpen={openAssistant} onDone={welcome.pillDone} />}
      </>
    );
  }

  const chatting = connected;
  const empty = chatting && !view.messages.length;
  const pending = view?.pending;
  const headBtn = "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40";

  return (
    <section
      ref={cardRef}
      aria-label="Assistant"
      data-assistant-dock
      // where the open card stands, for what else stands at the window's edges (a toast keeps clear of it, index.css)
      data-corner={place.mode === "dock" ? "dock" : place.corner}
      className={cn(
        // above page dialogs (z-50, Settings among them), under confirms (z-[60], alert-dialog.tsx)
        "pointer-events-auto fixed z-[55] flex flex-col overflow-hidden bg-popover text-popover-foreground",
        place.mode === "dock"
          ? "inset-y-0 right-0 border-l shadow-2xl"
          : cn("h-[min(600px,calc(100dvh-6rem))] w-[min(400px,calc(100vw-2rem))] rounded-2xl border shadow-2xl shadow-black/30", AT[place.corner], ORIGIN[place.corner]),
        // opening grows out of the bubble's corner with a little overshoot (docked: slides in); closing shrinks back
        closing
          ? cn("motion-safe:animate-out motion-safe:fill-mode-forwards motion-safe:duration-150", place.mode === "dock" ? "motion-safe:slide-out-to-right" : "motion-safe:fade-out motion-safe:zoom-out-90")
          : cn(
              "motion-safe:animate-in motion-safe:duration-300",
              place.mode === "dock" ? "motion-safe:slide-in-from-right" : "motion-safe:fade-in motion-safe:zoom-in-90 motion-safe:ease-[cubic-bezier(.3,1.3,.5,1)]",
            ),
      )}
      style={place.mode === "dock" ? { ...tint, width: DOCK_W } : tint}
      onDragOver={(e) => {
        if (!connectedNow || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        if (!connectedNow || !e.dataTransfer.files.length) return;
        e.preventDefault();
        droppedFiles(e.dataTransfer, droppedOnMac).then(
          (d) => {
            if (d.folders.length) setDraft((cur) => ({ ...cur, folders: [...new Set([...cur.folders, ...d.folders])].slice(0, MAX_FOLDERS) }));
            if (d.files.length || !d.folders.length) void addFiles(d.files, d.folder, d.paths);
          },
          (err) => setError(err instanceof Error ? err.message : String(err)),
        );
      }}
    >
      {dropping && (
        <div className="pointer-events-none absolute inset-1.5 z-10 flex items-center justify-center rounded-[14px] border-2 border-dashed border-[var(--tint)] bg-[color-mix(in_srgb,var(--tint)_10%,transparent)] text-sm font-medium text-[var(--tint)] motion-safe:animate-in motion-safe:fade-in">
          Drop pictures, videos or a folder
        </div>
      )}
      <header
        onPointerDown={cardThrow.onPointerDown}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          cardThrow.moveTo(place.mode === "dock" ? { mode: "float", corner: "br" } : { mode: "dock" });
        }}
        className="flex shrink-0 cursor-grab touch-none items-center gap-2.5 px-4 pt-3 pb-2 select-none active:cursor-grabbing"
        title="Drag to move · against the right edge to dock · double-click to dock or float"
      >
        <span className="relative flex size-2.5" aria-hidden>
          {thinking && <span className="absolute inset-0 rounded-full bg-[color-mix(in_srgb,var(--tint)_70%,transparent)] motion-safe:animate-ping" />}
          <span className={cn("relative size-2.5 rounded-full transition-colors duration-500", thinking ? "bg-[var(--tint)]" : connected ? "bg-emerald-500" : "bg-muted-foreground/50")} />
        </span>
        <span className="flex-1 text-sm font-semibold tracking-tight">Assistant</span>
        <NoToolsNote view={view} />
        {/* read-aloud is an add-on (Settings → General): the dock only offers to stop a reply being read */}
        {readAloud.speaking && (
          <button type="button" onClick={stopSpeaking} className={cn(headBtn, "text-[var(--tint)] motion-safe:animate-pulse")} aria-label="Stop reading aloud" title="Stop reading">
            <VolumeX className="size-4" />
          </button>
        )}
        {!!view?.messages.length && !showPast && <CopyButton className={headBtn} text={() => chatText(view.messages)} label="Copy the whole chat" />}
        {view && (
          <button
            type="button"
            className={cn(headBtn, showPast && "bg-muted text-foreground")}
            onClick={() => setShowPast((s) => !s)}
            aria-pressed={showPast}
            aria-label="Earlier chats"
            title="Earlier chats"
          >
            <History className="size-4" />
          </button>
        )}
        {!!view?.messages.length && (
          <button
            type="button"
            className={headBtn}
            onClick={() => {
              stopSpeaking();
              setShowPast(false);
              void startOver().then((r) => {
                if (!r.ok) return;
                setView(r.data);
                setSeenId(null);
              });
            }}
            aria-label="Start a new chat"
            title="New chat (this one stays in Earlier chats)"
          >
            <SquarePen className="size-4" />
          </button>
        )}
        <button
          type="button"
          className={headBtn}
          onClick={() => cardThrow.moveTo(place.mode === "dock" ? { mode: "float", corner: "br" } : { mode: "dock" })}
          aria-label={place.mode === "dock" ? "Float over the page" : "Dock to the side"}
          title={place.mode === "dock" ? "Float over the page" : "Dock to the side"}
        >
          {place.mode === "dock" ? <PanelRightClose className="size-4" /> : <PanelRight className="size-4" />}
        </button>
        <button type="button" className={headBtn} onClick={close} aria-label="Hide the assistant" title="Hide">
          <X className="size-4" />
        </button>
      </header>

      {/* docked, the list ends at the window's edge: it keeps its bar's room, so a chat that starts to scroll moves nothing */}
      <div className={cn("relative min-h-0 flex-1 px-4 pt-2 pb-3 text-sm", place.mode === "dock" ? "overflow-y-scroll" : "overflow-y-auto")}>
        {!view && <Dots />}

        {view && showPast && (
          <PastList
            view={view}
            onOpen={(id) =>
              void openPast(id).then((r) => {
                if (!r.ok) return setError(r.error);
                setView(r.data);
                setSeenId(r.data.messages.at(-1)?.id ?? null);
                setShowPast(false);
              })
            }
            onDelete={(id) => void deletePast(id).then((r) => r.ok && setView(r.data))}
          />
        )}

        {view?.provider === "none" && (
          <div className="flex h-full flex-col items-start justify-end gap-3 pb-2 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2">
            {notice && <NoticeLine notice={notice} />}
            {welcome.showing ? (
              <WelcomeLine text={welcome.shown} typing={welcome.stage === "typing"} />
            ) : (
              <p className="text-base font-semibold">The assistant needs your AI connected first.</p>
            )}
            {(!welcome.showing || welcome.stage === "ready") && (
              <Button size="sm" onClick={() => openSetupAt("agents")}>
                Connect your AI
              </Button>
            )}
          </div>
        )}

        {empty && !showPast && (
          <div className="flex h-full flex-col justify-end">
            {notice && (
              <div className="pb-2">
                <NoticeLine notice={notice} onChip={chipSend} />
              </div>
            )}
            {/* the welcome writes at the bottom, right above the message box. The suggestions come after it has finished,
                one after another, and each grows in under it, so the line is pushed up a step at a time (owner, 2026-11-10) */}
            {welcome.showing && <WelcomeLine text={welcome.shown} typing={welcome.stage === "typing"} />}
            {suggestionsFor(pathname).slice(0, popped).map((s, i) => (
              <div key={`${pathname}-${s}`} className="grid motion-safe:[animation:ct-pop-in_260ms_cubic-bezier(0.2,0.8,0.2,1)_both]">
                <div className={cn("min-h-0 motion-safe:[animation:ct-pop-clip_260ms_both]", i === 0 && welcome.showing ? "pt-3" : "pt-2")}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => submit({ ...EMPTY_DRAFT, text: s })}
                    className={cn(
                      "group flex w-fit max-w-full items-center gap-2 rounded-2xl border bg-background px-3.5 py-2 text-left text-sm transition-all duration-200",
                      "hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--tint)_50%,transparent)] hover:shadow-md active:translate-y-0",
                      "motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-90 motion-safe:duration-300",
                    )}
                  >
                    <span>{s}</span>
                    <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-[var(--tint)]" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {chatting && !empty && !showPast && (
          <div className="flex flex-col gap-3">
            {view.messages.map((m, i, all) => {
              const asked = all[i - 1];
              // the last reply failed or was cut off (a restart, the Mac gone): send the question again
              const retry =
                i === all.length - 1 && m.status === "error" && asked?.role === "user" && !thinking && !busy
                  ? () => void send({ text: asked.text, ...(asked.quote ? { quote: asked.quote } : {}) })
                  : undefined;
              // the newest reply's buttons (offer_choices) answer it in one press, until something else is said
              const choose = i === all.length - 1 && m.status === "done" && m.choices?.length && !thinking && !busy ? chipSend : undefined;
              // the newest reply asked for a folder (ask_folder): the Mac app's own open panel, and the choice goes as the next message
              const folder =
                i === all.length - 1 && m.status === "done" && m.folderAsk && !thinking && !busy && thisMacBridge()
                  ? () => void chooseFolderOnMac().then((p) => p && submit({ ...EMPTY_DRAFT, folders: [p] }))
                  : undefined;
              return <Message key={m.id} m={m} onRetry={retry} onChoose={choose} onFolder={folder} onView={setView} sending={sendState[m.id]} onCancelSend={() => cancelSend(m.id)} />;
            })}
            {notice && <NoticeLine notice={notice} onChip={chipSend} />}
          </div>
        )}

        {pending && (
          <form
            className="mt-3 space-y-2 rounded-lg border border-dashed p-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const value = secret.trim();
              setSecret("");
              if (!value) return;
              const saved = await saveKey(pending.env, value);
              if (!saved.ok) return setError(saved.error);
              const r = await keySaved(pending.env);
              if (r.ok) setView(r.data);
              else setError(r.error);
            }}
          >
            <p className="flex items-center gap-2 font-medium"><KeyRound className="size-4" aria-hidden /> {pending.name} key</p>
            <p className="text-muted-foreground">{pending.why}</p>
            <Input type="password" autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={`Paste your ${pending.name} key`} aria-label={`${pending.name} key`} />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={!secret.trim()}>Save key</Button>
              <Button type="button" size="sm" variant="ghost" onClick={async () => { setSecret(""); const r = await cancelSecret(); if (r.ok) setView(r.data); }}>Not now</Button>
            </div>
          </form>
        )}

        {error && (
          <p role="alert" className="mt-3 text-xs text-destructive motion-safe:animate-in motion-safe:fade-in">
            {error}
          </p>
        )}
        <div ref={bottom} />
      </div>

      {/* the message box shares the header's and the chat's left and right edges */}
      {chatting && (
        <div className="shrink-0 px-4 pt-1 pb-4">
          {queue.length > 0 && (
            <ul className="mb-1.5 flex flex-col gap-1">
              {queue.map((it, i) => (
                <li
                  key={it.id}
                  className="flex items-center gap-2 rounded-xl border bg-muted/60 px-3 py-1.5 text-[13px] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1"
                >
                  <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground uppercase">{i === 0 && held ? "Not sent" : "Queued"}</span>
                  <span className="min-w-0 flex-1 truncate" title={it.text}>
                    {it.text.trim() || attachmentsLabel(it)}
                    {it.text.trim() && attachmentsLabel(it) ? <span className="ml-1.5 text-[11px] text-muted-foreground">+ {attachmentsLabel(it)}</span> : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => steer(it.id)}
                    className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--tint)] hover:bg-[color-mix(in_srgb,var(--tint)_15%,transparent)]"
                    title={thinking ? "Steer: stop the reply and send this now" : "Send this now"}
                  >
                    <CornerDownLeft className="size-3" /> {thinking ? "Steer" : "Send"}
                  </button>
                  <button type="button" onClick={() => editQueued(it)} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground" title="Edit: back into the message box" aria-label="Edit queued message">
                    <Pencil className="size-3" />
                  </button>
                  <button type="button" onClick={() => unqueue(it)} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground" title="Remove from the queue" aria-label="Remove queued message">
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Composer
            draft={draft}
            setDraft={setDraft}
            onSend={(d) => {
              setDraft(EMPTY_DRAFT);
              submit(d);
            }}
            onStop={stop}
            onFiles={(fs) => void addFiles(fs)}
            onRemoveFile={removeFile}
            onPaste={handlePaste}
            quote={quote}
            onDropQuote={() => setQuote(null)}
            waiting={busy || thinking}
            autoFocus
          />
        </div>
      )}
    </section>
  );
}

/** "2 pictures, Pasted text": what a queued message carries besides its words. */
const attachmentsLabel = (it: Queued) =>
  [it.images?.length ? `${it.images.length} picture${it.images.length === 1 ? "" : "s"}` : "", ...(it.pasted ?? []).map((p) => p.name), ...(it.files ?? []).map((f) => f.name), ...(it.local ?? []).map(folderName), ...(it.folders ?? []).map(folderName)].filter(Boolean).join(", ");

/** The header's "OpenCode · no app tools", only for an AI that truly has none of the app's tools. */
export function NoToolsNote({ view }: { view: AssistantView | null }) {
  if (view?.provider !== "other" || view.tools) return null;
  return (
    <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={`${view.aiName} answers from your message only: it can't use Creator Toolset's tools (Claude Code, Codex, Gemini CLI and Grok can) or do things on your Mac for you.`}>
      {view.aiName} · no app tools
    </span>
  );
}

export function Message({
  m,
  onRetry,
  onChoose,
  onFolder,
  onView,
  sending,
  onCancelSend,
}: {
  m: AssistantMessage;
  onRetry?: () => void;
  onChoose?: (text: string) => void;
  onFolder?: () => void;
  onView: (v: AssistantView) => void;
  /** How far this window's upload for the reply's send is (m.send). */
  sending?: { pct: number; error?: string };
  onCancelSend?: () => void;
}) {
  const [big, setBig] = useState<string | null>(null);
  const enter = "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300";
  if (m.role === "note") return <p className={cn("mx-auto max-w-[90%] text-center text-xs text-muted-foreground", enter)}>{m.text}</p>;
  if (m.role === "user")
    return (
      <div className={cn("ml-auto flex max-w-[85%] flex-col items-end gap-1", enter)}>
        {m.task && (
          <Link to={`/settings/automations?task=${encodeURIComponent(m.task.id)}`} className="text-[11px] text-muted-foreground underline-offset-2 hover:underline" title="Open the scheduled task">
            Scheduled task · {m.task.name}
          </Link>
        )}
        {m.quote && (
          <p className="line-clamp-2 border-r-2 border-[color-mix(in_srgb,var(--tint)_50%,transparent)] pr-2 text-right text-xs text-muted-foreground" title={m.quote}>
            «{m.quote}»
          </p>
        )}
        {(!!m.images?.length || !!m.pasted?.length || !!m.files?.length || !!m.folders?.length || !!m.localFiles?.length) && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {m.images?.map((im) => (
              <ChatPicture key={im.id} id={im.id} name={im.name} onOpen={setBig} />
            ))}
            {m.files?.map((f) => (
              <span key={f.id} className="flex h-8 max-w-full items-center gap-1.5 rounded-lg border bg-muted px-2 text-[11px]" title={f.name}>
                <Film className="size-3.5 shrink-0 text-[var(--tint)]" aria-hidden />
                <span className="truncate">{f.name}</span>
                {f.uploading && <span className="shrink-0 text-muted-foreground">Uploading</span>}
              </span>
            ))}
            {m.localFiles?.map((p) => (
              <span key={p} className="flex h-8 max-w-full items-center gap-1.5 rounded-lg border bg-muted px-2 text-[11px]" title={p}>
                <Film className="size-3.5 shrink-0 text-[var(--tint)]" aria-hidden />
                <span className="truncate">{folderName(p)}</span>
              </span>
            ))}
            {m.folders?.map((p) => (
              <span key={p} className="flex h-8 max-w-full items-center gap-1.5 rounded-lg border bg-muted px-2 text-[11px]" title={p}>
                <Folder className="size-3.5 shrink-0 text-[var(--tint)]" aria-hidden />
                <span className="truncate">{folderName(p)}</span>
              </span>
            ))}
            {m.pasted?.map((name, i) => (
              <span key={i} className="flex h-8 items-center gap-1.5 rounded-lg border bg-muted px-2 text-[11px]">
                <FileText className="size-3.5 shrink-0 text-[var(--tint)]" aria-hidden />
                {name}
              </span>
            ))}
          </div>
        )}
        {m.text.trim() && (
          <div className="group/msg flex items-end gap-1">
            <CopyButton className={msgCopy} text={() => m.text} label="Copy" />
            <div className={cn("rounded-2xl rounded-br-md bg-[var(--tint)] px-3.5 py-2 whitespace-pre-wrap text-white", enter, "motion-safe:slide-in-from-bottom-2 motion-safe:zoom-in-95 motion-safe:origin-bottom-right")}>
              {m.text}
            </div>
          </div>
        )}
        {big && <PictureOverlay src={big} onClose={() => setBig(null)} />}
      </div>
    );
  const steps = m.steps ?? [];
  const working = m.status === "thinking";
  if (working && !m.text)
    return (
      <div className="space-y-1">
        <Steps steps={steps} working />
        {/* a reply waiting for its videos or its turn isn't working yet: its wait line says what it waits for */}
        {!m.wait && <Elapsed since={m.at} />}
        <WorkCards work={m.work} />
        <VideoCards media={m.media} />
        <ApprovalCards approvals={m.approvals} />
        <ConfirmCards confirms={m.confirms} onView={onView} />
        {m.send && sending ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate" title={m.send.path}>
              {sending.error ? `"${m.send.name}" didn't send: ${sending.error}` : `Sending to ${m.send.to} · ${sending.pct}%`}
            </span>
            <button type="button" onClick={onCancelSend} className="shrink-0 rounded p-0.5 hover:bg-muted hover:text-foreground" aria-label={`Stop sending ${m.send.name}`} title="Stop sending">
              <X className="size-3" />
            </button>
          </p>
        ) : (
          m.wait && <p className="text-xs text-muted-foreground">{m.wait.text}</p>
        )}
        <Dots />
      </div>
    );
  const again = onRetry && (
    <button
      type="button"
      onClick={onRetry}
      className="mt-1.5 flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:border-[color-mix(in_srgb,var(--tint)_50%,transparent)] hover:text-[var(--tint)]"
      title="Send your last message again"
    >
      <RotateCcw className="size-3.5" /> Try again
    </button>
  );
  if (m.status === "error" && !m.text)
    return (
      <div>
        <WorkCards work={m.work} />
        <VideoCards media={m.media} />
        <ApprovalCards approvals={m.approvals} />
        <ConfirmCards confirms={m.confirms} onView={onView} />
        <p className={cn("text-destructive", enter)}>That didn&apos;t work.</p>
        {again}
      </div>
    );
  return (
    <div className={cn("group/msg max-w-[94%] leading-relaxed", enter, "motion-safe:slide-in-from-bottom-1")}>
      {working ? (
        <Steps steps={steps} working />
      ) : (
        steps.length > 0 && (
          <details className="group mb-1.5 text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer list-none select-none hover:text-foreground">
              {steps.length === 1 ? steps[0] : `${steps.length} steps`}
              {steps.length > 1 && <span className="ml-1 inline-block transition-transform group-open:rotate-90">›</span>}
            </summary>
            {steps.length > 1 && <Steps steps={steps} />}
          </details>
        )
      )}
      {working && <Elapsed since={m.at} />}
      <WorkCards work={m.work} />
      <VideoCards media={m.media} />
      <ApprovalCards approvals={m.approvals} />
        <ConfirmCards confirms={m.confirms} onView={onView} />
      {/* a used-up plan is a wait, said in amber; a real failure in red */}
      {m.status === "error" ? <p className={isLimitLine(m.text) ? "text-amber-600 dark:text-amber-400" : "text-destructive"}>{m.text}</p> : <ReplyText text={m.text} />}
      {again}
      {onFolder && (
        <button
          type="button"
          onClick={onFolder}
          title={m.folderAsk!.why}
          className="mt-2 flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:border-[color-mix(in_srgb,var(--tint)_50%,transparent)] hover:text-[var(--tint)] motion-safe:animate-in motion-safe:fade-in"
        >
          <Folder className="size-3.5" aria-hidden /> Choose a folder
        </button>
      )}
      {onChoose && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {m.choices!.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onChoose(c)}
              className="rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:border-[color-mix(in_srgb,var(--tint)_50%,transparent)] hover:text-[var(--tint)] motion-safe:animate-in motion-safe:fade-in"
            >
              {c}
            </button>
          ))}
        </div>
      )}
      {m.status === "thinking" && <span className="ml-0.5 inline-block h-3.5 w-1.5 rounded-sm bg-[var(--tint)] align-middle motion-safe:animate-pulse" aria-hidden />}
      {!working && <CopyButton className={cn(msgCopy, "-ml-1 mt-0.5")} text={() => m.text} label="Copy" />}
    </div>
  );
}

const msgCopy =
  "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-60";

/** Copies text; a tick for a moment says it did. */
function CopyButton({ text, label, className }: { text: () => string; label: string; className: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={done ? "Copied" : label}
      onClick={() =>
        void navigator.clipboard.writeText(text()).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        })
      }
    >
      {done ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
    </button>
  );
}

const ago = (at: number) => {
  const d = new Date(at);
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days < 1 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
};

/** Earlier chats, newest first: open one to read it or carry on; the bin deletes it for good. */
function PastList({ view, onOpen, onDelete }: { view: AssistantView; onOpen: (id: string) => void; onDelete: (id: string) => void }) {
  return (
    <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1">
      <p className="mb-2 text-xs font-medium text-muted-foreground">Earlier chats</p>
      {!view.past.length && <p className="px-2.5 py-2 text-muted-foreground">No earlier chats yet.</p>}
      <ul className="flex flex-col">
        {view.past.map((p) => (
          <li key={p.id} className="group/past flex items-center gap-1 rounded-lg hover:bg-muted">
            <button
              type="button"
              onClick={() => onOpen(p.id)}
              className="flex min-w-0 flex-1 items-baseline gap-2 px-2.5 py-2 text-left"
              title="Open this chat"
            >
              <span className="min-w-0 flex-1 truncate">{p.title}</span>
              {p.working && <Loader2 className="size-3.5 shrink-0 self-center text-[var(--tint)] motion-safe:animate-spin" aria-label="Still answering" />}
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{ago(p.at)}</span>
            </button>
            <button
              type="button"
              onClick={() => onDelete(p.id)}
              className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-background hover:text-destructive focus-visible:opacity-100 group-hover/past:opacity-100"
              aria-label={`Delete "${p.title}"`}
              title="Delete for good"
            >
              <Trash2 className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the reply did on the way, one line per tool; while it works, the newest one pulses. */
function Steps({ steps, working = false }: { steps: string[]; working?: boolean }) {
  if (!steps.length) return null;
  return (
    <ul className="mt-1 mb-1.5 space-y-0.5 text-xs text-muted-foreground">
      {steps.map((s, i) => {
        const now = working && i === steps.length - 1;
        return (
          <li key={i} className="flex items-center gap-1.5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-left-1 motion-safe:duration-300">
            <span className={cn("size-1.5 shrink-0 rounded-full", now ? "bg-[var(--tint)] motion-safe:animate-pulse" : "bg-muted-foreground/40")} aria-hidden />
            <span className={cn(now && "text-foreground")}>
              {s}
              {now && "…"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Thinking: three dots that bounce in turn. */
function Dots() {
  return (
    <span className="flex h-6 items-center gap-1 motion-safe:animate-in motion-safe:fade-in" role="status" aria-label="Thinking">
      {[0, 1, 2].map((i) => (
        <span key={i} className="size-1.5 rounded-full bg-muted-foreground/70 motion-safe:animate-[ct-dot_1.2s_ease-in-out_infinite]" style={{ animationDelay: `${i * 0.15}s` }} />
      ))}
    </span>
  );
}

/** A message's picture, opened big on a click; one emptied in Settings → Storage shows as removed and opens nothing. */
function ChatPicture({ id, name, onOpen }: { id: string; name: string; onOpen: (src: string) => void }) {
  const [gone, setGone] = useState(false);
  const src = `/api/assistant/images/${encodeURIComponent(id)}`;
  if (gone)
    return (
      <span className="flex size-16 items-center justify-center rounded-lg border bg-muted text-muted-foreground" title={`${name} (removed)`}>
        <ImageOff className="size-4" aria-label="Picture removed" />
      </span>
    );
  return (
    <button type="button" onClick={() => onOpen(src)} title={name} aria-label={`Show ${name}`} className="cursor-zoom-in">
      <img src={src} alt={name} loading="lazy" onError={() => setGone(true)} className="size-16 rounded-lg border bg-muted object-cover" />
    </button>
  );
}
