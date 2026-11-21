import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { ChevronDown, Clapperboard, FolderOpen, Layers, Loader2, Send, Trash2 } from "lucide-react";
import { AppBar } from "@/components/AppBar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScreenRecordingEditor, type EditorAction } from "@/components/ScreenRecordingEditor";
import { askSavePlace, canAskSavePlace, canRecordScreen, savedOnMac, tellRecorder, throwAwayRecording, useLocalRecordings, type ShareDest } from "@/lib/mac-record";
import { uploadReviewFile } from "@/lib/review";
import { canUse, useMe } from "@/lib/auth";
import { alertDialog } from "@/lib/dialogs";
import { footageTarget } from "@/lib/editor";
import { changeFolderItems, getAsset, macIndexOnly, uploadFile } from "@/lib/library";
import type { Picked } from "@/pages/EditorPage";
import { openLocalRecording } from "@/lib/screen-source";
import { useMacRecorder } from "@/components/settings/ThisMacSection";

const SHARES: { dest: ShareDest; label: string }[] = [
  { dest: "review", label: "Send to Review" },
  { dest: "notes", label: "Send to Video Notes" },
  { dest: "guide", label: "Send to Guide Builder" },
];

/**
 * One recording on this Mac (`/record/<id>`, app only): its editor on the local file. Export saves the edited video
 * or uploads it to Review (with no background: saves a see-through video, which the app makes from the download); the menu beside it sends the recording as it was made, or shows its file; the bin throws
 * the recording away (the app asks once, then it is in the Trash) and goes back to the recordings.
 */
export default function ScreenProjectPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const list = useLocalRecordings();
  const rec = list?.find((r) => r.id === id);
  // The recording made ready: at once in an app whose local files take requests at once; in an older app its video is
  // read whole first (lib/local-files.ts). Opened once per recording: the list is pushed again on every change.
  type Opened = Awaited<ReturnType<typeof openLocalRecording>>;
  const [source, setSource] = useState<Opened | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const recId = rec?.id;
  useEffect(() => {
    if (!rec) return;
    let gone = false;
    let opened: Opened | null = null;
    openLocalRecording(rec).then(
      (s) => {
        if (gone) return s.close();
        opened = s;
        setSource(s);
      },
      () => !gone && setUnreadable(true),
    );
    return () => {
      gone = true;
      opened?.close();
      setSource(null);
      setUnreadable(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per recording: every push of the list brings a new object for the same one
  }, [recId]);

  // the editor's Export sits in this page's bar
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // Save the streams… only where the Mac app does it (0.15.38 and later)
  const streams = useMacRecorder() === true;
  const me = useMe();
  // Send to AI Editor: how far the upload is (0–100), null when none runs
  const [toEditor, setToEditor] = useState<number | null>(null);

  // thrown away from here: once the app's list no longer has it, back to the recordings
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (leaving && list && !rec) navigate("/record", { replace: true });
  }, [leaving, list, rec, navigate]);

  if (!canRecordScreen()) return <Navigate to="/record" replace />;

  const download = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  /**
   * Files the videos in the library, each as its own clip in the AI Editor's footage folder, then New edit opens with
   * them picked. `onPct`: how far the upload is (0–100). A part's `path` (where it is on this Mac) lets a library that
   * reads files in place add it; without one such a library refuses it.
   */
  const toEditorWith = async (parts: { blob: Blob; name: string; path?: string }[], onPct: (pct: number) => void, signal?: AbortSignal) => {
    const total = parts.reduce((n, p) => n + p.blob.size, 0) || 1;
    const target = await footageTarget();
    const pick: Picked[] = [];
    let done = 0;
    for (const p of parts) {
      const file = new File([p.blob], p.name, { type: "video/mp4" });
      const onMac = await macIndexOnly(target.libraryId);
      const up = await uploadFile(target.libraryId, file, (sent) => onPct(Math.round(((done + sent) / total) * 100)), target.collectionId, onMac ? p.path : undefined, { onMac, signal });   // a path only where the library reads files in place: elsewhere it is a copy (a recording thrown away must not take the clip with it)
      const assetId = up.assetId ?? up.duplicateOf;
      if (!assetId) throw new Error(`${p.name} was not added to the Media Library`);
      await changeFolderItems(target.libraryId, target.collectionId, [assetId], true);
      const asset = await getAsset(target.libraryId, assetId);
      pick.push({ versionId: asset.versionId, title: asset.title });
      done += p.blob.size;
    }
    signal?.throwIfAborted();   // Stop while it was filed: the person stays here
    navigate(`/editor?new=1&name=${encodeURIComponent(rec?.name ?? "")}`, { state: { pick } });
  };
  /** The menu's Send to Editor: the recording as it was made, the screen (with the voice) and the camera as two clips. */
  const sendToEditor = async () => {
    if (!rec || !source || toEditor !== null) return;
    setToEditor(0);
    try {
      const read = (blob: Blob | undefined, url: string) => (blob ? Promise.resolve(blob) : fetch(url).then((r) => r.blob()));
      const parts = [{ blob: await read(source.file, source.url), name: `${rec.name} (screen).mp4`, path: rec.screenPath }];
      if (source.cameraUrl) parts.push({ blob: await read(source.cameraFile, source.cameraUrl), name: `${rec.name} (camera).mp4`, path: rec.cameraPath ?? undefined });
      await toEditorWith(parts, setToEditor);
    } catch (e) {
      await alertDialog({ title: "Could not send to the Editor", body: e instanceof Error ? e.message : String(e) });
    } finally {
      setToEditor(null);
    }
  };

  /**
   * The Export dialog's Send to Editor: the video made with the chosen look and settings. A library that reads files in
   * place (uploads off) gets it from a file: where it is saved is asked first, and it is added from there.
   */
  const editorWay = (): EditorAction => {
    let saveFirst = false;
    return {
      label: "Send to Editor",
      title: "Makes the video with this look and starts a new AI Editor project with it",
      before: async (name) => {
        try {
          saveFirst = await macIndexOnly((await footageTarget()).libraryId);
        } catch (e) {
          await alertDialog({ title: "Could not send to the Editor", body: e instanceof Error ? e.message : String(e) });
          return false;
        }
        if (!saveFirst) return true;
        if (canAskSavePlace()) return askSavePlace(`${name}.mp4`, false);
        await alertDialog({ title: "Could not send to the Editor", body: "This library adds files where they are on this Mac. Update the app to send a video made here, or Export it and add the file in the Media Library." });
        return false;
      },
      run: async ({ blob, name }, progress, signal) => {
        const fileName = `${name}.mp4`;
        let path: string | undefined;
        if (saveFirst) {
          const saved = savedOnMac(fileName, signal);   // listening before the download starts
          progress("Saving", 0);
          download(blob, fileName);
          path = await saved;
        }
        await toEditorWith([{ blob, name: fileName, path }], (pct) => progress("Sending to the Editor", pct), signal);
      },
    };
  };

  const actions: EditorAction[] = [
    {
      label: "Export",
      primary: true,
      title: "Asks where it goes, then makes the video with this look and saves it there",
      before: (name) => askSavePlace(`${name}.mp4`),
      run: async ({ blob, name }) => download(blob, `${name}.mp4`),
    },
    ...(canUse(me, "editor") ? [editorWay()] : []),
    {
      label: "Upload to Review",
      title: "Makes the video with this look and uploads it to Review as a new video",
      run: async ({ blob, name }, progress, signal) => {
        const asset = await uploadReviewFile(new File([blob], `${name}.mp4`, { type: "video/mp4" }), (pct) => progress("Uploading", pct));
        signal.throwIfAborted();   // shortcut: Stop does not stop this upload itself (uploadReviewFile takes no signal), only the move to Review
        navigate(`/review/${asset.id}`);
      },
    },
  ];

  return (
    <div data-fills-window className="flex h-dvh flex-col bg-zinc-950 text-zinc-100">
      <AppBar tool="Screen Recorder" to="/record" trail={rec?.name}>
        <div ref={setSlot} className="flex items-center gap-2" />
      </AppBar>
      {!rec || !source ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
          {unreadable ? "Could not read this recording's video" : list === null || rec ? "Opening…" : "Not found on this Mac"}
        </div>
      ) : (
        <ScreenRecordingEditor
          // one editor per recording: its look, its undo steps and its place in time never pass to the next one
          key={rec.id}
          embedded
          barSlot={slot}
          source={source}
          meta={{ name: rec.name, duration: rec.durationMs / 1000, width: rec.width, height: rec.height }}
          actions={actions}
          download={download}
          extra={
            <>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Throw this recording away"
              title="Throw this recording away (to the Trash)"
              className="hover:bg-red-950/60 hover:text-red-300"
              onClick={async () => {
                if (await throwAwayRecording(rec)) setLeaving(true);
              }}
            >
              <Trash2 />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" disabled={toEditor !== null}>
                  {toEditor !== null ? (
                    <>
                      <Loader2 className="animate-spin" /> Sending to the Editor {toEditor}%
                    </>
                  ) : (
                    <>
                      <Send /> Send <ChevronDown className="opacity-60" />
                    </>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="text-xs font-normal text-zinc-400">Original recording</DropdownMenuLabel>
                {SHARES.map((s) => (
                  <DropdownMenuItem key={s.dest} onSelect={() => tellRecorder(`share:${rec.id}:${s.dest}`)}>
                    {s.label}
                  </DropdownMenuItem>
                ))}
                {canUse(me, "editor") && (
                  <DropdownMenuItem onSelect={() => void sendToEditor()}>
                    <Clapperboard /> Send to Editor
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                {streams && (
                  <DropdownMenuItem onSelect={() => tellRecorder(`streams:${rec.id}`)}>
                    <Layers /> Save the streams…
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => tellRecorder(`reveal:${rec.id}`)}>
                  <FolderOpen /> Show in Finder
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            </>
          }
        />
      )}
    </div>
  );
}
