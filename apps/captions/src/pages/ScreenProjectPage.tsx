import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { ChevronDown, FolderOpen, Send, Trash2 } from "lucide-react";
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
import { canRecordScreen, tellRecorder, throwAwayRecording, useLocalRecordings, type ShareDest } from "@/lib/mac-record";
import { uploadReviewFile } from "@/lib/review";
import { openLocalRecording } from "@/lib/screen-source";

const SHARES: { dest: ShareDest; label: string }[] = [
  { dest: "review", label: "Send to Review" },
  { dest: "notes", label: "Send to Video Notes" },
  { dest: "guide", label: "Make a guide" },
];

/**
 * One recording on this Mac (`/record/<id>`, app only): its editor on the local file. Export saves the edited video
 * or uploads it to Review; the menu beside it sends the recording as it was made, or shows its file; the bin throws
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

  // thrown away from here: once the app's list no longer has it, back to the recordings
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (leaving && list && !rec) navigate("/record", { replace: true });
  }, [leaving, list, rec, navigate]);

  if (!canRecordScreen()) return <Navigate to="/record" replace />;

  const actions: EditorAction[] = [
    {
      label: "Save video…",
      title: "Makes the video with this look and saves it",
      run: async ({ blob, name }) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${name}.mp4`;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      },
    },
    {
      label: "Upload to Review",
      primary: true,
      title: "Makes the video with this look and uploads it to Review as a new video",
      run: async ({ blob, name }, progress) => {
        const asset = await uploadReviewFile(new File([blob], `${name}.mp4`, { type: "video/mp4" }), (pct) => progress("Uploading", pct));
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
          {unreadable ? "This recording's video can't be read." : list === null || rec ? "Opening…" : "This recording isn't on this Mac any more."}
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
                <Button size="sm" variant="outline">
                  <Send /> Send <ChevronDown className="opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="text-xs font-normal text-zinc-400">The recording as it was made</DropdownMenuLabel>
                {SHARES.map((s) => (
                  <DropdownMenuItem key={s.dest} onSelect={() => tellRecorder(`share:${rec.id}:${s.dest}`)}>
                    {s.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
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
