import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCachedLoad } from "@/lib/local-cache";
import { useSteadyList } from "@/lib/steady-list";
import { Picture } from "@/components/Picture";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  Captions,
  Check,
  Download,
  Film,
  Folder,
  GripVertical,
  Layers,
  Link2,
  Loader2,
  MessageSquare,
  Trash2,
  TriangleAlert,
  Undo2,
  UploadCloud,
  X,
  MessageSquareText,
  Circle,
} from "lucide-react";
import { canRecordScreen, openRecorder } from "@/lib/mac-record";
import { ToolIntro } from "@/components/AppBar";
import { AppBar } from "@/components/AppBar";
import { ReviewShareButton } from "@/components/ReviewShareButton";
import { confirmDialog } from "@/lib/dialogs";
import { NewFolderButton, TrashLink } from "@/components/browse/Bar";
import { FolderCard } from "@/components/browse/Folder";
import { FolderGrid, GridFrame } from "@/components/browse/Grid";
import { askRename } from "@/components/browse/browse";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { timeAgo } from "@/lib/exports";
import {
  APPROVAL,
  createReviewProject,
  deleteForever,
  deleteReviewAsset,
  deleteReviewProject,
  isFinished,
  listReviewAssets,
  listReviewProjects,
  listReviewTrash,
  openInCaptionStudio,
  patchReviewAsset,
  patchReviewProject,
  projectShareUrl,
  reorderReviewStack,
  restoreReviewAsset,
  reviewApi,
  stackReviewAssets,
  thumbUrl,
  timecode,
  trashThumbUrl,
  unstackReviewAsset,
  uploadReviewFile,
  versionThumbUrl,
  type Approval,
  type ReviewAsset,
  type ReviewProject,
} from "@/lib/review";
import { ReviewUploadDialog, type UploadItem } from "@/components/ReviewUploadDialog";
import { cn } from "@/lib/utils";

type Upload = { key: string; name: string; timeline?: string; pct: number; waiting?: boolean; assetId?: string; error?: string };
/** Run a change, then reload; `now` shows its result right away (reverted by the reload if it failed). */
type Act = (change: Promise<unknown>, now?: (list: ReviewAsset[]) => ReviewAsset[]) => void;

/** dataTransfer type of a video card dragged onto another card or a project:
 *  its id, or the selected videos' ids joined by "," when it's one of them. */
const DRAG = "application/x-review-asset";
const STATUSES = Object.keys(APPROVAL) as Approval[];
const NONE: ReadonlySet<string> = new Set();

/** Mark videos Finished or back In progress by hand (Review's tabs); `act`'s arguments. */
const markFinished = (list: ReviewAsset[], finished: boolean): Parameters<Act> => {
  const ids = new Set(list.map((a) => a.id));
  return [
    Promise.all(list.map((a) => patchReviewAsset(a.id, { finished }))),
    (l) => l.map((x) => (ids.has(x.id) ? { ...x, done: { finished, at: Date.now() } } : x)),
  ];
};

/** dragleave also fires when the pointer moves onto a child: only leaving the element itself counts. */
const leftFor = (e: React.DragEvent) => !e.currentTarget.contains(e.relatedTarget as Node | null);

const media = (list: FileList | File[] | null | undefined) =>
  [...(list ?? [])].filter((f) => f.type.startsWith("video/") || f.type.startsWith("audio/") || !f.type);

/** Review library: projects (folders) and videos, newest activity first.
 *  Drag a video onto another to stack it as that video's next version. */
export default function ReviewPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const assetsList = useCachedLoad("/api/review", listReviewAssets);
  const projectsList = useCachedLoad("/api/review/projects", listReviewProjects);
  const assets = assetsList.data;
  const setAssets = assetsList.set;
  const projects = projectsList.data ?? [];
  const { refresh: refreshAssets } = assetsList;
  const { refresh: refreshProjects } = projectsList;
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [dragging, setDragging] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [stackOf, setStackOf] = useState<string | null>(null);
  // several videos picked:
  // Shift-click a range from the last pick, ⌘/Ctrl-click one more or less; they belong to
  // the folder and tab they were picked in (`at`), so going elsewhere lets go of them
  const [sel, setSel] = useState<{ at: string; ids: Set<string>; anchor?: string }>({ at: "", ids: new Set() });
  // Upload / New project: videos with their timeline files, picked up front
  const [adding, setAdding] = useState<{ newProject?: boolean; files?: File[] } | null>(null);

  const load = useCallback(
    () =>
      Promise.all([refreshAssets(), refreshProjects()])
        .then(() => setError(""))
        .catch((e: Error) => setError(e.message)),
    [refreshAssets, refreshProjects],
  );

  const project = projects.find((p) => p.id === params.get("p"));
  const trash = !project && params.get("trash") === "1";
  // the top level shows what's in progress; marked finished = Finished
  const done = !project && !trash && params.get("done") === "1";
  // a video whose project is gone shows at the top level
  const folderOf = (a: ReviewAsset) => projects.find((p) => p.id === a.projectId)?.id;
  const finished = (p: ReviewProject) => {
    const inside = assets?.filter((a) => folderOf(a) === p.id) ?? [];
    return inside.length > 0 && inside.every(isFinished);
  };
  const listedProjects = project ? [] : projects.filter((p) => finished(p) === done);
  // inside a project the finished ones go last
  const listed =
    assets
      ?.filter((a) => folderOf(a) === project?.id && (!!project || isFinished(a) === done))
      .sort((x, y) => +isFinished(x) - +isFinished(y)) ?? null;
  // what is on screen: scrolled away from the top, the cards keep their places and a new video waits up there;
  // with the top in sight it comes in and the others slide over (lib/steady-list)
  const where = `${project?.id}|${trash}|${done}`;
  const grid = useRef<HTMLDivElement>(null);
  const cards = useSteadyList<ReviewProject | ReviewAsset>([...listedProjects, ...(listed ?? [])], grid, { scope: where });
  const shownProjects = cards.filter((c): c is ReviewProject => !("versions" in c));
  const shown = listed && cards.filter((c): c is ReviewAsset => "versions" in c);
  const doneCount =
    projects.filter(finished).length + (assets?.filter((a) => !folderOf(a) && isFinished(a)).length ?? 0);

  // Thumbnails fade in top to bottom: a picture may show once every picture above it has loaded. The page preloads
  // them in list order (the browser's own order is not the list's); the cards get the set that may show now.
  const readyOf = (list: ReviewAsset[]) => list.filter((a) => a.versions.at(-1)?.status === "ready");
  const order = [
    ...shownProjects.flatMap((p) => readyOf(assets?.filter((a) => folderOf(a) === p.id) ?? []).slice(0, 4).map((a) => thumbUrl(a))),
    ...readyOf(shown ?? []).map((a) => thumbUrl(a)),
  ];
  const orderKey = order.join("\n");
  const [loaded, setLoaded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const imgs = orderKey.split("\n").filter(Boolean).map((src) => {
      const im = new Image();
      const done = () => setLoaded((s) => (s.has(src) ? s : new Set(s).add(src)));
      im.onload = done;
      im.onerror = done;
      im.src = src;
      return im;
    });
    return () => imgs.forEach((im) => {
      im.onload = null;
      im.onerror = null;
    });
  }, [orderKey]);
  const reveal = useMemo(() => {
    const out = new Set<string>();
    for (const src of orderKey.split("\n").filter(Boolean)) {
      if (!loaded.has(src)) break;
      out.add(src);
    }
    return out;
  }, [orderKey, loaded]);

  // the first load is the hook's (the saved list shows at once); processing progress arrives as change notices
  const act: Act = (change, now) => {
    setError("");
    if (now) setAssets((list) => list && now(list));
    void change.then(load).catch((e: Error) => {
      setError(e.message);
      void load();
    });
  };

  const picked = sel.at === where ? sel.ids : NONE;
  const clearPicks = () => setSel({ at: where, ids: new Set() });
  useEffect(() => {
    if (!picked.size) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setSel((s) => ({ ...s, ids: new Set(), anchor: undefined }));
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [picked.size]);

  /** A modifier click on a card: Shift adds the range from the last pick, ⌘/Ctrl adds or drops this one. */
  const pick = (id: string, range: boolean) => {
    const order = shown?.map((a) => a.id) ?? [];
    setSel((s) => {
      const cur = s.at === where ? s : { at: where, ids: new Set<string>() };
      const from = cur.anchor ? order.indexOf(cur.anchor) : -1;
      const to = order.indexOf(id);
      const ids = new Set(cur.ids);
      if (range && from >= 0 && to >= 0) {
        for (const x of order.slice(Math.min(from, to), Math.max(from, to) + 1)) ids.add(x);
      } else if (!range && ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { at: where, ids, anchor: range && from >= 0 ? cur.anchor : id };
    });
  };

  /** These videos into a project (null = the top level), all at once. */
  const moveMany = (ids: string[], projectId: string | null) => {
    const set = new Set(ids);
    act(Promise.all(ids.map((id) => patchReviewAsset(id, { projectId }))), (l) =>
      l.map((x) => (set.has(x.id) ? { ...x, projectId: projectId ?? undefined } : x)),
    );
    clearPicks();
  };
  /** What a card's drag or "Move to" carries: the picked videos when it's one of them. */
  const carried = (id: string) => (picked.has(id) && picked.size > 1 ? [...picked] : [id]);

  // one file at a time: the first is in Review in half the time, instead of all finishing together
  const queue = useRef(Promise.resolve());
  const upload = useCallback(
    (items: UploadItem[], to: { assetId?: string; projectId?: string }) => {
      for (const { video: file, timeline } of items) {
        const key = crypto.randomUUID();
        const set = (patch: Partial<Upload>) =>
          setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...patch } : x)));
        setUploads((u) => [...u, { key, name: file.name, pct: 0, waiting: true, assetId: to.assetId }]);
        queue.current = queue.current.then(() =>
          uploadReviewFile(file, (pct) => set({ pct, waiting: false }), to, timeline)
            .then(() => {
              setUploads((u) => u.filter((x) => x.key !== key));
              void load();
            })
            .catch((e: Error) => set({ error: `${e.message}. Upload the same file again to continue where it stopped.` })),
        );
      }
    },
    [load],
  );

  const dropped = (files: File[], to: { assetId?: string; projectId?: string }) => upload(files.map((video) => ({ video })), to);

  const start = (items: UploadItem[], name: string) => {
    const newProject = adding?.newProject;
    setAdding(null);
    if (!newProject) return upload(items, { projectId: project?.id });
    createReviewProject(name)
      .then(async (p) => {
        await load();
        setParams({ p: p.id });
        upload(items, { projectId: p.id });
      })
      .catch((e: Error) => setError(e.message));
  };

  const caption = (a: ReviewAsset) => {
    const v = a.versions.at(-1);
    if (!v) return;
    setNote(`Preparing "${a.name}" for Caption Studio…`);
    openInCaptionStudio(a.id, v.n)
      .then(({ projectId }) => navigate(`/captions?project=${projectId}`))
      .catch((e: Error) => {
        setNote("");
        setError(e.message);
      });
  };

  return (
    <div
      className="min-h-dvh bg-zinc-950 text-zinc-200"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => leftFor(e) && setDragging(false)}
      // a dropped card may be gone before its own dragend fires
      onDropCapture={() => setDragId(null)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const files = media(e.dataTransfer.files);
        if (files.length) setAdding({ files });
      }}
    >
      <AppBar tool="Review" to={project || trash ? "/review" : undefined} trail={project?.name ?? (trash ? "Trash" : undefined)}>
          {!project && !trash && (
            <>
              <TrashLink to="/review?trash=1" title="Trash: deleted videos, restorable for 30 days" />
              <NewFolderButton label="New project" onClick={() => setAdding({ newProject: true })} />
            </>
          )}
          {project && (
            <ReviewShareButton
              share={project.share}
              url={project.share ? projectShareUrl(project.share.token) : ""}
              what="every video in this project"
              update={async (share) => {
                await patchReviewProject(project.id, { share });
                await load();
              }}
              className="h-8 text-sm"
            />
          )}
          {!trash && canRecordScreen() && (
            <Button size="sm" variant="outline" onClick={openRecorder} className="h-8 text-sm"
              title="Opens the screen recorder">
              <Circle className="fill-red-500 text-red-500" /> <span className="hidden sm:inline">Record screen</span>
            </Button>
          )}
          {!trash && (
            <Button size="sm" onClick={() => setAdding({})} className="bg-violet-600 text-white hover:bg-violet-500">
              <UploadCloud /> <span className="hidden sm:inline">Upload</span>
            </Button>
          )}
      </AppBar>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {!project && !trash && (
          <ToolIntro icon={MessageSquareText} title="Review" line="Share a cut with one link. Reviewers comment on the exact frame." className="mt-4" />
        )}
        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}
        {note && (
          <p className="mb-4 flex items-center gap-2 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" /> {note}
          </p>
        )}
        {uploads.length > 0 && (
          <div className="mb-6 flex flex-col gap-2">
            {uploads.map((u) => (
              <div key={u.key} className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate">
                    {u.assetId ? "New version: " : ""}
                    {u.name}
                  </span>
                  {u.error ? (
                    <button className="text-xs text-zinc-500 hover:text-zinc-300" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}>
                      Dismiss
                    </button>
                  ) : (
                    <span className="tabular-nums text-zinc-500">{u.waiting ? "Waiting" : `${u.pct}%`}</span>
                  )}
                </div>
                {u.error ? (
                  <p className="mt-1 text-red-400">{u.error}</p>
                ) : (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                    <div className="h-full bg-violet-500 transition-[width]" style={{ width: `${u.pct}%` }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {!project && !trash && (
          <nav className="mb-5 flex gap-1 text-sm">
            {[
              { label: "In progress", to: "/review", on: !done },
              { label: "Finished", to: "/review?done=1", on: done, count: doneCount },
            ].map((t) => (
              <Link
                key={t.to}
                to={t.to}
                className={cn(
                  "rounded-md px-3 py-1.5",
                  t.on ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200",
                )}
              >
                {t.label}
                {!!t.count && <span className="ml-1.5 tabular-nums text-zinc-500">{t.count}</span>}
              </Link>
            ))}
          </nav>
        )}
        {trash ? (
          <TrashView onRestored={() => void load()} />
        ) : shown === null || (projectsList.data === null && !projectsList.error) ? (
          <GridFrame />
        ) : done && shown.length === 0 && shownProjects.length === 0 ? (
          <p className="mt-16 text-center text-sm text-zinc-500">
            Nothing finished yet. A video lands here once it's marked finished.
          </p>
        ) : shown.length === 0 && uploads.length === 0 && (project || shownProjects.length === 0) ? (
          <button
            onClick={() => setAdding({})}
            className="mx-auto mt-16 flex w-full max-w-lg flex-col items-center gap-3 rounded-2xl border border-dashed border-zinc-800 px-6 py-16 text-center hover:border-violet-500/60"
          >
            <Film className="h-10 w-10 text-zinc-600" />
            <p className="text-base font-medium text-zinc-200">
              {project ? `Drop videos into ${project.name}` : "Drop a video here"}
            </p>
            <p className="text-sm text-zinc-500">
              Any format: ProRes, HEVC and the rest get a web copy automatically. Then share one link and reviewers
              comment on the exact frame, no account needed.
            </p>
            <p className="text-xs text-zinc-600">
              Add its timeline file too (OTIO, XML, FCPXML or EDL from Resolve, Premiere or Final Cut) and its
              tracks show under the player.
            </p>
          </button>
        ) : (
          <FolderGrid ref={grid}>
            {shownProjects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                assets={assets!.filter((a) => folderOf(a) === p.id)}
                dragId={dragId}
                dragCount={dragId ? carried(dragId).length : 0}
                act={act}
                onMove={(ids) => moveMany(ids, p.id)}
                onDropFiles={(files) => dropped(files, { projectId: p.id })}
                reveal={reveal}
              />
            ))}
            {shown.map((a) => (
              <AssetCard
                key={a.id}
                asset={a}
                projects={projects}
                dragId={dragId}
                dragCount={dragId ? carried(dragId).length : 0}
                dragged={!!dragId && carried(dragId).includes(a.id)}
                setDragId={setDragId}
                picked={picked.has(a.id)}
                onPick={(range) => pick(a.id, range)}
                carried={() => carried(a.id)}
                onMove={(projectId) => moveMany(carried(a.id), projectId)}
                act={act}
                onDropVersion={(files) => dropped(files, { assetId: a.id })}
                onCaption={() => caption(a)}
                onEditStack={() => setStackOf(a.id)}
                reveal={reveal}
              />
            ))}
          </FolderGrid>
        )}
      </main>

      {picked.size > 0 && !trash && (
        <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div className="flex items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-950/95 p-1.5 pl-3.5 text-sm shadow-2xl">
            <span className="tabular-nums text-zinc-300">
              {picked.size} {picked.size === 1 ? "video" : "videos"} selected
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="ml-2 bg-violet-600 text-white hover:bg-violet-500">
                  <Folder /> Move to
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" side="top" className="max-h-80 w-56 overflow-y-auto">
                {project && <DropdownMenuItem onClick={() => moveMany([...picked], null)}>Top level</DropdownMenuItem>}
                {projects
                  .filter((p) => p.id !== project?.id)
                  .map((p) => (
                    <DropdownMenuItem key={p.id} onClick={() => moveMany([...picked], p.id)}>
                      <Folder /> {p.name}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              onClick={clearPicks}
              title="Clear selection (Esc)"
              aria-label="Clear selection"
              className="rounded-md p-2 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center border-4 border-dashed border-violet-500/70 bg-violet-950/30">
          <p className="rounded-xl bg-zinc-950/90 px-5 py-3 text-base font-medium">
            Drop to upload{project ? ` to ${project.name}` : ""} · drop on a card for a new version
          </p>
        </div>
      )}
      {adding && (
        <ReviewUploadDialog
          title={adding.newProject ? "New project" : `Upload to ${project?.name ?? "Review"}`}
          files={adding.files}
          askName={adding.newProject}
          onClose={() => setAdding(null)}
          onStart={start}
        />
      )}
      {stackOf && <StackDialog asset={assets?.find((a) => a.id === stackOf)} act={act} onClose={() => setStackOf(null)} />}
    </div>
  );
}

/** A project (Review's folder): open it, drop videos (from here or the desktop) into it. */
function ProjectCard({
  project: p,
  assets,
  dragId,
  dragCount,
  act,
  onMove,
  onDropFiles,
  reveal,
}: {
  project: ReviewProject;
  reveal: Set<string>;
  assets: ReviewAsset[];
  dragId: string | null;
  /** how many videos the card being dragged carries */
  dragCount: number;
  act: Act;
  onMove: (ids: string[]) => void;
  onDropFiles: (files: File[]) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const covers = assets.filter((a) => a.versions.at(-1)?.status === "ready").slice(0, 4);
  const finished = assets.filter(isFinished).length;
  const allDone = assets.length > 0 && finished === assets.length;
  return (
    <>
      <FolderCard
        name={p.name}
        to={`/review?p=${p.id}`}
        covers={covers.map((a) => ({ key: a.id, src: thumbUrl(a), hidden: !reveal.has(thumbUrl(a)) }))}
        meta={
          <>
            {assets.length} {assets.length === 1 ? "video" : "videos"}
            {finished > 0 && !allDone && ` · ${finished} finished`}
          </>
        }
        drop={{
          type: DRAG,
          onItems: onMove,
          onFiles: (files) => onDropFiles(media(files)),
          label: !dragId ? "Upload into this project" : dragCount > 1 ? `Move ${dragCount} videos into this project` : "Move into this project",
        }}
        onRename={() => void askRename("Rename project", p.name).then((name) => name && act(patchReviewProject(p.id, { name })))}
        menu={
          assets.length > 0 && (
            <ContextMenuItem onClick={() => act(...markFinished(assets, !allDone))}>
              {allDone ? <><Undo2 /> Move to In progress</> : <><Check /> Mark finished</>}
            </ContextMenuItem>
          )
        }
        onDelete={() => setDeleting(true)}
        deleteLabel="Delete project"
      />
      {deleting && (
        <DeleteProjectDialog
          project={p}
          assets={assets}
          onClose={() => setDeleting(false)}
          onDelete={() => act(deleteReviewProject(p.id), (l) => l.filter((x) => x.projectId !== p.id))}
        />
      )}
    </>
  );
}

/** Deleting a project takes its videos to the trash too (api/review.ts):
 *  say which, and with more than one, have "delete" typed first. */
function DeleteProjectDialog({
  project: p,
  assets,
  onClose,
  onDelete,
}: {
  project: ReviewProject;
  assets: ReviewAsset[];
  onClose: () => void;
  onDelete: () => void;
}) {
  const [typed, setTyped] = useState("");
  const many = assets.length > 1;
  const ok = !many || typed.trim().toLowerCase() === "delete";
  const go = () => {
    if (!ok) return;
    onDelete();
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-200 sm:max-w-md">
        <DialogTitle>Delete “{p.name}”?</DialogTitle>
        <DialogDescription className="text-zinc-400">
          {assets.length === 0
            ? "The project is empty."
            : `${many ? `Its ${assets.length} videos go` : "Its video goes"} to the Trash with it, comments and share links included. You can restore ${many ? "them" : "it"} from the Trash until it empties.`}
        </DialogDescription>
        {assets.length > 0 && (
          <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto">
            {assets.map((a) => (
              <li key={a.id} className="flex items-center gap-2.5 rounded-md bg-zinc-900/60 p-1.5 text-sm">
                {a.versions.at(-1)?.status === "ready" ? (
                  <Picture src={thumbUrl(a)} alt="" className="h-9 w-16 shrink-0 rounded object-cover" />
                ) : (
                  <Film className="mx-4 h-5 w-5 shrink-0 text-zinc-600" />
                )}
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                {a.versions.length > 1 && <span className="shrink-0 text-xs text-zinc-500">{a.versions.length} versions</span>}
              </li>
            ))}
          </ul>
        )}
        {many && (
          <label className="flex flex-col gap-1.5 text-sm text-zinc-400">
            <span>
              Type <b className="text-zinc-200">delete</b> to confirm
            </span>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && go()}
              className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-200 outline-none focus:border-red-500"
            />
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} className="border-zinc-800 bg-transparent">
            Cancel
          </Button>
          <Button disabled={!ok} onClick={go} className="bg-red-600 text-white hover:bg-red-500">
            <Trash2 /> {assets.length === 0 ? "Delete project" : `Delete project and ${many ? `${assets.length} videos` : "its video"}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A video: drag it onto another to stack it, drop files on it for a new
 *  version, Shift/⌘-click to pick it with others, right-click for everything else. */
function AssetCard({
  asset: a,
  projects,
  dragId,
  dragCount,
  dragged,
  setDragId,
  picked,
  onPick,
  carried,
  onMove,
  act,
  onDropVersion,
  onCaption,
  onEditStack,
  reveal,
}: {
  asset: ReviewAsset;
  reveal: Set<string>;
  projects: ReviewProject[];
  dragId: string | null;
  /** how many videos the card being dragged carries */
  dragCount: number;
  /** it's being dragged, alone or with the other picked videos */
  dragged: boolean;
  setDragId: (id: string | null) => void;
  picked: boolean;
  onPick: (range: boolean) => void;
  /** the videos a drag or "Move to" from this card takes: the picked ones when it's one of them */
  carried: () => string[];
  onMove: (projectId: string | null) => void;
  act: Act;
  onDropVersion: (files: File[]) => void;
  onCaption?: () => void;
  onEditStack: () => void;
}) {
  const v = a.versions.at(-1);
  const [over, setOver] = useState(false);
  const to = `/review/${a.id}`;
  const setStatus = (s: Approval) => {
    act(reviewApi(`/api/review/assets/${a.id}`).approve(s), (l) =>
      l.map((x) => (x.id === a.id ? { ...x, approval: { status: s } } : x)),
    );
  };
  const moveTo = projects.filter((p) => p.id !== a.projectId);
  const many = carried().length;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          draggable
          // Shift / ⌘ / Ctrl-click picks instead of opening
          onClickCapture={(e) => {
            if (!e.shiftKey && !e.metaKey && !e.ctrlKey) return;
            e.preventDefault();
            e.stopPropagation();
            onPick(e.shiftKey);
          }}
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG, carried().join(","));
            e.dataTransfer.effectAllowed = "move";
            // dim it after the browser has taken the drag picture, not in it
            requestAnimationFrame(() => setDragId(a.id));
          }}
          onDragEnd={() => setDragId(null)}
          onDragOver={(e) => {
            // a video stacks on one other; several go into a project, never onto a video
            if (dragged || (dragId && dragCount > 1)) return;
            e.preventDefault();
            e.stopPropagation();
            setOver(true);
          }}
          onDragLeave={(e) => leftFor(e) && setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(false);
            const from = e.dataTransfer.getData(DRAG);
            if (from) {
              if (from !== a.id && !from.includes(",")) act(stackReviewAssets(a.id, from), (l) => l.filter((x) => x.id !== from));
            } else {
              onDropVersion(media(e.dataTransfer.files));
            }
          }}
          className={cn(
            "group relative overflow-hidden rounded-xl border bg-zinc-900/50 transition-colors hover:border-violet-500/60",
            over || picked ? "border-violet-500 ring-2 ring-violet-500/40" : "border-zinc-800",
            dragged && "opacity-40",
          )}
        >
          {picked && (
            <span className="pointer-events-none absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-violet-600 text-white shadow">
              <Check className="h-3.5 w-3.5" />
            </span>
          )}
          <Link to={to} draggable={false} className="relative block aspect-video bg-black">
            {v?.status === "ready" && (
              <Picture src={thumbUrl(a)} alt="" className="h-full w-full object-contain"
                style={reveal.has(thumbUrl(a)) ? undefined : { opacity: 0 }} />
            )}
            {v?.status === "processing" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-zinc-400">
                <Loader2 className="h-5 w-5 animate-spin text-violet-400" />
                Preparing · {Math.round(v.progress * 100)}%
              </div>
            )}
            {v?.status === "error" && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 px-4 text-center text-xs text-red-400">
                <TriangleAlert className="h-4 w-4 shrink-0" /> {v.error}
              </div>
            )}
            {over && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-violet-950/70 text-sm font-medium">
                {dragId ? "Stack on top" : "Add"} as version {a.versions.length + 1}
              </div>
            )}
            <div className="absolute bottom-2 left-2 flex gap-1.5">
              {a.versions.length > 1 && (
                <span className="flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium">
                  <Layers className="h-3 w-3" /> V{v?.n}
                </span>
              )}
              {isFinished(a) && (
                  <span className="flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold" title="Marked finished">
                    <Check className="h-3 w-3" /> Finished
                  </span>
              )}
              {v?.captioned && (
                <span className="rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold" title="Captions burned in">
                  CC
                </span>
              )}
              {a.share?.enabled && (
                <span className="flex items-center rounded bg-black/70 px-1.5 py-0.5" title="Share link is on">
                  <Link2 className="h-3 w-3" />
                </span>
              )}
            </div>
            {v && v.duration > 0 && (
              <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] tabular-nums">
                {timecode(v.duration, 0)}
              </span>
            )}
          </Link>
          <div className="flex items-start gap-3 px-3.5 py-3">
            <div className="min-w-0 flex-1">
              <Link to={to} draggable={false} className="block truncate text-sm font-medium text-zinc-100">
                {a.name}
              </Link>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className="-mx-1 flex items-center gap-1.5 rounded px-1 hover:bg-zinc-800 hover:text-zinc-200"
                    title="Change status"
                  >
                    <span className={cn("h-2 w-2 rounded-full", APPROVAL[a.approval.status].dot)} />
                    {APPROVAL[a.approval.status].label}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {STATUSES.map((s) => (
                      <DropdownMenuItem key={s} onClick={() => setStatus(s)} className="gap-2">
                        <span className={cn("h-2 w-2 rounded-full", APPROVAL[s].dot)} /> {APPROVAL[s].label}
                        {s === a.approval.status && <Check className="ml-auto h-3.5 w-3.5" />}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <span className="text-zinc-700">·</span>
                {timeAgo(a.updatedAt ?? a.createdAt)}
              </div>
            </div>
            {!!a.comments && (
              <span
                className={cn(
                  "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs tabular-nums",
                  a.newComments ? "bg-violet-600 text-white" : "text-zinc-500",
                )}
                title={a.newComments ? `${a.newComments} new` : undefined}
              >
                <MessageSquare className="h-3.5 w-3.5" /> {a.comments}
              </span>
            )}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem asChild>
          <Link to={to}>Open</Link>
        </ContextMenuItem>
        {v?.status === "ready" && onCaption && (
          <ContextMenuItem onClick={onCaption}>
            <Captions /> Caption Studio
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onClick={() => void askRename("Rename video", a.name).then((name) => name && act(patchReviewAsset(a.id, { name })))}
        >
          Rename…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>Status</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {STATUSES.map((s) => (
              <ContextMenuItem key={s} onClick={() => setStatus(s)}>
                <span className={cn("h-2 w-2 rounded-full", APPROVAL[s].dot)} /> {APPROVAL[s].label}
                {s === a.approval.status && <Check className="ml-auto h-3.5 w-3.5" />}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onClick={() => act(...markFinished([a], !isFinished(a)))}>
          {isFinished(a) ? <><Undo2 /> Move to In progress</> : <><Check /> Mark finished</>}
        </ContextMenuItem>
        {(a.projectId || moveTo.length > 0) && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>{many > 1 ? `Move ${many} videos to` : "Move to"}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {a.projectId && <ContextMenuItem onClick={() => onMove(null)}>Top level</ContextMenuItem>}
              {moveTo.map((p) => (
                <ContextMenuItem key={p.id} onClick={() => onMove(p.id)}>
                  <Folder /> {p.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {a.versions.length > 1 && (
          <ContextMenuItem onClick={onEditStack}>
            <Layers /> Edit stack…
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {v?.status === "ready" && (
          <ContextMenuItem asChild>
            <a href={`/api/review/assets/${a.id}/v/${v.n}/download?c=${v.createdAt}`} download>
              <Download /> Download V{v.n}
            </a>
          </ContextMenuItem>
        )}
        <ContextMenuItem
          className="text-red-400"
          onClick={() => {
            void confirmDialog({ title: `Move “${a.name}” to the trash?`, body: "You can restore it for 30 days.", ok: "Move to trash", danger: true, deleting: true })
              .then((yes) => {
                if (yes) act(deleteReviewAsset(a.id), (l) => l.filter((x) => x.id !== a.id));
              });
          }}
        >
          <Trash2 /> Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A stack's versions, top (the main one) first: drag to reorder, or take
 *  one out as its own video. Closes itself once one version is left. */
function StackDialog({ asset: a, act, onClose }: { asset?: ReviewAsset; act: Act; onClose: () => void }) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  if (!a || a.versions.length < 2) return null;
  const rows = [...a.versions].reverse();
  const busy = a.versions.some((x) => x.status === "processing");
  // n stays as it is until the reload: a new n would fetch a thumb the server hasn't moved yet
  const mine = (versions: ReviewAsset["versions"]) => (l: ReviewAsset[]) =>
    l.map((x) => (x.id === a.id ? { ...x, versions } : x));
  const moveTo = (from: number, to: number) => {
    if (from === to) return;
    const order = [...rows];
    order.splice(to, 0, order.splice(from, 1)[0]);
    order.reverse();
    act(reorderReviewStack(a.id, order.map((x) => x.n)), mine(order));
  };
  const end = () => {
    setDragging(null);
    setOver(null);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="max-h-[90dvh] overflow-y-auto border-zinc-800 bg-zinc-950 text-zinc-200 sm:max-w-lg"
      >
        <DialogTitle>Edit stack</DialogTitle>
        <DialogDescription className="text-zinc-500">
          {busy ? "Wait until every version is ready." : "Drag to reorder. The top one is the main version and names the video."}
        </DialogDescription>
        <div className="flex flex-col gap-1">
          {rows.map((x, i) => (
            <div
              key={`${x.n}:${x.createdAt}`}
              draggable={!busy}
              onDragStart={(e) => {
                e.stopPropagation();
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(i));
                setDragging(i);
              }}
              onDragOver={(e) => {
                if (dragging === null) return;
                e.preventDefault();
                e.stopPropagation();
                setOver(i);
              }}
              onDrop={(e) => {
                if (dragging === null) return;
                e.preventDefault();
                e.stopPropagation();
                moveTo(dragging, i);
                end();
              }}
              onDragEnd={end}
              className={cn(
                "flex items-center gap-2.5 rounded-md border px-2 py-1.5",
                i === 0 ? "border-violet-500/60 bg-zinc-900" : "border-transparent hover:bg-zinc-900/60",
                over === i && dragging !== i && "border-dashed border-violet-400",
                dragging === i && "opacity-40",
              )}
            >
              <GripVertical className={cn("h-4 w-4 shrink-0 text-zinc-600", !busy && "cursor-grab")} />
              <span className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-black">
                {x.status === "ready" ? (
                  <Picture src={versionThumbUrl(a.id, x)} alt="" className="h-full w-full object-contain" />
                ) : x.status === "processing" ? (
                  <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
                ) : (
                  <TriangleAlert className="h-4 w-4 text-red-400" />
                )}
              </span>
              <span className="w-7 shrink-0 text-sm font-medium">V{a.versions.length - i}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-zinc-200" title={x.name}>
                  {x.name}
                </span>
                <span className="block text-[11px] text-zinc-500">
                  {i === 0 ? "Main · " : ""}
                  {x.duration > 0 ? timecode(x.duration, 0) : ""}
                  {x.captioned ? " · CC" : ""}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                className="h-7 shrink-0 text-xs text-zinc-400 hover:text-zinc-100"
                onClick={() => act(unstackReviewAsset(a.id, x.n), mine(a.versions.filter((y) => y !== x)))}
              >
                Unstack
              </Button>
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            className="border-zinc-800 bg-transparent text-xs"
            onClick={() => {
              act(unstackReviewAsset(a.id));
              onClose();
            }}
          >
            <Layers /> Unstack all {a.versions.length}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Deleted videos, kept for 30 days: restore one, or delete it for good. */
function TrashView({ onRestored }: { onRestored: () => void }) {
  // the saved trash shows at once (lib/local-cache), refreshed underneath
  const trash = useCachedLoad("/api/review/trash", listReviewTrash);
  const items = trash.data;
  const [error, setError] = useState("");
  const load = useCallback(
    () => trash.refresh().catch((e: Error) => setError(e.message)),
    [trash.refresh],
  );
  // the hook fetches on mount; `load` is for the actions below
  const run = (change: Promise<unknown>) =>
    change
      .then(() => {
        void load();
        onRestored();
      })
      .catch((e: Error) => setError(e.message));

  if (!items)
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50">
            <div className="aspect-video bg-black" />
            <div className="h-16" />
          </div>
        ))}
      </div>
    );
  return (
    <>
      {error && <p className="mb-4 text-sm text-red-400">{error}</p>}
      <p className="mb-4 text-sm text-zinc-500">
        {items.length ? "Deleted videos stay here for 30 days, then they're gone for good." : "The trash is empty."}
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((a) => (
          <div key={a.id} className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50">
            <div className="aspect-video bg-black">
              {/* dimmed on the wrapper: the picture's own fade-in owns its opacity */}
              <div className="h-full w-full opacity-60">
                <Picture src={trashThumbUrl(a.id)} alt="" className="h-full w-full object-contain" />
              </div>
            </div>
            <div className="flex items-center gap-2 px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-100">{a.name}</p>
                <p className="mt-1 text-xs text-zinc-500">Deleted {timeAgo(a.deletedAt ?? 0)}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 border-zinc-800 bg-transparent text-xs"
                onClick={() => void run(restoreReviewAsset(a.id))}
              >
                <Undo2 /> Restore
              </Button>
              <button
                title="Delete forever"
                aria-label="Delete forever"
                onClick={() => {
                  void confirmDialog({ title: `Delete “${a.name}” forever?`, body: "This can't be undone.", ok: "Delete forever", danger: true })
                    .then((yes) => {
                      if (yes) void run(deleteForever(a.id));
                    });
                }}
                className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
