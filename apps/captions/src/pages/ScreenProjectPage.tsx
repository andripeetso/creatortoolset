import { useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { ChevronDown, FolderOpen, Send } from "lucide-react";
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
import { canRecordScreen, tellRecorder, useLocalRecordings, type ShareDest } from "@/lib/mac-record";
import { uploadReviewFile } from "@/lib/review";
import { localSource } from "@/lib/screen-source";

const SHARES: { dest: ShareDest; label: string }[] = [
  { dest: "review", label: "Send to Review" },
  { dest: "notes", label: "Send to Video Notes" },
  { dest: "guide", label: "Make a guide" },
];

/**
 * One recording on this Mac (`/record/<id>`, app only): its editor on the local file. Export saves the edited video
 * or uploads it to Review; the menu beside it sends the recording as it was made, or shows its file.
 */
export default function ScreenProjectPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const list = useLocalRecordings();
  const rec = list?.find((r) => r.id === id);
  const source = useMemo(() => (rec ? localSource(rec) : null), [rec]);
  // the editor's Export sits in this page's bar
  const [slot, setSlot] = useState<HTMLElement | null>(null);

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
          {list === null ? "Opening…" : "This recording isn't on this Mac any more."}
        </div>
      ) : (
        <ScreenRecordingEditor
          embedded
          barSlot={slot}
          source={source}
          meta={{ name: rec.name, duration: rec.durationMs / 1000, width: rec.width, height: rec.height }}
          actions={actions}
          extra={
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
          }
        />
      )}
    </div>
  );
}
