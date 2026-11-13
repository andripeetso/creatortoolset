import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { Check, Clapperboard, Folder, Loader2, Plus } from "lucide-react";
import type { EditSummary } from "@contracts/editor";
import { MAX_MOMENTS, MAX_VERSIONS } from "@contracts/editor";
import type { AnimationStylesView, EditingStylesView } from "@contracts/editor-styles";
import type { AssetCard, Collection, LibrarySummary } from "@contracts/library";
import { AppBar } from "@/components/AppBar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { isMediaFile } from "@/components/assistant/draft";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { createEdit, footageTarget, listAnimationStyles, listEdits, listStyles, makeVoice, runEdit } from "@/lib/editor";
import { changeFolderItems, getAsset, listAssets, listCollections, listLibraries, uploadFile } from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";
import { cn } from "@/lib/utils";
import { confirmHeavy, openToolSetup } from "@/lib/setup";
import { EditorDefaultsButton } from "@/components/settings/EditorDefaultsDialog";
import { FootageFolderCard } from "@/components/FootageFolderCard";
import { Picture } from "@/components/Picture";
import { BrowseBar, NewFolderButton } from "@/components/browse/Bar";
import { FolderTrail, MoveToMenu, ToolFolderCards, ToolFolderRows } from "@/components/browse/ToolFolders";
import { useToolFolders } from "@/lib/folders";
import { FolderGrid, ItemCard } from "@/components/browse/Grid";
import { byName, matches, persistSort, storedSort, useBrowseView } from "@/components/browse/views";
import { AnimationStyles, type OpenAnimation } from "./editor/AnimationStyles";
import { EditingStyles, StyleSheet, type OpenStyle } from "./editor/EditingStyles";
import { FirstWay } from "./editor/FirstWay";
import { FromScript } from "./editor/FromScript";

/**
 * AI Editor (/editor): the edits I made (a workspace owner: the members' too), and New edit: footage picked from the
 * Media Library or dropped on the page, how many versions. Create runs it; the edit page (/editor/:id) follows the steps.
 * Videos and recordings dropped anywhere on the Edits tab open New edit with them in it.
 */

/** The videos and recordings of a drop or a file choice; a browser's own list is gone after the event, so this is read at once. */
const footageOf = (files: FileList | null | undefined): File[] => Array.from(files ?? []).filter(isMediaFile);
const fileDrag = (e: { dataTransfer: DataTransfer | null }) => !!e.dataTransfer?.types.includes("Files");

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const SORTS = ["recent", "name"] as const;
const SORT_KEY = "editor:sort";
export const thumb = (versionId: string) => `/api/library/media/${versionId}/thumb`;

const STATE_TONE: Record<string, string> = {
  queued: "bg-zinc-500/15 text-zinc-500",
  running: "bg-sky-500/15 text-sky-500",
  done: "bg-emerald-500/15 text-emerald-500",
  failed: "bg-red-500/15 text-red-500",
  needs_key: "bg-amber-500/15 text-amber-600",
  stopped: "bg-zinc-500/15 text-zinc-500",
};
export const STATE_LABEL: Record<string, string> = { queued: "Queued", running: "Running", done: "Done", failed: "Failed", needs_key: "Needs setup", stopped: "Stopped" };

export function StateBadge({ state }: { state: string }) {
  return <Badge className={cn("border-transparent", STATE_TONE[state])}>{STATE_LABEL[state] ?? state}</Badge>;
}

export default function EditorPage() {
  // the saved list paints at once; a step that moves (the server's worker, a device) reads it again: lib/local-cache
  const list = useCachedLoad<EditSummary[]>("/api/editor", listEdits);
  const edits = list.data;
  const error = edits ? null : list.error || null;
  // /editor?new=1&folder=<Media Library folder id>&name=<name>: New edit opens with them (the assistant's "Change the setup")
  const [params, setParams] = useSearchParams();
  // a page that hands clips over (the Screen Recorder's Send to AI Editor) puts them in the navigation's state: picked
  const handed = (useLocation().state as { pick?: Picked[] } | null)?.pick;
  const start = params.get("new") ? { folder: params.get("folder") ?? "", name: params.get("name") ?? "", pick: handed } : undefined;
  const [creating, setCreating] = useState(!!start);
  // footage dropped on the page: New edit opens and takes it
  const [dropped, setDropped] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const [view, setView] = useBrowseView("editor");
  const [find, setFind] = useState("");
  const [sort, setSort] = useState(() => storedSort(SORT_KEY, SORTS));
  // the open folder's edits (every folder's when searching); the server sends them newest change first
  const folders = useToolFolders("editor", edits ?? [], find);
  const shown = folders.here.filter((e) => matches(find, e.name)).sort((a, b) => (sort === "name" ? byName(a, b) : 0));
  const firstClip = (id: string) => {
    const v = edits?.find((e) => e.id === id)?.sources[0];
    return v ? thumb(v) : undefined;
  };
  const anything = !!edits?.length || folders.folders.length > 0 || !!folders.open;
  // the person's editing styles: the second tab (/editor?tab=styles), and New edit's Style select. `own`: it is read again after this window's own saves
  const styleList = useCachedLoad<EditingStylesView>("/api/editor/styles", listStyles, { own: true });
  const [openStyle, setOpenStyle] = useState<OpenStyle>(null);
  // the person's animation styles: the third tab (/editor?tab=animation)
  const animationList = useCachedLoad<AnimationStylesView>("/api/editor/animation-styles", listAnimationStyles, { own: true });
  const [openAnimation, setOpenAnimation] = useState<OpenAnimation>(null);
  const asked = params.get("tab");
  const tab = asked === "styles" || asked === "animation" ? asked : "edits";
  // on the window, so a file let go beside the sheet or on the dimmed page is taken too and never opens in the window
  useEffect(() => {
    if (tab !== "edits") return;
    const onOver = (e: DragEvent) => {
      if (!fileDrag(e)) return;
      e.preventDefault();
      setOver(true);
    };
    const onLeave = (e: DragEvent) => !e.relatedTarget && setOver(false);
    const onDrop = (e: DragEvent) => {
      if (!fileDrag(e)) return;
      e.preventDefault();
      setOver(false);
      const files = footageOf(e.dataTransfer?.files);
      if (!files.length) return;
      setDropped(files);
      setCreating(true);
    };
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [tab]);
  const tabs = (
    <Tabs value={tab} onValueChange={(t) => setParams(t === "edits" ? {} : { tab: t })}>
      <TabsList>
        <TabsTrigger value="edits">Edits</TabsTrigger>
        <TabsTrigger value="styles">Editing styles</TabsTrigger>
        <TabsTrigger value="animation">Animation styles</TabsTrigger>
      </TabsList>
    </Tabs>
  );

  if (tab === "animation") {
    return (
      <div className="flex min-h-dvh flex-col">
        <AppBar tool="AI Editor">
          {!!animationList.data?.styles.length && (
            <Button size="sm" onClick={() => setOpenAnimation("new")}>
              <Plus className="h-4 w-4" />
              New animation style
            </Button>
          )}
        </AppBar>
        <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-3 px-4 py-4 sm:px-6">
          {tabs}
          {animationList.data && <AnimationStyles styles={animationList.data.styles} open={openAnimation} onOpen={setOpenAnimation} onChanged={animationList.refresh} />}
          {!animationList.data && animationList.error && <p className="text-sm text-red-400">{animationList.error}</p>}
        </main>
      </div>
    );
  }

  // only one tab is drawn at a time: the styles tab has its own bar button and nothing of the edits list
  if (tab === "styles") {
    return (
      <div className="flex min-h-dvh flex-col">
        <AppBar tool="AI Editor">
          {!!styleList.data?.styles.length && (
            <Button size="sm" onClick={() => setOpenStyle("new")}>
              <Plus className="h-4 w-4" />
              New editing style
            </Button>
          )}
        </AppBar>
        <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-3 px-4 py-4 sm:px-6">
          {tabs}
          {styleList.data && <EditingStyles styles={styleList.data.styles} open={openStyle} onOpen={setOpenStyle} onChanged={styleList.refresh} />}
          {!styleList.data && styleList.error && <p className="text-sm text-red-400">{styleList.error}</p>}
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar tool="AI Editor">
        {anything && <NewFolderButton onClick={() => void folders.newFolder()} />}
        <EditorDefaultsButton slots={["grade"]} />
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          New edit
        </Button>
      </AppBar>
      <main className={cn("mx-auto flex w-full max-w-5xl flex-1 flex-col gap-3 px-4 py-4 sm:px-6", over && anything && "rounded-xl bg-violet-500/10")}>
        {tabs}
        {edits === null && !error && <div aria-hidden="true" className="h-[184px] rounded-xl border border-zinc-500/20" />}
        {edits?.length === 0 && !anything && (
          <div className={cn("flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center transition-colors", over ? "border-violet-500 bg-violet-500/10" : "border-zinc-500/30")}>
            <Clapperboard className="h-6 w-6 text-zinc-500" aria-hidden="true" />
            <p className="hidden text-sm font-medium sm:block">Drop your footage here</p>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              New edit
            </Button>
          </div>
        )}
        <FolderTrail state={folders} top="AI Editor" />
        {anything && (
          <BrowseBar
            search={{ value: find, onChange: setFind, placeholder: "Search edits (⌘K)" }}
            sort={{
              value: sort,
              onChange: (v) => {
                setSort(v);
                persistSort(SORT_KEY, v);
              },
              label: "Sort edits",
              options: [
                { id: "recent", label: "Recent" },
                { id: "name", label: "Name" },
              ],
            }}
            view={{ value: view, onChange: setView }}
          />
        )}
        {find.trim() && shown.length === 0 && folders.folders.length === 0 && <p className="py-16 text-center text-sm text-zinc-500">No matches.</p>}
        {(shown.length > 0 || folders.folders.length > 0) && view === "grid" && (
          <FolderGrid size="small">
            <ToolFolderCards state={folders} pictureOf={firstClip} />
            {shown.map((e) => (
              <ItemCard
                key={e.id}
                to={`/editor/${e.id}`}
                picture={e.sources[0] ? thumb(e.sources[0]) : undefined}
                icon={Clapperboard}
                name={e.name}
                meta={`${e.sources.length} ${e.sources.length === 1 ? "clip" : "clips"} · ${new Date(e.updatedAt).toLocaleDateString()}`}
                badge={e.last && <StateBadge state={e.last.stopped ? "stopped" : e.last.state} />}
                drag={folders.drag(e.id)}
                actions={folders.folders.length > 0 || folders.open ? <MoveToMenu state={folders} id={e.id} className="rounded p-1 hover:bg-white/20" /> : undefined}
              />
            ))}
          </FolderGrid>
        )}
        {view === "list" && folders.folders.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <ToolFolderRows state={folders} />
          </div>
        )}
        {shown.length > 0 && view === "list" && (
          <ul className="flex flex-col divide-y divide-zinc-500/15 rounded-xl border border-zinc-500/20">
            {shown.map((e) => (
              <li key={e.id} className="group flex items-center">
                <Link to={`/editor/${e.id}`} {...folders.drag(e.id)} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 hover:bg-zinc-500/10">
                  <div className="flex shrink-0 -space-x-3">
                    {e.sources.slice(0, 3).map((v) => (
                      // a take with no picture (a voice recording) has no thumbnail: the box stays, with no broken-image icon
                      <span key={v} className="h-10 w-16 shrink-0 overflow-hidden rounded-md border border-zinc-500/30 bg-zinc-800">
                        <Picture src={thumb(v)} alt="" className="h-full w-full object-cover" />
                      </span>
                    ))}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{e.name}</div>
                    <div className="truncate text-xs text-zinc-500">
                      {e.sources.length} {e.sources.length === 1 ? "clip" : "clips"} · {new Date(e.updatedAt).toLocaleString()}
                      {e.last && ` · ${e.last.kind}`}
                    </div>
                  </div>
                  {e.last && <StateBadge state={e.last.stopped ? "stopped" : e.last.state} />}
                </Link>
                <MoveToMenu state={folders} id={e.id} className="mr-2 rounded p-1.5 text-zinc-500 opacity-0 hover:bg-zinc-500/15 hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100" />
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
      </main>
      <NewEditSheet open={creating} onClose={() => setCreating(false)} start={start} styles={styleList.data} onStyles={styleList.refresh} dropped={dropped} />
    </div>
  );
}

/**
 * The New edit sheet: footage from the library (search, a folder, several at once or the whole folder) or from this
 * computer, then what is optional: a name, a style, a description, a script. `dropped`: files let go on the page, added
 * as they arrive (also while "How do you like to work?" is up, so they are picked when the form shows).
 * `styles`: the person's editing styles. The Style select also makes one ("New editing style…"); with none the edit is
 * sent as it always was, with no style at all. With none and "How do you like to work?" not answered yet, the sheet
 * asks that first (FirstWay), and `onStyles` reads the styles again once it is answered.
 */
/** A Media Library clip picked for a new edit: its version and its title. */
export type Picked = { versionId: string; title: string };

/** The Style select's last row: it opens a new style's sheet. */
const NEW_STYLE = "+new";

export function NewEditSheet({ open, onClose, start, styles, onStyles, dropped }: { open: boolean; onClose: () => void; start?: { folder: string; name: string; pick?: Picked[] }; styles?: EditingStylesView | null; onStyles?: () => Promise<unknown>; dropped?: File[] }) {
  const navigate = useNavigate();
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [libId, setLibId] = useState("");
  const [folders, setFolders] = useState<Collection[]>([]);
  const [folder, setFolder] = useState(start?.folder ?? "");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [items, setItems] = useState<AssetCard[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [picked, setPicked] = useState<Map<string, string>>(() => new Map(start?.pick?.map((p) => [p.versionId, p.title]))); // version id → title, in the order picked
  const [name, setName] = useState(start?.name ?? "");
  const [brief, setBrief] = useState("");
  const [script, setScript] = useState("");
  const [versions, setVersions] = useState(1);
  const [targetS, setTargetS] = useState("");
  const [styleId, setStyleId] = useState<string | null>(null); // null: nothing picked here yet; "": None
  // nothing filmed: the script is spoken by a voice and the whole picture comes from B-roll (editor/FromScript.tsx)
  // and a long recording (a podcast, a talk): the AI finds the parts that stand on their own, each cut as its own short video
  const [from, setFrom] = useState<"footage" | "script" | "long">("footage");
  const filmed = from !== "script";
  const [moments, setMoments] = useState(10);
  const [voice, setVoice] = useState("");
  const [broll, setBroll] = useState(""); // a folder's id; "": all the B-roll
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [makingStyle, setMakingStyle] = useState(false);
  // the file being added from this computer, and how far it is
  const [adding, setAdding] = useState<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // counts the files filed from this computer: the list is read again after each, so what was added is seen picked
  const [filed, setFiled] = useState(0);

  /** Picking a style fills the fields it sets that this sheet shows; they stay the person's to change. */
  const pickStyle = (id: string) => {
    setStyleId(id);
    const s = styles?.styles.find((x) => x.id === id);
    if (!s) return;
    setVersions(s.versions);
    setTargetS(s.targetS ? String(s.targetS) : "");
  };
  // the sheet opens on the style the last edit was made with
  const last = styles?.last;
  useEffect(() => {
    if (open && styleId === null && last) pickStyle(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, last]);

  useEffect(() => {
    if (!open) return;
    listLibraries().then((l) => {
      setLibraries(l);
      setLibId((id) => id || l[0]?.id || "");
    }, (e) => setError(message(e)));
  }, [open]);

  useEffect(() => {
    if (!libId) return;
    listCollections(libId).then(setFolders, () => setFolders([]));
  }, [libId]);

  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  // a long recording can be sound only (a podcast): those are listed there too, beside the videos
  const kinds: ("video" | "audio")[] = from === "long" ? ["video", "audio"] : ["video"];
  const query = { q: term || undefined, kind: kinds, collectionId: folder || undefined };
  useEffect(() => {
    if (!libId || !open) return;
    let live = true;
    listAssets(libId, query).then(
      (p) => {
        if (!live) return;
        setItems(p.items);
        setNext(p.next);
      },
      (e) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libId, term, folder, open, from === "long", filed]);

  const ready = (a: AssetCard) => a.state === "ready";
  const toggle = (a: AssetCard) =>
    setPicked((m) => {
      const out = new Map(m);
      if (out.has(a.versionId)) out.delete(a.versionId);
      else out.set(a.versionId, a.title);
      return out;
    });

  /** Every ready video the search and folder show, all pages. */
  const pickAll = async () => {
    let all = items;
    let cursor = next;
    try {
      while (cursor) {
        const p = await listAssets(libId, { ...query, cursor });
        all = [...all, ...p.items];
        cursor = p.next;
      }
      setItems(all);
      setNext(undefined);
      setPicked((m) => {
        const out = new Map(m);
        for (const a of all.filter(ready)) out.set(a.versionId, a.title);
        return out;
      });
    } catch (e) {
      setError(message(e));
    }
  };

  /** Files from this computer: filed in the library (the A-roll folder, or a plug-in's), then picked for this edit. One at a time, in the order they came. */
  const fromComputer = (files: File[]) => {
    if (!files.length) return;
    queue.current = queue.current.then(async () => {
      setBusy(true);
      setError(null);
      try {
        const target = await footageTarget();
        for (const [i, file] of files.entries()) {
          const of = files.length > 1 ? `${i + 1} of ${files.length} · ` : "";
          setAdding(`${of}${file.name}`);
          // a file the Mac app reads where it lies is not sent: it has no percent
          const up = await uploadFile(target.libraryId, file, (sent, inPlace) => setAdding(`${of}${file.name}${inPlace || !file.size ? "" : ` · ${Math.round((sent / file.size) * 100)}%`}`), target.collectionId);
          const assetId = up.assetId ?? up.duplicateOf;
          if (!assetId) throw new Error(`${file.name} was not filed in the library`);
          await changeFolderItems(target.libraryId, target.collectionId, [assetId], true);
          const asset = await getAsset(target.libraryId, assetId);
          setPicked((m) => new Map(m).set(asset.versionId, asset.title));
          setFiled((n) => n + 1);
        }
      } catch (e) {
        setError(message(e));
      } finally {
        setAdding(null);
        setBusy(false);
      }
    });
  };
  // footage dropped on the page
  useEffect(() => {
    if (dropped?.length) {
      setFrom((f) => (f === "script" ? "footage" : f));
      fromComputer(dropped);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropped]);

  const create = async () => {
    if (!(await confirmHeavy("editor"))) return;
    setBusy(true);
    setError(null);
    try {
      // nothing filmed: the script is spoken first, and that recording is the edit's one take
      const spoken = filmed ? null : await makeVoice({ text: script, voice, name: name.trim() || undefined });
      const { id } = await createEdit({
        sources: spoken ? [spoken.versionId] : [...picked.keys()],
        name: name.trim() || undefined,
        brief,
        script: from === "long" ? "" : script,
        // one voice says the script once: one version, as long as the voice, whatever the style says. No folder chosen
        // says nothing, so the style's own B-roll folder stands (with none: all their B-roll)
        ...(spoken
          ? { versions: 1, targetS: 0, ...(broll ? { brollCollectionId: broll } : {}) }
          : from === "long"
            ? { moments, targetS: Number(targetS) || 0 }
            : { versions, targetS: Number(targetS) || 0 }),
        // only an account with styles says anything about one: its pick, or null for None
        ...(styles?.styles.length ? { style: styles.styles.some((x) => x.id === styleId) ? styleId : null } : {}),
      });
      await runEdit(id);
      navigate(`/editor/${id}`);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-scroll p-0 sm:max-w-2xl">
        {styles && !styles.styles.length && !styles.asked && onStyles ? (
          <FirstWay onDone={onStyles} />
        ) : (
        <form
          className="flex flex-col gap-4 p-4 pt-12"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div>
            <SheetTitle className="text-base">New edit</SheetTitle>
            <SheetDescription className={cn("text-xs text-zinc-500", from === "footage" && "sr-only")}>
              {from === "long"
                ? "Pick a long recording from your Media Library. The AI finds the parts that stand on their own and cuts each as its own short video, in the recording's own shape."
                : filmed
                  ? "Add your footage, then Create and run."
                  : "A voice reads your script and the picture is cut from your B-roll. The voice runs on your own ElevenLabs key."}
            </SheetDescription>
          </div>

          <div role="group" aria-label="What the edit is made from" className="flex flex-wrap gap-1.5">
            <Button type="button" size="sm" variant={from === "footage" ? "default" : "outline"} onClick={() => setFrom("footage")}>
              My footage
            </Button>
            <Button type="button" size="sm" variant={from === "script" ? "default" : "outline"} onClick={() => setFrom("script")}>
              A script, nothing filmed
            </Button>
            <Button type="button" size="sm" variant={from === "long" ? "default" : "outline"} onClick={() => setFrom("long")}>
              Short videos from a long recording
            </Button>
          </div>

          {!filmed && (
            <FromScript script={script} onScript={setScript} voice={voice} onVoice={setVoice} folders={folders} broll={broll} onBroll={setBroll} styleFolder={styles?.styles.find((x) => x.id === styleId)?.brollCollectionId ?? null} />
          )}
          {filmed && (
          <section aria-label="Footage" className="flex flex-col gap-2">
            {libId && items.length === 0 && !term && !folder && <FootageFolderCard libraryId={libId} />}
            <div className="flex flex-wrap items-center gap-2">
              {libraries.length > 1 && (
                <select
                  aria-label="Library"
                  value={libId}
                  onChange={(e) => {
                    setLibId(e.target.value);
                    setFolder("");
                  }}
                  className="h-9 rounded-md border border-zinc-500/30 bg-transparent px-2 text-sm"
                >
                  {libraries.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              )}
              <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the library" aria-label="Search footage" className="min-w-0 flex-1" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                multiple
                accept="video/*,audio/*"
                className="hidden"
                aria-label="Footage files from this computer"
                onChange={(e) => {
                  fromComputer(footageOf(e.target.files));
                  e.target.value = "";
                }}
              />
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
                <Plus className="h-3.5 w-3.5" />
                Add files from this computer
              </Button>
              {adding && (
                <span role="status" className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-500">
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  <span className="truncate">{adding}</span>
                </span>
              )}
            </div>
            {folders.length > 0 && (
              <div role="group" aria-label="Folders" className="flex flex-wrap gap-1.5">
                <Button type="button" size="sm" variant={folder ? "outline" : "default"} onClick={() => setFolder("")}>
                  All
                </Button>
                {folders.map((c) => (
                  <Button key={c.id} type="button" size="sm" variant={folder === c.id ? "default" : "outline"} onClick={() => setFolder(c.id)}>
                    <Folder className="h-3.5 w-3.5" />
                    {c.name}
                  </Button>
                ))}
              </div>
            )}
            {items.length > 0 ? (
              <ul className="grid max-h-80 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
                {items.map((a) => {
                  const on = picked.has(a.versionId);
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        disabled={!ready(a) && !on}
                        aria-pressed={on}
                        onClick={() => toggle(a)}
                        className={cn(
                          "relative flex w-full flex-col overflow-hidden rounded-lg border text-left disabled:opacity-40",
                          on ? "border-violet-500 ring-2 ring-violet-500/40" : "border-zinc-500/20 hover:border-zinc-500/50",
                        )}
                      >
                        {/* a sound-only recording has no picture: its box stays, with no broken-image icon. The picture fills the box and never sets its height (a vertical clip's would) */}
                        <span className="relative block aspect-video w-full overflow-hidden bg-zinc-800">
                          <Picture src={a.thumbUrl ?? thumb(a.versionId)} alt="" className="absolute inset-0 h-full w-full object-cover" />
                        </span>
                        <span className="truncate px-2 py-1 text-xs">{a.title}</span>
                        {on && (
                          <span className="absolute right-1.5 top-1.5 rounded-full bg-violet-500 p-0.5 text-white">
                            <Check className="h-3 w-3" />
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="py-6 text-center text-sm text-zinc-500">
                {libId ? (
                  "No videos here."
                ) : (
                  <>
                    No Media Library yet.{" "}
                    <button type="button" className="underline underline-offset-2" onClick={() => openToolSetup("media")}>
                      Set up
                    </button>
                  </>
                )}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span>{picked.size} picked</span>
              {items.length > 0 && (
                <Button type="button" size="sm" variant="ghost" onClick={() => void pickAll()}>
                  {folder ? "Pick the whole folder" : "Pick all shown"}
                </Button>
              )}
              {picked.size > 0 && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setPicked(new Map())}>
                  Clear
                </Button>
              )}
              {next && (
                <Button type="button" size="sm" variant="ghost" onClick={() => void listAssets(libId, { ...query, cursor: next }).then((p) => (setItems((x) => [...x, ...p.items]), setNext(p.next)))}>
                  Load more
                </Button>
              )}
            </div>
          </section>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-name">Name</Label>
            <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={from === "footage" ? "The video's first line" : "Untitled edit"} maxLength={120} />
          </div>
          {styles && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-style">Editing style</Label>
              <select
                id="edit-style"
                value={styles.styles.some((x) => x.id === styleId) ? styleId! : ""}
                onChange={(e) => (e.target.value === NEW_STYLE ? setMakingStyle(true) : pickStyle(e.target.value))}
                className="h-9 w-fit max-w-full rounded-md border border-zinc-500/30 bg-transparent px-2 text-sm"
              >
                <option value="">None</option>
                {styles.styles.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
                <option value={NEW_STYLE}>New editing style…</option>
              </select>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-brief">{from === "long" ? "Describe the short videos you want (optional)" : "Describe the video (optional)"}</Label>
            <Textarea
              id="edit-brief"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={3}
              placeholder={from === "long" ? "The clearest advice and the best stories, for new parents." : "A 45-second reel for new parents: the hook, three tips, the call to action."}
            />
          </div>
          {from === "footage" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-script">Script (optional)</Label>
            <Textarea id="edit-script" value={script} onChange={(e) => setScript(e.target.value)} rows={3} placeholder="The text the takes were read from" />
          </div>
          )}
          {/* one voice says the script once: there is one version, as long as the voice */}
          <div className={cn("flex flex-wrap gap-4", !filmed && "hidden")}>
            {from === "long" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-moments">How many, at most</Label>
                <select id="edit-moments" value={moments} onChange={(e) => setMoments(Number(e.target.value))} className="h-9 w-24 rounded-md border border-zinc-500/30 bg-transparent px-2 text-sm">
                  {[3, 5, 10, 15, MAX_MOMENTS].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-versions">Versions</Label>
              <select id="edit-versions" value={versions} onChange={(e) => setVersions(Number(e.target.value))} className="h-9 w-24 rounded-md border border-zinc-500/30 bg-transparent px-2 text-sm">
                {Array.from({ length: MAX_VERSIONS }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-target">{from === "long" ? "Length of each (seconds)" : "Length (seconds)"}</Label>
              <Input id="edit-target" type="number" min={0} max={3600} value={targetS} onChange={(e) => setTargetS(e.target.value)} placeholder="Any" className="w-28" />
            </div>
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <Button type="submit" disabled={busy || (filmed ? picked.size === 0 : !script.trim() || !voice)} className="self-start">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {filmed || !busy ? "Create and run" : "Making the voice"}
          </Button>
        </form>
        )}
        {makingStyle && (
          <StyleSheet
            style={null}
            onClose={() => setMakingStyle(false)}
            onSaved={async (made) => {
              await onStyles?.();
              setStyleId(made.id);
              setVersions(made.versions);
              setTargetS(made.targetS ? String(made.targetS) : "");
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
