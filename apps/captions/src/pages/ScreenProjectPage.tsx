import { useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { FolderOpen, Upload } from "lucide-react";
import { AppBar } from "@/components/AppBar";
import { Button } from "@/components/ui/button";
import { ScreenRecordingEditor, type EditorAction } from "@/components/ScreenRecordingEditor";
import { canRecordScreen, tellRecorder, useLocalRecordings, type ShareDest } from "@/lib/mac-record";
import { uploadReviewFile } from "@/lib/review";
import { localSource } from "@/lib/screen-source";

const SHARES: { dest: ShareDest; label: string }[] = [
  { dest: "review", label: "Send to Review" },
  { dest: "notes", label: "Send to Video Notes" },
  { dest: "guide", label: "Make a guide" },
];

/**
 * One recording on this Mac (`/record/<id>`, app only): the Zoom & pointer editor on the local file, Save video and
 * Upload to Review for the edited video, and the raw recording sent as it is.
 */
export default function ScreenProjectPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const list = useLocalRecordings();
  const rec = list?.find((r) => r.id === id);
  const source = useMemo(() => (rec ? localSource(rec) : null), [rec]);

  if (!canRecordScreen()) return <Navigate to="/record" replace />;

  const actions: EditorAction[] = [
    {
      label: "Save video…",
      title: "Renders the video with this look and saves it",
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
      title: "Renders the video with this look and uploads it to Review as a new video",
      run: async ({ blob, name }, progress) => {
        const asset = await uploadReviewFile(new File([blob], `${name}.mp4`, { type: "video/mp4" }), (pct) => progress("Uploading", pct));
        navigate(`/review/${asset.id}`);
      },
    },
  ];

  return (
    <div className="flex h-dvh flex-col bg-zinc-950 text-zinc-100">
      <AppBar tool="Screen Recorder" trail={rec?.name} />
      {!rec || !source ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
          {list === null ? "Opening…" : "This recording isn't on this Mac any more."}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2 text-sm">
            <span className="text-zinc-400">The recording as it is:</span>
            {SHARES.map((s) => (
              <Button key={s.dest} size="sm" variant="outline" onClick={() => tellRecorder(`share:${rec.id}:${s.dest}`)}>
                <Upload /> {s.label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => tellRecorder(`reveal:${rec.id}`)}>
              <FolderOpen /> Show in Finder
            </Button>
          </div>
          <ScreenRecordingEditor
            embedded
            source={source}
            meta={{ name: rec.name, duration: rec.durationMs / 1000, width: rec.width, height: rec.height }}
            actions={actions}
          />
        </>
      )}
    </div>
  );
}
